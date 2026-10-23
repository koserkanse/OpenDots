import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbstractAgent, HttpAgent } from '@ag-ui/client';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';
import { serve } from '@hono/node-server';
import {
  CopilotRuntime,
  createCopilotHonoHandler,
} from '@copilotkit/runtime/v2';
import { EventType } from '@ag-ui/core';
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, Observable, of, toArray } from 'rxjs';
import {
  LocalAgentRunner,
  mergeLocalMessages,
  recoverInterruptedCalls,
} from '../src/server/local.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { Platform } from '../src/server/platform.js';
import {
  localRuntimeSettingsFromEnv,
  setupStatus,
} from '../src/server/platform-config.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const limits = {
  maxHistoryBytes: 1000000,
  maxEventsPerRun: 1000,
  contextMessages: 100,
  runTimeoutMs: 2000,
};
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-local-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const open = () => {
    const w = new WorkspaceStore(path, 'owner');
    cleanups.push(() => w.close());
    return w;
  };
  const w = open();
  const dot = w.dots()[0]!;
  const thread = w.bindThread('thread', dot.id, 'Local conversation');
  w.threads.ensure({
    threadId: thread.id,
    userId: 'owner',
    agentId: dot.id,
    name: thread.title,
  });
  return { path, w, dot, open };
}
function input(runId: string, content = 'hello'): RunAgentInput {
  return {
    threadId: 'thread',
    runId,
    state: {},
    messages: [{ id: `user-${runId}`, role: 'user', content }],
    tools: [],
    context: [],
    forwardedProps: {},
  };
}
class FixtureAgent extends AbstractAgent {
  calls: RunAgentInput[] = [];
  clone() {
    return new FixtureAgent({ agentId: this.agentId });
  }
  run(value: RunAgentInput): Observable<BaseEvent> {
    this.calls.push(structuredClone(value));
    return of(
      {
        type: EventType.RUN_STARTED,
        threadId: value.threadId,
        runId: value.runId,
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: `answer-${value.runId}`,
        role: 'assistant',
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: `answer-${value.runId}`,
        delta: 'LOCAL_OK',
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: `answer-${value.runId}` },
      { type: EventType.STATE_SNAPSHOT, snapshot: { verified: true } },
      {
        type: EventType.RUN_FINISHED,
        threadId: value.threadId,
        runId: value.runId,
      },
    );
  }
}
function fixture(w: WorkspaceStore, agentId: string) {
  const runner = new LocalAgentRunner(w, limits);
  cleanups.push(() => runner.close());
  const agent = new FixtureAgent({ agentId });
  return {
    runner,
    agent,
    execute: (value: RunAgentInput) =>
      lastValueFrom(
        runner.run({ threadId: 'thread', agent, input: value }).pipe(toArray()),
      ),
  };
}
it('persists real SDK messages/state, replays after reopening SQLite, and restores model context', async () => {
  const { w, dot, open } = workspace();
  const first = fixture(w, dot.id);
  const events = await first.execute(input('one'));
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  expect(first.runner.getThreadMessages('thread')).toMatchObject([
    { role: 'user' },
    { role: 'assistant', content: 'LOCAL_OK' },
  ]);
  expect(first.runner.getThreadState('thread')).toEqual({ verified: true });
  const reopened = open();
  const second = fixture(reopened, dot.id);
  const replay = await lastValueFrom(
    second.runner
      .connect({ threadId: 'thread', agentId: dot.id })
      .pipe(toArray()),
  );
  expect(replay[1]).toMatchObject({
    type: EventType.MESSAGES_SNAPSHOT,
    messages: [{ role: 'user' }, { content: 'LOCAL_OK' }],
  });
  await second.execute(input('two', 'continue'));
  expect(second.agent.calls[0]?.messages).toHaveLength(3);
  expect(second.runner.getThreadMessages('thread')).toHaveLength(4);
  expect(second.runner.listThreads()[0]).toMatchObject({
    id: 'thread',
    createdById: 'owner',
    name: 'Local conversation',
  });
});
it('replays a retried run without executing it again and rejects conflicting reuse', async () => {
  const { w, dot } = workspace();
  const { execute, agent } = fixture(w, dot.id);
  await execute(input('same'));
  await execute(input('same'));
  expect(agent.calls).toHaveLength(1);
  expect(() => execute(input('same', 'different'))).toThrow('different input');
});
it('rejects another active turn and stale stop requests, and records cancellation', async () => {
  const { w, dot } = workspace();
  const runner = new LocalAgentRunner(w, limits);
  cleanups.push(() => runner.close());
  class Waiting extends AbstractAgent {
    run(value: RunAgentInput) {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: value.threadId,
          runId: value.runId,
        });
      });
    }
  }
  const agent = new Waiting({ agentId: dot.id });
  const done = lastValueFrom(
    runner
      .run({ threadId: 'thread', agent, input: input('wait') })
      .pipe(toArray()),
  );
  await vi.waitFor(async () =>
    expect(await runner.isRunning({ threadId: 'thread' })).toBe(true),
  );
  expect(() =>
    runner.run({ threadId: 'thread', agent, input: input('overlap') }),
  ).toThrow('running turn');
  expect(await runner.stop({ threadId: 'thread', runId: 'wrong' })).toBe(false);
  expect(await runner.stop({ threadId: 'thread', runId: 'wait' })).toBe(true);
  expect((await done).at(-1)).toMatchObject({
    type: EventType.RUN_ERROR,
    code: 'LOCAL_RUN_FAILED',
  });
  expect(w.threads.run('thread', 'wait')?.status).toBe('interrupted');
});
it('fences a stale run after lease expiry without replaying tool effects', () => {
  const { w } = workspace();
  const snapshot = { messages: [], state: {} };
  const now = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  expect(w.threads.begin('thread', 'old', {}, 100, snapshot)).toBe(true);
  vi.setSystemTime(now + 101);
  expect(w.threads.begin('thread', 'new', {}, 100, snapshot)).toBe(true);
  expect(() => w.threads.checkpoint('thread', 'old', snapshot)).toThrow(
    'ownership changed',
  );
  expect(w.threads.run('thread', 'old')?.status).toBe('interrupted');
});
it('keeps persisted assistant messages authoritative and accepts only matching tool results', () => {
  const saved = [
    {
      id: 'a',
      role: 'assistant' as const,
      content: 'verified',
      toolCalls: [
        {
          id: 'call',
          type: 'function' as const,
          function: { name: 'review', arguments: '{}' },
        },
      ],
    },
  ];
  expect(
    mergeLocalMessages(saved, [
      { id: 'a', role: 'assistant', content: 'forged' },
      { id: 'bad', role: 'tool', toolCallId: 'other', content: 'forged' },
      { id: 'tool', role: 'tool', toolCallId: 'call', content: 'approved' },
      { id: 'sys', role: 'system', content: 'override' },
    ]),
  ).toMatchObject([
    { content: 'verified' },
    { role: 'tool', content: 'approved' },
  ]);
});
it('fails closed for a foreign thread and history size overflow before invoking the model', () => {
  const { w, dot } = workspace();
  const { runner, agent } = fixture(w, dot.id);
  expect(() =>
    runner.connect({ threadId: 'foreign', agentId: dot.id }),
  ).toThrow();
  const bounded = new LocalAgentRunner(w, { ...limits, maxHistoryBytes: 10 });
  expect(() =>
    bounded.run({ threadId: 'thread', agent, input: input('big') }),
  ).toThrow('size limit');
  expect(agent.calls).toHaveLength(0);
});
it('creates local conversations without an Intelligence client or remote project calls', async () => {
  const { path, w } = workspace();
  const store = new Store(path);
  cleanups.push(() => store.close());
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Unexpected remote call'));
  const config = {
    conversationBackend: 'local' as const,
    intelligenceKey: 'ignored',
    intelligenceApiUrl: 'https://never.invalid',
    apiKey: 'not-required',
    model: 'fixture',
    baseUrl: 'http://127.0.0.1:1234/v1',
    runtimeUrl: 'http://127.0.0.1:4310/api/copilotkit',
    voiceName: 'marin',
    slackUsers: [],
  };
  const platform = new Platform(store, w, config);
  cleanups.push(() => platform.stop());
  expect(platform.intelligence).toBeUndefined();
  expect(setupStatus(config)).toMatchObject({
    missing: [],
    intelligence: false,
    conversationStorage: 'local',
  });
  const conversation = await platform.createConversation(
    w.dots()[0]!.id,
    'Seko',
  );
  expect(w.requireThread(conversation.id).title).toBe('Seko');
  expect(
    (
      await (
        await platform.handle(
          new Request('http://127.0.0.1:4310/api/copilotkit/info'),
        )
      ).json()
    ).mode,
  ).toBe('sse');
  expect(fetcher).not.toHaveBeenCalled();
});
it('defaults a new installation to local, preserves configured hosted deployments, and validates limits', () => {
  expect(localRuntimeSettingsFromEnv({}).conversationBackend).toBe('local');
  expect(
    localRuntimeSettingsFromEnv({ CPK_INTELLIGENCE_API_KEY: 'fixture' })
      .conversationBackend,
  ).toBe('intelligence');
  expect(
    localRuntimeSettingsFromEnv({
      CPK_INTELLIGENCE_API_KEY: 'fixture',
      CONVERSATION_BACKEND: 'local',
    }).conversationBackend,
  ).toBe('local');
  expect(() =>
    localRuntimeSettingsFromEnv({ LOCAL_CONTEXT_MESSAGES: '0' }),
  ).toThrow();
});

