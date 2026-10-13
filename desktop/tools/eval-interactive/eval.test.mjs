import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROBLEMS, SUBJECTS, KINDS, COVERAGE, bySubject, auditProblems } from './problems.mjs';
import { classify, summarize, renderReport, launchBridge } from './run-eval.mjs';

test('题库结构完整：六科各 6 题，字段齐全，prompt 不泄露实现细节', () => {
  const issues = auditProblems();
  assert.deepEqual(issues, [], `题库自检未通过：\n${issues.join('\n')}`);
  assert.equal(PROBLEMS.length, 36);
  assert.deepEqual(Object.keys(bySubject()).sort(), Object.keys(SUBJECTS).sort());
  for (const problem of PROBLEMS) {
    assert.ok(KINDS.includes(problem.kind), `${problem.id} 需求类型 ${problem.kind}`);
    assert.ok(COVERAGE.includes(problem.withinEngine), `${problem.id} 覆盖判定 ${problem.withinEngine}`);
    assert.ok(problem.correctness.length > 20, `${problem.id} 必须给出可独立判定的正确性依据`);
  }
  // 整套题里必须有「应当克制」的负样本，否则过度生成无法被发现
  const negatives = PROBLEMS.filter(problem => problem.kind === 'none');
  assert.ok(negatives.length >= 3, `负样本至少 3 道，实际 ${negatives.length}`);
  for (const problem of negatives) {
    assert.equal(problem.withinEngine, 'wrong', `${problem.id} 负样本的覆盖判定应为 wrong`);
  }
});

test('判定口径区分真实验证与静态校验，并识别过度生成', () => {
  const custom = { status: 'artifact', kind: 'step', mode: 'custom', quality: { runtime: { status: 'passed' } } };
  assert.equal(classify(custom), 'validated');
  // custom 生成了但沙箱没通过 → 绝不能算通过
  assert.equal(classify({ ...custom, quality: { runtime: { status: 'failed' } } }), 'static-only');
  assert.equal(classify({ ...custom, quality: null }), 'static-only');
  // 非 custom 模式只有静态校验，必须如实标注而不是混进「通过」
  assert.equal(classify({ status: 'artifact', kind: 'plot', mode: 'math', quality: null }), 'static-only');
  assert.equal(classify({ status: 'artifact', kind: 'step', mode: 'components' }), 'static-only');
  // 未生成 / 出错
  assert.equal(classify({ status: 'text-only', kind: 'step', mode: null }), 'no-artifact');
  assert.equal(classify({ status: 'bridge-error', kind: 'step', mode: null }), 'error');
  // 负样本：正确克制 vs 过度生成
  assert.equal(classify({ status: 'text-only', kind: 'none', mode: null }), 'text-correct');
  assert.equal(classify({ status: 'artifact', kind: 'none', mode: 'components' }), 'over-generated');
});

test('汇总把负样本排除在覆盖率分母之外，报告含判定口径', () => {
  const results = [
    { id: 'dsa-01', subject: 'dsa', kind: 'step', withinEngine: 'custom-only', status: 'artifact', mode: 'custom', ms: 1000, quality: { runtime: { status: 'passed' } } },
    { id: 'dsa-02', subject: 'dsa', kind: 'step', withinEngine: 'custom-only', status: 'text-only', mode: null, ms: 500 },
    { id: 'net-06', subject: 'network', kind: 'none', withinEngine: 'wrong', status: 'artifact', mode: 'components', ms: 700 },
    { id: 'net-05', subject: 'network', kind: 'step', withinEngine: 'components', status: 'artifact', mode: 'components', ms: 900 },
    { id: 'os-06', subject: 'os', kind: 'none', withinEngine: 'wrong', status: 'text-only', mode: null, ms: 300 },
  ];
  const { rows, all } = summarize(results);
  const dsa = rows.find(row => row.subject === 'dsa');
  assert.equal(dsa.total, 2);
  assert.equal(dsa.applicable, 2, '负样本不属于 dsa，适用题仍为 2');
  assert.equal(dsa.validated, 1);
  assert.equal(dsa.noArtifact, 1);
  const network = rows.find(row => row.subject === 'network');
  assert.equal(network.total, 2);
  assert.equal(network.applicable, 1, '负样本必须排除在覆盖率分母之外');
  assert.equal(network.overGenerated, 1);
  assert.equal(all.total, 5);
  assert.equal(all.applicable, 3);
  assert.equal(all.overGenerated, 1);
  assert.equal(all.textCorrect, 1);

  const report = renderReport(results, { modelId: 'm', baseUrl: 'https://x/v1' });
  assert.match(report, /判定口径/);
  assert.match(report, /static-only/);
  assert.match(report, /应当克制/);

  // 备注里的竖线会拆散 Markdown 表格，必须转义
  const withPipe = renderReport(
    [{ id: 'x-01', subject: 'dsa', kind: 'step', withinEngine: 'custom-only', status: 'bridge-error', mode: null, ms: 10, error: 'a|b|c' }],
    { modelId: 'm', baseUrl: 'https://x/v1' },
  );
  const row = withPipe.split('\n').find(line => line.startsWith('| x-01'));
  assert.ok(row, '明细里应能找到该题');
  assert.ok(row.includes('a\\|b\\|c'), `竖线未转义：${row}`);
  assert.equal(row.split('|').length - 1, 11, `表格列数应为 10（9 个分隔符 + 首尾），实际：${row}`);
});

test('隔离桥可以独立启动并在关闭后不残留', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'reed-eval-smoke-'));
  const bridge = launchBridge(root);
  try {
    await bridge.waitFor(message => message.type === 'ready', { label: 'ready', timeoutMs: 60000 });
    await bridge.call('init', 'init');
    // init 自己会 emitState；这里显式再要一次状态，才能只认本次之后产生的 roles
    const roles = await bridge.call('state', 'get_state')
      .then(() => bridge.waitFor(message => message.type === 'roles', { label: 'roles', timeoutMs: 20000 }));
    assert.ok(roles.roles.some(role => role.id === 'agent'), '应存在内置角色 agent');
    // 默认必须是关闭状态：评估驱动靠这一步验证「开关确实生效」
    assert.equal(roles.roles.find(role => role.id === 'agent').interactiveUiEnabled, false);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
