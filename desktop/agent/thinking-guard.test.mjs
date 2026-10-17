import test from 'node:test';
import assert from 'node:assert/strict';
import { createThinkingGuard, estimateTokens } from './thinking-guard.mjs';

test('token estimate treats CJK near one and latin near a quarter', () => {
  assert.equal(estimateTokens('中文四个字'), 5);
  assert.equal(estimateTokens('abcdefgh'), 2);
});

test('a repeated planning line is caught once thinking is substantial', () => {
  const guard = createThinkingGuard({ repeatLimit: 5, minTokensForRepetition: 20 });
  let verdict = null;
  for (let i = 0; i < 20 && !verdict; i += 1) verdict = guard.push('Let me write it now.\n');
  assert.equal(verdict.reason, 'repetition');
  assert.ok(verdict.repeats >= 5);
  assert.match(verdict.lineHash, /^[0-9a-f]{12}$/, 'diagnostics carry a hash, never the text');
  assert.ok(!JSON.stringify(verdict).includes('Let me'), 'repeated model text must not leak into the verdict');
});

test('alternating planning lines are caught too', () => {
  const guard = createThinkingGuard({ repeatLimit: 4, minTokensForRepetition: 20 });
  let verdict = null;
  for (let i = 0; i < 40 && !verdict; i += 1) verdict = guard.push(i % 2 ? 'Let me go.\n' : 'Let me write it.\n');
  assert.equal(verdict.reason, 'repetition');
});

test('long but varied reasoning is never interrupted', () => {
  const guard = createThinkingGuard();
  for (let i = 0; i < 400; i += 1) assert.equal(guard.push(`Step ${i}: inspect file ${i} before writing part ${i}.\n`), null);
});

test('short repetitive lines cannot trip before enough thinking has happened', () => {
  const guard = createThinkingGuard({ repeatLimit: 3 });
  for (let i = 0; i < 30; i += 1) assert.equal(guard.push('Let me go.\n'), null, 'under minTokensForRepetition');
});

test('a tripped guard stays tripped', () => {
  const guard = createThinkingGuard({ repeatLimit: 3, minTokensForRepetition: 5 });
  let verdict = null;
  for (let i = 0; i < 10 && !verdict; i += 1) verdict = guard.push('Let me write it now.\n');
  assert.equal(guard.push('other text'), verdict);
});