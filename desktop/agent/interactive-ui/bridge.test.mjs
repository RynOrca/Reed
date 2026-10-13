import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

function launch(root) {
  const script = new URL('../bridge.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  const child = spawn(process.execPath, [script], {
    cwd: root, env: { ...process.env, SUMMON_DATA_DIR: join(root, 'data'), SUMMON_WORKSPACE: root, SUMMON_INTERACTIVE_UI_TEST: '1' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const seen = []; let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => { seen.push(JSON.parse(line)); });
  const until = async predicate => {
    for (let i = 0; i < 500; i++) { const found = seen.find(predicate); if (found) return found; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`Bridge timeout: ${stderr}`);
  };
  const send = (id, type, args = {}) => child.stdin.write(JSON.stringify({ id, type, ...args }) + '\n');
  const reply = async id => until(message => message.id === id && (message.type === 'ack' || message.type === 'error'));
  const close = async () => { child.stdin.end(); child.kill(); if (child.exitCode === null && child.signalCode === null) await once(child, 'close'); };
  return { child, seen, until, send, reply, close, get stderr() { return stderr; } };
}

test('chat history restores fixed artifacts, state, versions and missing files', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'reed-interactive-bridge-'));
  let bridge = launch(root);
  try {
    let { seen, until, send, reply } = bridge;
    await until(message => message.type === 'ready');
    send('init', 'init'); assert.equal((await reply('init')).type, 'ack', bridge.stderr);
    const sessionId = seen.findLast(message => message.type === 'session')?.sessionId;
    send('first', 'create_interactive_fixture');
    const first = await reply('first'); assert.equal(first.type, 'ack', first.message || bridge.stderr);
    send('second', 'create_interactive_fixture', { topic: 'quicksort', parentArtifactId: first.artifactId });
    const second = await reply('second'); assert.equal(second.type, 'ack', second.message || bridge.stderr);
    const history = seen.findLast(message => message.type === 'history');
    assert.equal(history.messages.flatMap(message => message.interactiveArtifacts || []).length, 2);
    assert.equal(history.messages.flatMap(message => message.interactiveArtifacts || [])[1].parentArtifactId, first.artifactId);
    send('save', 'save_interactive_artifact_state', { artifactId: first.artifactId, state: { offset: 2 } });
    assert.equal((await reply('save')).state.offset, 2);
    send('read', 'get_interactive_artifact', { artifactId: first.artifactId });
    assert.equal((await reply('read')).artifact.state.offset, 2);
    await bridge.close();
    bridge = launch(root);
    ({ seen, until, send, reply } = bridge);
    await until(message => message.type === 'ready');
    send('restart', 'init'); assert.equal((await reply('restart')).type, 'ack', bridge.stderr);
    assert.equal(seen.findLast(message => message.type === 'history').messages.flatMap(message => message.interactiveArtifacts || []).length, 2);
    send('after-restart', 'get_interactive_artifact', { artifactId: first.artifactId });
    assert.equal((await reply('after-restart')).artifact.state.offset, 2);
    send('new', 'new_session'); assert.equal((await reply('new')).type, 'ack');
    send('denied', 'get_interactive_artifact', { artifactId: first.artifactId });
    assert.equal((await reply('denied')).type, 'error');
    send('open', 'open_session', { sessionId }); assert.equal((await reply('open')).type, 'ack');
    assert.equal(seen.findLast(message => message.type === 'history').messages.flatMap(message => message.interactiveArtifacts || []).length, 2);
    send('restored', 'get_interactive_artifact', { artifactId: first.artifactId });
    assert.equal((await reply('restored')).artifact.state.offset, 2);
    await unlink(join(root, 'data', 'artifacts', 'interactive', sessionId, `${second.artifactId}.json`));
    send('refresh', 'open_session', { sessionId }); assert.equal((await reply('refresh')).type, 'ack');
    assert.equal(seen.findLast(message => message.type === 'history').messages.flatMap(message => message.interactiveArtifacts || [])[1].status, 'missing');
    send('delete', 'delete_session', { sessionId, confirm: true }); const deleted = await reply('delete'); assert.equal(deleted.type, 'ack', deleted.message || bridge.stderr);
    send('gone', 'open_session', { sessionId }); assert.equal((await reply('gone')).type, 'error');
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
