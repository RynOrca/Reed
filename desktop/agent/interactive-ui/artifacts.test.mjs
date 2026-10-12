import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InteractiveArtifactStore, boundArtifactIds } from './artifacts.mjs';

test('fixed artifact versions persist state and clean up with their isolated session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reed-artifact-test-'));
  const sessionId = randomUUID();
  const store = new InteractiveArtifactStore(root);
  const document = { schemaVersion: 1, mode: 'fixture', title: 'KMP', steps: [{ title: '一', body: '开始' }, { title: '二', body: '继续' }] };
  try {
    const first = await store.create(sessionId, document);
    const next = await store.create(sessionId, { ...document, title: 'KMP 修订版' }, { parentArtifactId: first.artifactId });
    assert.equal(next.parentArtifactId, first.artifactId);
    await store.saveState(sessionId, first.artifactId, { step: 1 });
    assert.equal((await new InteractiveArtifactStore(root).read(sessionId, first.artifactId)).state.step, 1);
    assert.equal((await store.read(sessionId, next.artifactId)).state.step, 0);
    await assert.rejects(store.saveState(sessionId, first.artifactId, { step: 9 }), /状态无效/);
    await assert.rejects(store.read(sessionId, '../escape'), /ID 无效/);
    await unlink(store.path(sessionId, next.artifactId));
    assert.equal((await store.summary(sessionId, next.artifactId)).status, 'missing');
    await store.deleteSession(sessionId);
    assert.equal(await store.read(sessionId, first.artifactId), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact binding follows assistant entries on the current branch only', () => {
  const assistantId = randomUUID(), artifactId = randomUUID();
  const branch = [
    { type: 'message', id: assistantId, message: { role: 'assistant' } },
    { type: 'custom', customType: 'reed_interactive_artifact', data: { messageEntryId: assistantId, artifactId } },
    { type: 'custom', customType: 'reed_interactive_artifact', data: { messageEntryId: randomUUID(), artifactId: randomUUID() } },
  ];
  assert.deepEqual([...boundArtifactIds(branch)], [artifactId]);
});
