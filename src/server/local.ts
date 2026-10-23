import { Observable, Subject } from 'rxjs';
import { AgentRunner } from '@copilotkit/runtime/v2';
import { EventType } from '@ag-ui/core';
import type { BaseEvent, Message } from '@ag-ui/core';
import type {
  AgentRunnerRunRequest,
  AgentRunnerConnectRequest,
  AgentRunnerStopRequest,
  LocalThreadEndpointRunner,
} from '@copilotkit/runtime/v2';
import type { WorkspaceStore } from './workspace.js';
import type { LocalSnapshot } from './threads.js';

type ActiveRun = {
  id: string;
  events: Subject<BaseEvent>;
  done: Promise<void>;
  stop: () => void;
};
export interface LocalLimits {
  maxHistoryBytes: number;
  maxEventsPerRun: number;
  contextMessages: number;
  runTimeoutMs: number;
}
const errorEvent = (): BaseEvent => ({
  type: EventType.RUN_ERROR,
  code: 'LOCAL_RUN_FAILED',
  message:
    'This local turn could not finish. Check the conversation and retry; previous tool effects are not repeated automatically.',
});

/** Keep persisted assistant history authoritative; accept new owner messages and tool results. */
export function mergeLocalMessages(
  saved: Message[],
  incoming: Message[],
): Message[] {
  let result = structuredClone(saved);
  const last = incoming.at(-1);
  const editIndex =
    last?.role === 'user'
      ? result.findIndex(
          (message) => message.id === last.id && message.role === 'user',
        )
      : -1;
  if (
    editIndex >= 0 &&
    incoming.every((message) => result.some((old) => old.id === message.id))
  ) {
    result = result.slice(0, editIndex);
    result.push(last!);
  }
  const ids = new Set(result.map((message) => message.id));
  const results = new Set(
    result.flatMap((message) =>
      message.role === 'tool' ? [message.toolCallId] : [],
    ),
  );
  const calls = new Set(
    result.flatMap((message) =>
      message.role === 'assistant'
        ? (message.toolCalls?.map((call) => call.id) ?? [])
        : [],
    ),
  );
  for (const message of incoming) {
    if (ids.has(message.id)) continue;
    if (
      message.role !== 'user' &&
      !(
        message.role === 'tool' &&
        calls.has(message.toolCallId) &&
        !results.has(message.toolCallId)
      )
    )
      continue;
    result.push(message);
    ids.add(message.id);
    if (message.role === 'tool') results.add(message.toolCallId);
  }
  return result;
}
/** Interrupted calls are receipts with unknown effects, never implicit permission to execute again. */
export function recoverInterruptedCalls(messages: Message[]): Message[] {
  const results = new Set(
    messages.flatMap((message) =>
      message.role === 'tool' ? [message.toolCallId] : [],
    ),
  );
  return messages.flatMap((message): Message[] => {
    if (message.role !== 'assistant' || !message.toolCalls?.length)
      return [message];
    const recovered: Message[] = [];
    const valid = [];
    let incomplete = false;
    for (const call of message.toolCalls) {
      try {
        JSON.parse(call.function.arguments);
      } catch {
        incomplete = true;
        continue;
      }
      valid.push(call);
      if (!results.has(call.id))
        recovered.push({
          id: `local-interrupted-${call.id}`,
          role: 'tool',
          toolCallId: call.id,
          content:
            'Previous local turn was interrupted. Tool completion is unverified. Check existing effects before retrying.',
        });
    }
    return [
      {
        ...message,
        toolCalls: valid,
        ...(incomplete
          ? {
              content: `${message.content ?? ''}\nA tool call was interrupted before complete arguments were recorded; its effects are unverified.`,
            }
          : {}),
      },
      ...recovered,
    ];
  });
}
function modelContext(messages: Message[], limit: number) {
  if (messages.length <= limit) return messages;
  const start = messages.findIndex(
    (message, index) =>
      index >= messages.length - limit && message.role === 'user',
  );
  return start >= 0 ? messages.slice(start) : messages;
}

