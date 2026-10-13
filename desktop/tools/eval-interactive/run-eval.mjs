// Reed 交互讲解评估驱动
//
// 作用：在完全隔离的数据目录里拉起 Reed 的 agent 桥，用真实模型逐题提问，
//       记录模型选了什么模式、作品是否通过校验、耗时与 token，最后产出覆盖率表。
//
// 安全边界：
//   - 不读写 Reed 的真实用户数据目录；所有文件写在临时目录，跑完删除。
//   - API Key 只经环境变量传入，不落盘到仓库、不写进结果文件。
//   - 不修改任何生产代码。
//
// 用法见同目录 README.md。

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROBLEMS, SUBJECTS, bySubject, auditProblems } from './problems.mjs';

const BRIDGE = new URL('../../agent/bridge.mjs', import.meta.url);

/** 与 Reed 前端一致：把 bridge.mjs 的 file URL 转成本机路径 */
function localPath(url) {
  return decodeURIComponent(url.pathname).replace(/^\/(\w:)/, '$1');
}

/**
 * 拉起一个隔离的 agent 桥。
 * 与 desktop/agent/interactive-ui/bridge.test.mjs 使用同一套环境变量契约。
 */
export function launchBridge(root, { env = {} } = {}) {
  const child = spawn(process.execPath, [localPath(BRIDGE)], {
    cwd: root,
    env: {
      ...process.env,
      SUMMON_DATA_DIR: join(root, 'data'),
      SUMMON_WORKSPACE: root,
      // 允许调用只读测试命令；不影响模型生成路径
      SUMMON_INTERACTIVE_UI_TEST: '1',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const events = [];
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    try { events.push(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ }
  });

  /**
   * 等待某个事件出现。
   * - 默认扫描历史，便于「等一个刚发生过的状态事件」（emitState 是同步连发的）。
   * - `call` 会显式传 `from`，只认本次发送之后产生的应答，
   *   否则复用的 id 会被上一轮的同名事件提前满足，导致假通过。
   */
  const waitFor = async (predicate, { timeoutMs = 120000, label = 'event', from = 0 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let cursor = from;
    while (Date.now() < deadline) {
      for (; cursor < events.length; cursor++) {
        if (predicate(events[cursor])) return events[cursor];
      }
      if (child.exitCode !== null) throw new Error(`桥已退出（code=${child.exitCode}），等待 ${label} 失败：${stderr.slice(-2000)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`等待 ${label} 超时：${stderr.slice(-2000)}`);
  };

  const send = (id, type, args = {}) => child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);

  /** 发送命令并等它的 ack/error（只认本次发送之后产生的应答） */
  const call = async (id, type, args = {}, options = {}) => {
    const from = events.length;
    send(id, type, args);
    const reply = await waitFor(
      message => message.id === id && (message.type === 'ack' || message.type === 'error'),
      { label: `${type} 应答`, from, ...options },
    );
    if (reply.type === 'error') throw new Error(`${type} 失败：${reply.message || '未知错误'}`);
    return reply;
  };

  const close = async () => {
    child.stdin.end();
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'close').catch(() => {});
  };

  return { child, events, waitFor, send, call, close, get stderr() { return stderr; } };
}

/**
 * 让桥进入「可评估」状态：配置真实 provider、选中模型、开启当前角色的交互讲解开关。
 * 全部通过桥自己的命令完成，不直接改文件，避免与 Reed 的持久化格式耦合。
 */
export async function prepareBridge(bridge, { baseUrl, apiKey, modelId, template = 'custom', protocol = 'openai-completions', thinkingLevel }) {
  const { call, waitFor } = bridge;
  await waitFor(message => message.type === 'ready', { label: 'ready', timeoutMs: 60000 });
  await call('init', 'init');

  // 1) 保存 provider（凭据经 Reed 自己的加密存储写入隔离目录）
  const saved = await call('p', 'save_provider', { template, baseUrl, protocol, key: apiKey, name: 'eval' });
  const providerId = saved.providerId;
  if (!providerId) throw new Error('save_provider 未返回 providerId');

  // 2) 拉取模型列表，确认目标模型存在（这一步同时验证凭据有效）
  await call('d', 'discover_models', { providerId });
  const models = await waitFor(message => message.type === 'models' && message.models?.some(m => m.id === modelId),
    { label: '模型出现在列表中', timeoutMs: 60000 }).catch(() => null);
  if (!models) {
    const any = bridge.events.findLast(message => message.type === 'models');
    const ids = (any?.models || []).map(m => m.id);
    throw new Error(`接口未返回模型 ${modelId}。该 provider 返回了 ${ids.length} 个模型${ids.length ? `，例如：${ids.slice(0, 10).join(', ')}` : ''}`);
  }

  // 3) 选中模型（思考档位可选）
  await call('m', 'select_model', { provider: providerId, model: modelId, ...(thinkingLevel ? { thinkingLevel } : {}) });

  // 4) 开启内置角色 agent 的交互讲解开关（关闭时工具不注册，模型根本看不到这套能力）
  //    init 与 select_model 各自会 emitState，所以这里显式再取一次状态，
  //    保证读到的是「当前」角色而不是启动时的快照。
  await call('st', 'get_state');
  const roles = await waitFor(message => message.type === 'roles', { label: '角色列表', timeoutMs: 30000 });
  const agent = roles.roles.find(role => role.id === 'agent');
  if (!agent) throw new Error('找不到内置角色 agent');
  await call('r', 'save_role', {
    roleId: 'agent',
    name: agent.name,
    system: agent.system,
    skills: agent.skills,
    learningGoalsEnabled: agent.learningGoalsEnabled,
    learnerProfileEnabled: agent.learnerProfileEnabled,
    interactiveUiEnabled: true,
  });
  await call('rs', 'select_role', { roleId: 'agent' });

  return { providerId, modelId };
}

/** 单题跑一次，返回结构化结果 */
export async function runProblem(bridge, problem, { timeoutMs = 300000 } = {}) {
  const { call, events, waitFor } = bridge;
  const startedAt = Date.now();
  const eventStart = events.length;
  const id = `q-${problem.id}`;

  const result = {
    id: problem.id,
    subject: problem.subject,
    kind: problem.kind,
    expectedMode: problem.expectedMode,
    withinEngine: problem.withinEngine,
    status: 'unknown',
    mode: null,
    artifactId: null,
    error: null,
    ms: 0,
    attempts: null,
    telemetry: null,
  };

  try {
    // prompt 命令成功时发 started/done，只有出错才发 error；因此不能等 ack。
    // 只给学生的提问，不附加任何实现提示，避免污染「模型能否自己选对路径」这一测量。
    bridge.send(id, 'prompt', { text: problem.prompt });
    const settled = await waitFor(
      message => message.id === id && ['done', 'error'].includes(message.type),
      { label: `${problem.id} 结束`, timeoutMs, from: eventStart },
    );
    if (settled.type === 'error') throw new Error(settled.message || '桥返回错误');
  } catch (error) {
    result.status = 'bridge-error';
    result.error = String(error.message || error).slice(0, 1000);
  }

  result.ms = Date.now() - startedAt;
  const slice = events.slice(eventStart);

  // 作品事件：模型是否真的生成了卡片
  const artifactEvent = slice.findLast(message => message.type === 'interactive_artifact');
  if (artifactEvent?.summary) {
    const summary = artifactEvent.summary;
    result.status = 'artifact';
    result.artifactId = summary.artifactId || null;
    result.attempts = summary.quality?.runtime?.attempts ?? null;
  } else if (result.status === 'unknown') {
    // 没有作品：要么模型选择了纯文字（对 kind:none 的题是正确答案），要么失败了
    result.status = 'text-only';
  }

  // 从 history 里回读该作品的模式与质量标记（作品正文在独立文件，需要单独取）
  const history = slice.findLast(message => message.type === 'history');
  const bound = history?.messages?.flatMap(message => message.interactiveArtifacts || []) || [];
  const boundOne = result.artifactId ? bound.find(item => item.artifactId === result.artifactId) : null;
  if (boundOne) result.mode = boundOne.mode || null;

  // 遥测：token 与耗时
  const telemetry = slice.findLast(message => message.type === 'telemetry');
  if (telemetry) result.telemetry = { inputTokens: telemetry.inputTokens ?? null, outputTokens: telemetry.outputTokens ?? null, ms: telemetry.generationMs ?? null };

  // 若生成了作品，取正文看模式与质量（校验结果在这里）
  if (result.artifactId) {
    try {
      const artifactReply = await call(`${id}-read`, 'get_interactive_artifact', { artifactId: result.artifactId });
      const artifact = artifactReply.artifact;
      result.mode = artifact?.document?.mode || result.mode;
      result.quality = artifact?.quality || null;
      result.renderedState = artifact?.state || null;
    } catch (error) {
      result.error = `${result.error ? `${result.error} | ` : ''}读取作品失败：${String(error.message || error).slice(0, 300)}`;
    }
  }

  return result;
}

/** 跑完整套题，每题一个新会话，避免上下文串扰 */
export async function runAll(bridge, problems = PROBLEMS, { onProgress, timeoutMs } = {}) {
  const results = [];
  for (const [index, problem] of problems.entries()) {
    // 新会话：保证每题独立，不受上一题对话历史影响
    await bridge.call(`new-${problem.id}`, 'new_session');
    const result = await runProblem(bridge, problem, { timeoutMs });
    // 会话里保留提示词，便于人工复核；这里只记录输出文件名
    result.prompt = problem.prompt;
    results.push(result);
    onProgress?.(index + 1, problems.length, result);
  }
  return results;
}

// ───────────────────────── 汇总与报告 ─────────────────────────

/** 判定单题结局：通过 / 溢出 / 应当克制却也生成了 / 失败 */
export function classify(result) {
  const generated = result.status === 'artifact';
  if (result.status === 'bridge-error') return 'error';
  if (result.kind === 'none') return generated ? 'over-generated' : 'text-correct';
  if (!generated) return 'no-artifact';
  // custom 有真实试运行；其余模式只有静态校验，必须如实区分
  const runtime = result.quality?.runtime;
  if (result.mode === 'custom') return runtime?.status === 'passed' ? 'validated' : 'static-only';
  return 'static-only';
}

export function summarize(results) {
  const rows = [];
  for (const [subject, list] of Object.entries(bySubject())) {
    const mine = results.filter(r => r.subject === subject);
    const applicable = mine.filter(r => r.kind !== 'none');
    rows.push({
      subject,
      label: SUBJECTS[subject],
      total: mine.length,
      applicable: applicable.length,
      artifact: applicable.filter(r => r.status === 'artifact').length,
      validated: applicable.filter(r => classify(r) === 'validated').length,
      staticOnly: applicable.filter(r => classify(r) === 'static-only').length,
      noArtifact: applicable.filter(r => classify(r) === 'no-artifact').length,
      error: applicable.filter(r => classify(r) === 'error').length,
      overGenerated: mine.filter(r => classify(r) === 'over-generated').length,
      textCorrect: mine.filter(r => classify(r) === 'text-correct').length,
      withinEngine: applicable.filter(r => r.withinEngine === 'engine' || r.withinEngine === 'components').length,
      avgMs: applicable.length ? Math.round(applicable.reduce((sum, r) => sum + (r.ms || 0), 0) / applicable.length) : 0,
    });
  }
  const all = {
    subject: 'ALL',
    label: '合计',
    total: results.length,
    applicable: results.filter(r => r.kind !== 'none').length,
    artifact: results.filter(r => r.kind !== 'none' && r.status === 'artifact').length,
    validated: results.filter(r => classify(r) === 'validated').length,
    staticOnly: results.filter(r => classify(r) === 'static-only').length,
    noArtifact: results.filter(r => classify(r) === 'no-artifact').length,
    error: results.filter(r => classify(r) === 'error').length,
    overGenerated: results.filter(r => classify(r) === 'over-generated').length,
    textCorrect: results.filter(r => classify(r) === 'text-correct').length,
    withinEngine: results.filter(r => r.kind !== 'none' && (r.withinEngine === 'engine' || r.withinEngine === 'components')).length,
    avgMs: results.length ? Math.round(results.reduce((sum, r) => sum + (r.ms || 0), 0) / results.length) : 0,
  };
  return { rows, all };
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
/** Markdown 表格单元格：竖线会破坏表格结构，必须转义 */
const cell = value => String(value).replace(/\|/g, '\\|');

export function renderReport(results, { modelId, baseUrl, date = new Date().toISOString().slice(0, 10) } = {}) {
  const { rows, all } = summarize(results);
  const lines = [];
  lines.push('# Reed 交互讲解评估结果', '');
  lines.push(`日期：${date}　模型：\`${modelId || '未知'}\`　接口：\`${baseUrl || '未知'}\``);
  lines.push(`题量：${results.length} 题（六科 × 6）。判定口径见本文末。「通过」列只统计**真正跑过沙箱试运行**的 custom 作品。`, '');
  lines.push('## 覆盖率总表', '');
  lines.push('| 学科 | 题数 | 适用题 | 生成作品 | 沙箱验证通过 | 仅静态校验 | 未生成 | 出错 | 平均耗时 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of [...rows, all]) {
    const bold = row.subject === 'ALL';
    const cell = value => (bold ? `**${value}**` : value);
    lines.push(`| ${cell(row.label)} | ${cell(row.total)} | ${cell(row.applicable)} | ${cell(`${row.artifact} (${pct(row.artifact, row.applicable)})`)} | ${cell(`${row.validated} (${pct(row.validated, row.applicable)})`)} | ${cell(row.staticOnly)} | ${cell(row.noArtifact)} | ${cell(row.error)} | ${cell(`${(row.avgMs / 1000).toFixed(1)}s`)} |`);
  }
  lines.push('');
  lines.push('## 「应当克制」的题目表现', '');
  lines.push('| 学科 | 题号 | 表现 |');
  lines.push('| --- | --- | --- |');
  for (const row of rows) {
    const negatives = results.filter(r => r.subject === row.subject && r.kind === 'none');
    for (const item of negatives) {
      const verdict = classify(item) === 'text-correct' ? '✅ 正确保持文字回答' : '⚠️ 生成了不必要的交互作品';
      lines.push(`| ${row.label} | ${item.id} | ${verdict} |`);
    }
  }
  lines.push('');
  lines.push('## 逐题明细', '');
  lines.push('| 题号 | 学科 | 需求 | 预期模式 | 实际模式 | 结局 | 耗时 | 备注 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const item of results) {
    const note = cell((item.error || '').slice(0, 90));
    lines.push(`| ${item.id} | ${SUBJECTS[item.subject]} | ${item.kind} | ${item.expectedMode} | ${item.mode || '—'} | ${classify(item)} | ${((item.ms || 0) / 1000).toFixed(1)}s | ${note} |`);
  }
  lines.push('');
  lines.push('## 判定口径', '');
  lines.push('- `validated`：生成了 custom 作品，且通过了 Reed 的真实沙箱试运行（初始渲染 + 全部 checks）。');
  lines.push('- `static-only`：生成了作品，但该模式**只有静态校验**，渲染正确性未经真实执行验证——这是当前评估能力的已知盲区。');
  lines.push('- `no-artifact`：模型选择纯文字回答，而这道题预期需要交互。');
  lines.push('- `over-generated`：题目正确答案就是文字，模型却生成了交互作品（过度生成）。');
  lines.push('- `error`：桥层报错、超时或作品无法读取。');
  lines.push('');
  lines.push('> 注意：本表只说明**能否生成并跑通**，不判定教学事实是否正确。事实层需要人工或独立算法核对，见题库 `correctness` 字段。');
  return lines.join('\n');
}

// ───────────────────────── CLI ─────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const arg = name => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const problems = arg('only')
    ? PROBLEMS.filter(problem => arg('only').split(',').includes(problem.id))
    : PROBLEMS;
  if (!problems.length) { console.error('--only 没有匹配到任何题目'); process.exit(2); }

  const baseUrl = process.env.REED_EVAL_BASE_URL;
  const apiKey = process.env.REED_EVAL_API_KEY;
  const modelId = process.env.REED_EVAL_MODEL;
  const template = process.env.REED_EVAL_TEMPLATE || 'custom';
  const protocol = process.env.REED_EVAL_PROTOCOL || 'openai-completions';
  const thinkingLevel = process.env.REED_EVAL_THINKING || undefined;
  const timeoutMs = Number(arg('timeout') || process.env.REED_EVAL_TIMEOUT || 300000);

  const missing = [!baseUrl && 'REED_EVAL_BASE_URL', !apiKey && 'REED_EVAL_API_KEY', !modelId && 'REED_EVAL_MODEL'].filter(Boolean);
  if (missing.length) {
    console.error(`缺少环境变量：${missing.join('、')}\n\n示例（PowerShell）：\n  $env:REED_EVAL_BASE_URL="https://api.deepseek.com/v1"\n  $env:REED_EVAL_API_KEY="sk-..."\n  $env:REED_EVAL_MODEL="deepseek-chat"\n  node desktop/tools/eval-interactive/run-eval.mjs\n\n也可以用 --only 先跑少量题目：\n  node desktop/tools/eval-interactive/run-eval.mjs --only dsa-01,la-03,net-06\n`);
    process.exit(2);
  }

  const issues = auditProblems(problems);
  if (issues.length) { console.error(`题库自检未通过：\n - ${issues.join('\n - ')}`); process.exit(2); }

  const root = await mkdtemp(join(tmpdir(), 'reed-eval-'));
  await mkdir(join(root, 'data'), { recursive: true });
  const bridge = launchBridge(root);
  let results = [];
  try {
    await prepareBridge(bridge, { baseUrl, apiKey, modelId, template, protocol, thinkingLevel });
    console.log(`已就绪：${modelId} @ ${baseUrl}（内置角色 agent 已开启交互讲解）`);
    console.log(`开始评估 ${problems.length} 题…\n`);
    results = await runAll(bridge, problems, {
      timeoutMs,
      onProgress: (done, total, result) => {
        const verdict = classify(result);
        console.log(`[${String(done).padStart(2)}/${total}] ${result.id.padEnd(7)} ${verdict.padEnd(14)} ${(result.mode || '—').padEnd(11)} ${((result.ms || 0) / 1000).toFixed(1)}s`);
      },
    });
  } finally {
    await bridge.close();
  }

  const report = renderReport(results, { modelId, baseUrl });
  const outDir = join(process.cwd(), 'desktop', 'tools', 'eval-interactive', 'results');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = join(outDir, `eval-${stamp}.md`);
  const jsonPath = join(outDir, `eval-${stamp}.json`);
  await writeFile(reportPath, report, 'utf8');
  // 结果里不含 API Key，只含接口地址与模型名
  await writeFile(jsonPath, JSON.stringify({ modelId, baseUrl, date: stamp, results }, null, 2), 'utf8');
  console.log(`\n${report}\n`);
  console.log(`报告：${reportPath}\n数据：${jsonPath}`);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// 仅在作为入口脚本直接运行时才执行 CLI。
// 不能只比较 process.argv[1]：在 `node --test` 下它就是测试文件，
// 会把本模块误判成入口并真的去跑评估。
const invokedDirectly = process.argv[1] && /run-eval\.mjs$/.test(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(error => { console.error(error); process.exit(1); });
}
