import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastValueFrom, toArray } from 'rxjs';
import {
  modelConnections,
  modelProfilesFromEnv,
  resolveDotModel,
} from '../src/server/models.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { completion } from './fixtures/model-stream.js';
const profiles = [
  {
    id: 'home',
    name: 'Home',
    location: 'local',
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: ['qwen-a', 'qwen-b'],
  },
  {
    id: 'cloud',
    name: 'Cloud',
    location: 'remote',
    baseUrl: 'https://provider.invalid/v1',
    models: ['remote-model'],
    apiKeyEnv: 'CLOUD_KEY',
  },
];
const config = (): PlatformConfig => ({
  conversationBackend: 'local',
  apiKey: 'default-key',
  model: 'default-model',
  baseUrl: 'https://default.invalid/v1',
  voiceName: 'marin',
  slackUsers: [],
  runtimeUrl: '',
  modelProfiles: modelProfilesFromEnv({
    OPENDOTS_MODEL_CONNECTIONS: JSON.stringify(profiles),
    CLOUD_KEY: 'private-fixture-key',
  }),
});
afterEach(() => vi.restoreAllMocks());
it('validates server profiles and never exposes keys or endpoints in the catalog', () => {
  const c = config();
  expect(modelConnections(c)).toHaveLength(3);
  expect(JSON.stringify(modelConnections(c))).not.toMatch(
    /private-fixture|baseUrl|apiKey/,
  );
  expect(() =>
    modelProfilesFromEnv({
      OPENDOTS_MODEL_CONNECTIONS: JSON.stringify([profiles[0], profiles[0]]),
    }),
  ).toThrow('Invalid OPENDOTS');
  expect(() =>
    modelProfilesFromEnv({
      OPENDOTS_MODEL_CONNECTIONS: JSON.stringify([
        { ...profiles[0], baseUrl: 'https://user:secret@example.com/v1' },
      ]),
    }),
  ).toThrow('Invalid OPENDOTS');
  const missing = {
    ...c,
    modelProfiles: modelProfilesFromEnv({
      OPENDOTS_MODEL_CONNECTIONS: JSON.stringify(profiles),
    }),
  };
  expect(() =>
    resolveDotModel(missing, {
      modelConnectionId: 'cloud',
      modelId: 'remote-model',
    }),
  ).toThrow('unavailable');
  expect(() =>
    resolveDotModel(c, { modelConnectionId: 'home', modelId: 'invented' }),
  ).toThrow('unavailable');
  expect(resolveDotModel(c, {})).toMatchObject({ model: 'default-model' });
});
it('persists independent selections through restart and keeps old clients from clearing them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-models-'));
  const path = join(dir, 'db.sqlite');
  let ws = new WorkspaceStore(path, 'owner');
  try {
    const a = ws.dots()[0];
    const b = ws.createDot(a.spaceId, 'Finance', 'Be precise', true, true);
    ws.setDotModel(a.id, { modelConnectionId: 'home', modelId: 'qwen-b' });
    ws.setDotModel(b.id, {
      modelConnectionId: 'cloud',
      modelId: 'remote-model',
    });
    ws.updateDot(a.id, { ...a, name: 'Presentation' });
    ws.close();
    ws = new WorkspaceStore(path, 'owner');
    expect(ws.dot(a.id)).toMatchObject({
      modelConnectionId: 'home',
      modelId: 'qwen-b',
    });
    expect(ws.dot(b.id)).toMatchObject({
      modelConnectionId: 'cloud',
      modelId: 'remote-model',
    });
    ws.setDotModel(a.id, { modelConnectionId: null, modelId: null });
    expect(resolveDotModel(config(), ws.dot(a.id)!)).toMatchObject({
      model: 'default-model',
    });
  } finally {
    ws.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('uses the owner API, validates pairs and rejects arbitrary routing and credential overrides', async () => {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'owner');
  const c = config();
  const platform = new Platform(store, ws, c);
  const app = createApp({
    store,
    runner: new Runner(store, { mode: 'live', baseUrl: c.baseUrl }),
    config: { mode: 'live', baseUrl: c.baseUrl },
    platform,
    ownerToken: 'owner-secret',
  });
  const id = ws.dots()[0].id;
  const update = (body: object, token = 'owner-secret') =>
    app.request(`/api/dots/${id}/model`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  try {
    expect((await app.request('/api/models')).status).toBe(401);
    expect(
      (await update({ modelConnectionId: 'home', modelId: 'qwen-b' }, 'wrong'))
        .status,
    ).toBe(401);
    expect(
      (await update({ modelConnectionId: 'home', modelId: 'qwen-b' })).status,
    ).toBe(200);
    for (const body of [
      { modelConnectionId: null, modelId: 'qwen-b' },
      { modelConnectionId: 'home', modelId: 'unknown' },
      {
        modelConnectionId: 'home',
        modelId: 'qwen-a',
        baseUrl: 'https://evil.invalid',
        apiKey: 'secret',
      },
    ])
      expect((await update(body)).status).toBe(400);
    expect(ws.dot(id)?.modelId).toBe('qwen-b');
  } finally {
    await platform.stop();
    ws.close();
    store.close();
  }
});
it('routes actual interactive and scheduled agent turns to each selected model and credential', async () => {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'owner');
  const c = config();
  const a = ws.dots()[0];
  const b = ws.createDot(a.spaceId, 'Finance', 'Be precise', false, false);
  ws.setDotModel(a.id, { modelConnectionId: 'home', modelId: 'qwen-b' });
  ws.setDotModel(b.id, { modelConnectionId: 'cloud', modelId: 'remote-model' });
  ws.bindThread('interactive', a.id, 'Chat');
  ws.bindThread('scheduled', b.id, 'Task');
  const calls: { url: string; model: string; auth: string | null }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const body = (await request.json()) as { model: string };
    calls.push({
      url: request.url,
      model: body.model,
      auth: request.headers.get('authorization'),
    });
    return completion({ content: 'Model verified' });
  });
  try {
    for (const [threadId, dotId] of [
      ['interactive', a.id],
      ['scheduled', b.id],
    ]) {
      const events = await lastValueFrom(
        new DotAgent(store, ws, c, dotId)
          .run({
            threadId,
            runId: threadId,
            state: {},
            context: [],
            tools: [],
            messages: [{ id: 'user', role: 'user', content: 'Reply briefly.' }],
            forwardedProps:
              threadId === 'scheduled'
                ? { opendotsSource: 'scheduled_task' }
                : {},
          })
          .pipe(toArray()),
      );
      expect(events.some((event) => event.type === 'RUN_ERROR')).toBe(false);
    }
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:1234/v1/chat/completions',
        model: 'qwen-b',
        auth: 'Bearer not-required',
      },
      {
        url: 'https://provider.invalid/v1/chat/completions',
        model: 'remote-model',
        auth: 'Bearer private-fixture-key',
      },
    ]);
  } finally {
    ws.close();
    store.close();
  }
});