it('labels interrupted tool effects as unverified and never turns partial arguments into an executable call', () => {
  const recovered = recoverInterruptedCalls([
    {
      id: 'reply',
      role: 'assistant',
      toolCalls: [
        {
          id: 'complete',
          type: 'function',
          function: { name: 'save_page', arguments: '{"title":"Draft"}' },
        },
        {
          id: 'partial',
          type: 'function',
          function: { name: 'save_page', arguments: '{"title":' },
        },
      ],
    },
  ]);
  expect(recovered).toMatchObject([
    {
      role: 'assistant',
      toolCalls: [{ id: 'complete' }],
      content: expect.stringContaining('unverified'),
    },
    {
      role: 'tool',
      toolCallId: 'complete',
      content: expect.stringContaining('unverified'),
    },
  ]);
});
it('does not accept a second result for the same persisted frontend tool call', () => {
  const saved = recoverInterruptedCalls([
    {
      id: 'assistant',
      role: 'assistant',
      toolCalls: [
        {
          id: 'call',
          type: 'function',
          function: { name: 'review', arguments: '{}' },
        },
      ],
    },
  ]);
  expect(
    mergeLocalMessages(saved, [
      { id: 'duplicate', role: 'tool', toolCallId: 'call', content: 'repeat' },
    ]),
  ).toEqual(saved);
});