/** A single-process SSE runner backed by durable SQLite receipts, snapshots and run fencing. */
export class LocalAgentRunner
  extends AgentRunner
  implements LocalThreadEndpointRunner
{
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  private active = new Map<string, ActiveRun>();
  constructor(
    private workspace: WorkspaceStore,
    private limits: LocalLimits,
  ) {
    super();
  }
  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const binding = this.workspace.requireThread(
      request.threadId,
      request.agent.agentId,
    );
    this.workspace.threads.ensure({
      threadId: binding.id,
      agentId: binding.dotId,
      userId: this.workspace.ownerId,
      name: binding.title,
    });
    const saved = this.workspace.threads.get(binding.id);
    const merged = mergeLocalMessages(saved.messages, request.input.messages);
    const previous = this.workspace.threads.latestRun(binding.id);
    const interrupted =
      previous &&
      (previous.status === 'failed' ||
        previous.status === 'interrupted' ||
        (previous.status === 'running' && previous.leaseUntil <= Date.now()));
    const messages = interrupted ? recoverInterruptedCalls(merged) : merged;
    const snapshot = { messages, state: saved.state };
    this.checkSize(snapshot);
    if (
      !this.workspace.threads.begin(
        binding.id,
        request.input.runId,
        request.input,
        this.limits.runTimeoutMs + 5000,
        snapshot,
      )
    )
      return this.stream(binding.id, request.input.runId);
    const events = new Subject<BaseEvent>();
    const run: ActiveRun = {
      id: request.input.runId,
      events,
      done: Promise.resolve(),
      stop: () => request.agent.abortRun(),
    };
    this.active.set(binding.id, run);
    this.workspace.threads.append(binding.id, run.id, {
      type: EventType.RUN_STARTED,
      threadId: binding.id,
      runId: run.id,
    });
    this.workspace.threads.append(binding.id, run.id, {
      type: EventType.MESSAGES_SNAPSHOT,
      messages,
    });
    this.workspace.threads.append(binding.id, run.id, {
      type: EventType.STATE_SNAPSHOT,
      snapshot: saved.state,
    });
    run.done = this.execute(request, run, snapshot);
    return this.stream(binding.id, run.id);
  }
  private checkSize(snapshot: LocalSnapshot) {
    if (
      Buffer.byteLength(JSON.stringify(snapshot)) > this.limits.maxHistoryBytes
    )
      throw new Error(
        'This conversation reached the local history size limit. Start a new conversation.',
      );
  }
  private async execute(
    request: AgentRunnerRunRequest,
    run: ActiveRun,
    initial: LocalSnapshot,
  ) {
    const { threadId } = request;
    const agent = request.agent;
    const context = modelContext(initial.messages, this.limits.contextMessages);
    const prefix = initial.messages.slice(
      0,
      initial.messages.length - context.length,
    );
    agent.threadId = threadId;
    agent.setMessages(context);
    agent.setState(initial.state);
    let terminal: BaseEvent | undefined;
    let stopped = false;
    let count = 0;
    let lastCheckpoint = 0;
    let safeSnapshot = structuredClone(initial);
    let persistenceFailed = false;
    let accepting = true;
    let resolveStop = () => {};
    const cancelled = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const snapshot = (): LocalSnapshot => ({
      messages: [...prefix, ...agent.messages],
      state: agent.state,
    });
    const stop = () => {
      stopped = true;
      agent.abortRun();
      resolveStop();
    };
    run.stop = stop;
    const timeout = setTimeout(stop, this.limits.runTimeoutMs);
    try {
      const work = agent.runAgent(
        { ...request.input },
        {
          onEvent: ({ event }) => {
            if (!accepting || event.type === EventType.RUN_STARTED) return;
            if (++count > this.limits.maxEventsPerRun) {
              stop();
              throw new Error('Local run event limit exceeded.');
            }
            if (
              event.type === EventType.RUN_FINISHED ||
              event.type === EventType.RUN_ERROR
            ) {
              terminal = event;
              return;
            }
            if (persistenceFailed) return;
            try {
              this.workspace.threads.append(threadId, run.id, event);
              run.events.next(event);
            } catch {
              persistenceFailed = true;
              stop();
            }
          },
          onMessagesChanged: () => {
            if (!accepting) return;
            if (Date.now() - lastCheckpoint < 100) return;
            try {
              const current = snapshot();
              this.checkSize(current);
              this.workspace.threads.checkpoint(threadId, run.id, current);
              safeSnapshot = structuredClone(current);
              lastCheckpoint = Date.now();
            } catch {
              persistenceFailed = true;
              stop();
            }
          },
        },
      );
      await Promise.race([work, cancelled]);
      accepting = false;
      const current = snapshot();
      this.checkSize(current);
      const success =
        !stopped &&
        !persistenceFailed &&
        terminal?.type === EventType.RUN_FINISHED;
      const finish = success ? terminal! : errorEvent();
      this.workspace.threads.finish(
        threadId,
        run.id,
        success ? 'complete' : stopped ? 'interrupted' : 'failed',
        current,
        finish,
      );
      run.events.next(finish);
    } catch {
      agent.abortRun();
      const failure = errorEvent();
      try {
        this.workspace.threads.finish(
          threadId,
          run.id,
          stopped ? 'interrupted' : 'failed',
          safeSnapshot,
          failure,
        );
      } catch {
        /* A fenced-out run must never overwrite a newer turn. */
      }
      run.events.next(failure);
    } finally {
      accepting = false;
      clearTimeout(timeout);
      if (this.active.get(threadId) === run) this.active.delete(threadId);
      run.events.complete();
    }
  }
  private stream(threadId: string, runId: string): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const running = this.active.get(threadId);
      const events = this.workspace.threads.events(threadId, runId);
      if (running?.id === runId) {
        for (const event of events) subscriber.next(event);
        return running.events.subscribe(subscriber);
      }
      const snapshot = this.workspace.threads.get(threadId);
      subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });
      subscriber.next({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: snapshot.messages,
      });
      subscriber.next({
        type: EventType.STATE_SNAPSHOT,
        snapshot: snapshot.state,
      });
      const terminal = events.findLast(
        (event) =>
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR,
      );
      subscriber.next(terminal ?? errorEvent());
      subscriber.complete();
    });
  }
  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    this.workspace.requireThread(request.threadId, request.agentId);
    const running = this.active.get(request.threadId);
    if (running) return this.stream(request.threadId, running.id);
    const previous = this.workspace.threads.latestRun(request.threadId);
    return new Observable((subscriber) => {
      if (previous) {
        const snapshot = this.workspace.threads.get(request.threadId);
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: request.threadId,
          runId: previous.runId,
        });
        subscriber.next({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: snapshot.messages,
        });
        subscriber.next({
          type: EventType.STATE_SNAPSHOT,
          snapshot: snapshot.state,
        });
        subscriber.next(
          previous.status === 'complete'
            ? {
                type: EventType.RUN_FINISHED,
                threadId: request.threadId,
                runId: previous.runId,
              }
            : errorEvent(),
        );
      }
      subscriber.complete();
    });
  }
  async isRunning({ threadId }: { threadId: string }) {
    this.workspace.requireThread(threadId);
    return this.active.has(threadId);
  }
  async stop(request: AgentRunnerStopRequest) {
    this.workspace.requireThread(request.threadId);
    const run = this.active.get(request.threadId);
    if (!run || (request.runId && request.runId !== run.id)) return false;
    run.stop();
    return true;
  }
  async close() {
    const runs = [...this.active.values()];
    for (const run of runs) run.stop();
    await Promise.all(runs.map((run) => run.done));
  }
  listThreads() {
    const bindings = new Set(
      this.workspace.conversations().map((thread) => thread.id),
    );
    return this.workspace.threads
      .list()
      .filter((row) => bindings.has(row.id))
      .map((row) => ({
        id: row.id,
        name: row.name,
        agentId: row.agentId,
        organizationId: '',
        createdById: row.ownerId,
        archived: false,
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
      }));
  }
  getThreadMessages(id: string) {
    this.workspace.requireThread(id);
    return this.workspace.threads.get(id).messages;
  }
  getThreadEvents(id: string) {
    this.workspace.requireThread(id);
    return this.workspace.threads.events(id);
  }
  getThreadState(id: string) {
    this.workspace.requireThread(id);
    return this.workspace.threads.get(id).state;
  }
  clearThreads(): void {
    throw new Error('Bulk conversation deletion is not enabled.');
  }
}
