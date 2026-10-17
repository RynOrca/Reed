import test from 'node:test';
import assert from 'node:assert/strict';
import { createThinkingGuard, estimateTokens, thinkingBudgetFor } from './thinking-guard.mjs';

test('token estimate treats CJK near one and latin near a quarter', () => {
  assert.equal(estimateTokens('中文四个字'), 5);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.ok(estimateTokens('中') > estimateTokens('a'));
});

test('budget stops a reasoning stream that would spend the whole output', () => {
  const guard = createThinkingGuard({ budgetTokens: 100 });
  assert.equal(guard.push('a'.repeat(200)), null, '50 tokens is under the budget');
  const verdict = guard.push('b'.repeat(400));
  assert.equal(verdict.reason, 'budget');
  assert.equal(verdict.limit, 100);
  assert.ok(verdict.tokens >= 100);
  assert.equal(guard.push('more'), verdict, 'a tripped guard stays tripped');
});

test('zero budget disables the budget but keeps repetition detection', () => {
  const guard = createThinkingGuard({ budgetTokens: 0, repeatLimit: 5, minTokensForRepetition: 5 });
  let verdict = null;
  for (let i = 0; i < 20 && !verdict; i += 1) verdict = guard.push('Let me write it now.\n');
  assert.equal(verdict.reason, 'repetition');
  assert.ok(verdict.repeats >= 5);
  assert.match(verdict.lineHash, /^[0-9a-f]{12}$/, 'diagnostics carry a hash, never the text');
  assert.ok(!JSON.stringify(verdict).includes('Let me'), 'repeated model text must not leak into the verdict');
});

test('alternating planning lines are caught once thinking is substantial', () => {
  const guard = createThinkingGuard({ budgetTokens: 0, repeatLimit: 4, minTokensForRepetition: 20 });
  let verdict = null;
  for (let i = 0; i < 40 && !verdict; i += 1) verdict = guard.push(i % 2 ? 'Let me go.\n' : 'Let me write it.\n');
  assert.equal(verdict.reason, 'repetition');
});

test('varied reasoning never trips repetition', () => {
  const guard = createThinkingGuard({ budgetTokens: 0 });
  const lines = Array.from({ length: 200 }, (_, i) => `Step ${i}: inspect file ${i} before writing part ${i}.`);
  for (const line of lines) assert.equal(guard.push(`${line}\n`), null);
});

test('short repetitive lines cannot trip before enough thinking has happened', () => {
  const guard = createThinkingGuard({ budgetTokens: 0, repeatLimit: 3 });
  for (let i = 0; i < 30; i += 1) assert.equal(guard.push('Let me go.\n'), null, 'under minTokensForRepetition');
});

test('auto budget leaves room to answer but caps planning', () => {
  assert.equal(thinkingBudgetFor(null, 100000), 8192);
  assert.equal(thinkingBudgetFor(null, 16384), 8192);
  assert.equal(thinkingBudgetFor(null, 500), 1024);
  assert.equal(thinkingBudgetFor(null, undefined), 8192);
  assert.equal(thinkingBudgetFor(0, 16384), 0, 'explicit zero disables the budget');
  assert.equal(thinkingBudgetFor(2048, 16384), 2048);
});