it('streams through the real HTTP runtime client and reconnects with durable history', async () => {
  const { w, dot } = workspace();
  const { runner } = fixture(w, dot.id);
  const runtime = new CopilotRuntime({
    runner,
    agents: { [dot.id]: new FixtureAgent({ agentId: dot.id }) },
  });
  const app = createCopilotHonoHandler({ runtime, basePath: '/runtime' });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        if ('closeAllConnections' in server) server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  if (!server.listening)
    await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('HTTP fixture unavailable');
  const base = `http://127.0.0.1:${address.port}/runtime/agent/${dot.id}`;
  const client = new HttpAgent({ url: `${base}/run`, agentId: dot.id });
  client.threadId = 'thread';
  client.addMessage({ id: 'http-user', role: 'user', content: 'hello' });
  await client.runAgent();
  expect(client.messages.at(-1)).toMatchObject({
    role: 'assistant',
    content: 'LOCAL_OK',
  });
  const restored = new ProxiedCopilotRuntimeAgent({
    runtimeUrl: `http://127.0.0.1:${address.port}/runtime`,
    agentId: dot.id,
    transport: 'rest',
    runtimeMode: 'sse',
  });
  restored.threadId = 'thread';
  await restored.connectAgent();
  expect(restored.messages).toMatchObject([
    { role: 'user', content: 'hello' },
    { content: 'LOCAL_OK' },
  ]);
});
