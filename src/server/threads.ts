import { createHash } from 'node:crypto';
import { EventSchemas, MessageSchema } from '@ag-ui/core';
import type { BaseEvent, Message } from '@ag-ui/core';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const rowSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  ownerId: z.string(),
  name: z.string(),
  messages: z.string(),
  state: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const runSchema = z.object({
  runId: z.string(),
  status: z.enum(['running', 'complete', 'interrupted', 'failed']),
  inputHash: z.string(),
  leaseUntil: z.number(),
});
export type LocalRun = z.infer<typeof runSchema>;
export type LocalSnapshot = {
  messages: Message[];
  state: Record<string, unknown>;
};
export type ThreadInput = {
  threadId: string;
  userId: string;
  agentId: string;
  name: string;
};

/** Owner-scoped durable snapshots and run receipts share the workspace's SQLite connection. */
export class ConversationStore {
  constructor(
    private db: DatabaseSync,
    readonly ownerId: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS local_threads (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, agentId TEXT NOT NULL, name TEXT NOT NULL,
      messages TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS local_runs (
      threadId TEXT NOT NULL, runId TEXT NOT NULL, status TEXT NOT NULL,
      inputHash TEXT NOT NULL, leaseUntil INTEGER NOT NULL, PRIMARY KEY(threadId, runId));
      CREATE TABLE IF NOT EXISTS local_run_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL, runId TEXT NOT NULL,
      event TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS local_events_run ON local_run_events(threadId, runId, sequence);`);
  }
  private require(id: string) {
    const row = this.db
      .prepare('SELECT * FROM local_threads WHERE id=? AND ownerId=?')
      .get(id, this.ownerId);
    if (!row)
      throw new Error('Local conversation is not owned by this workspace.');
    return rowSchema.parse(row);
  }
  ensure(input: ThreadInput) {
    if (input.userId !== this.ownerId)
      throw new Error('Local conversation owner mismatch.');
    const now = Date.now();
    this.db
      .prepare(
        'INSERT OR IGNORE INTO local_threads(id,ownerId,agentId,name,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
      )
      .run(input.threadId, input.userId, input.agentId, input.name, now, now);
    const row = this.require(input.threadId);
    if (row.agentId !== input.agentId)
      throw new Error('Local conversation agent mismatch.');
    return row;
  }
  get(id: string): LocalSnapshot {
    const row = this.require(id);
    return {
      messages: MessageSchema.array().parse(JSON.parse(row.messages)),
      state: z.record(z.string(), z.unknown()).parse(JSON.parse(row.state)),
    };
  }
  list() {
    return this.db
      .prepare(
        'SELECT * FROM local_threads WHERE ownerId=? ORDER BY updatedAt DESC',
      )
      .all(this.ownerId)
      .map((row) => rowSchema.parse(row));
  }
  run(id: string, runId: string): LocalRun | undefined {
    this.require(id);
    const row = this.db
      .prepare('SELECT * FROM local_runs WHERE threadId=? AND runId=?')
      .get(id, runId);
    return row ? runSchema.parse(row) : undefined;
  }
  latestRun(id: string): LocalRun | undefined {
    this.require(id);
    const row = this.db
      .prepare(
        'SELECT * FROM local_runs WHERE threadId=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(id);
    return row ? runSchema.parse(row) : undefined;
  }
  begin(
    id: string,
    runId: string,
    input: object,
    leaseMs: number,
    snapshot: LocalSnapshot,
  ) {
    this.require(id);
    const inputHash = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.run(id, runId);
      if (previous) {
        if (previous.inputHash !== inputHash)
          throw new Error(
            'This run ID has already been used with different input.',
          );
        this.db.exec('COMMIT');
        return false;
      }
      if (
        this.db
          .prepare(
            "SELECT runId FROM local_runs WHERE threadId=? AND status='running' AND leaseUntil>?",
          )
          .get(id, Date.now())
      )
        throw new Error('This conversation already has a running turn.');
      this.db
        .prepare(
          "UPDATE local_runs SET status='interrupted' WHERE threadId=? AND status='running'",
        )
        .run(id);
      this.db
        .prepare("INSERT INTO local_runs VALUES (?,?,'running',?,?)")
        .run(id, runId, inputHash, Date.now() + leaseMs);
      this.save(id, snapshot);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private owns(id: string, runId: string) {
    this.require(id);
    return (
      this.db
        .prepare(
          "SELECT runId FROM local_runs WHERE threadId=? AND runId=? AND status='running'",
        )
        .get(id, runId) != null
    );
  }
  checkpoint(id: string, runId: string, snapshot: LocalSnapshot) {
    if (!this.owns(id, runId)) throw new Error('Local run ownership changed.');
    this.save(id, snapshot);
  }
  private save(id: string, snapshot: LocalSnapshot) {
    this.db
      .prepare(
        'UPDATE local_threads SET messages=?,state=?,updatedAt=? WHERE id=? AND ownerId=?',
      )
      .run(
        JSON.stringify(snapshot.messages),
        JSON.stringify(snapshot.state),
        Date.now(),
        id,
        this.ownerId,
      );
  }
  append(id: string, runId: string, event: BaseEvent) {
    if (!this.owns(id, runId)) throw new Error('Local run ownership changed.');
    this.db
      .prepare(
        'INSERT INTO local_run_events(threadId,runId,event) VALUES (?,?,?)',
      )
      .run(id, runId, JSON.stringify(event));
  }
  finish(
    id: string,
    runId: string,
    status: Exclude<LocalRun['status'], 'running'>,
    snapshot: LocalSnapshot,
    terminal: BaseEvent,
  ) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.checkpoint(id, runId, snapshot);
      this.append(id, runId, terminal);
      this.db
        .prepare('UPDATE local_runs SET status=? WHERE threadId=? AND runId=?')
        .run(status, id, runId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  events(id: string, runId?: string): BaseEvent[] {
    this.require(id);
    const rows = runId
      ? this.db
          .prepare(
            'SELECT event FROM local_run_events WHERE threadId=? AND runId=? ORDER BY sequence',
          )
          .all(id, runId)
      : this.db
          .prepare(
            'SELECT event FROM local_run_events WHERE threadId=? ORDER BY sequence',
          )
          .all(id);
    return rows.map((row) =>
      EventSchemas.parse(
        JSON.parse(z.object({ event: z.string() }).parse(row).event),
      ),
    );
  }
  getOrCreateThread(input: ThreadInput) {
    return Promise.resolve(this.ensure(input));
  }
  getThreadMessages(input: { threadId: string; userId: string }) {
    if (input.userId !== this.ownerId)
      throw new Error('Local conversation owner mismatch.');
    return Promise.resolve({ messages: this.get(input.threadId).messages });
  }
}
