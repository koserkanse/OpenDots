import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.js';
import { localMemoryTools } from '../src/server/memory-tools.js';
it('persists, deduplicates and corrects local memory across a database reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'seko-memory-'));
  const path = join(directory, 'local.sqlite');
  let store = new Store(path);
  try {
    const tools = localMemoryTools(store, () => {});
    const save = tools.find((tool) => tool.name === 'remember_preference')!;
    await save.execute!({ text: 'Use Turkish in presentation notes.' });
    await save.execute!({ text: 'Use Turkish in presentation notes.' });
    const original = store.memories()[0]!;
    expect(store.memories()).toHaveLength(1);
    store.close();
    store = new Store(path);
    expect(store.memories()[0]).toEqual(original);
    const reopened = localMemoryTools(store, () => {});
    await reopened.find((tool) => tool.name === 'remember_preference')!
      .execute!({
      text: 'Use Turkish and include sources.',
      replaceId: original.id,
    });
    expect(store.memories()).toMatchObject([
      { id: original.id, text: 'Use Turkish and include sources.' },
    ]);
    expect(
      await reopened.find((tool) => tool.name === 'list_memories')!.execute!(
        {},
      ),
    ).toMatchObject({ storage: 'local', memories: [{ id: original.id }] });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
it('checks current permission before every memory operation', async () => {
  const store = new Store(':memory:');
  try {
    const tools = localMemoryTools(store, () => {
      throw new Error('Permission revoked');
    });
    await expect(tools[1]!.execute!({ text: 'not saved' })).rejects.toThrow(
      'Permission revoked',
    );
    expect(store.memories()).toHaveLength(0);
  } finally {
    store.close();
  }
});
