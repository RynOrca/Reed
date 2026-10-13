import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CapabilityStore } from '../agent/capabilities.mjs';
import { LocalSearchIndex } from '../agent/local-search.mjs';
import { createNoteRetriever } from '../agent/note-retrieval.mjs';

const root = await mkdtemp(join(tmpdir(), 'summon-knowledge-acceptance-'));
const vault = join(root, 'vault');
await mkdir(vault);
const caps = new CapabilityStore(join(root, 'data'));
await mkdir(caps.dir);
caps.state.vaultPath = vault;
const planCalls = [];
const expansions = new Map([
  ['eigenvalue in Chinese', ['特征值']],
  ['量子纠缠的应用', ['量子纠缠']],
]);
const retrieve = createNoteRetriever({
  capabilities: caps,
  model: () => ({ provider: 'synthetic', id: 'knowledge-acceptance' }),
  runtime: async () => ({
    completeSimple: async (_model, request) => {
      const payload = JSON.parse(request.messages[0].content[0].text);
      planCalls.push(payload.query);
      return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ queries: expansions.get(payload.query) || [] }) }] };
    },
  }),
});

const timings = {};
async function timed(name, fn) {
  const started = performance.now();
  const value = await fn();
  timings[name] = Number((performance.now() - started).toFixed(2));
  return value;
}
async function citationChecks(hits) {
  return Promise.all(hits.map(async hit => {
    const rel = relative(vault, hit.path);
    const withinVault = !rel.startsWith('..') && !isAbsolute(rel);
    let lineCount = 0;
    try { lineCount = (await readFile(hit.path, 'utf8')).split(/\r?\n/).length; } catch {}
    return {
      pathExists: withinVault && lineCount > 0,
      rowInRange: Number.isInteger(hit.startLine) && Number.isInteger(hit.endLine) && hit.startLine > 0 && hit.endLine >= hit.startLine && hit.endLine <= lineCount,
      lineUrl: new RegExp(`#L${hit.startLine}$`).test(hit.url),
    };
  }));
}
async function assertCitations(hits) {
  for (const check of await citationChecks(hits)) assert.ok(check.pathExists && check.rowInRange && check.lineUrl, '命中必须带有效路径、行号和行链接');
}
async function assertFixedEvidence(hits, { path, line, phrase }) {
  const hit = hits.find(item => item.path === path && item.startLine <= line && item.endLine >= line && item.content.includes(phrase));
  assert.ok(hit, `固定查询应命中 ${path} 第 ${line} 行的证据短语：${phrase}`);
  const rows = (await readFile(path, 'utf8')).split(/\r?\n/);
  assert.ok(rows[line - 1].includes(phrase), `引用行 ${line} 必须包含固定证据短语`);
  assert.match(hit.url, new RegExp(`#L${hit.startLine}$`));
  return { path, expectedLine: line, citedStartLine: hit.startLine, citedEndLine: hit.endLine, phrase };
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
async function stats(hits, relevantPaths) {
  const relevant = hits.filter(hit => relevantPaths.has(hit.path)).length;
  return { hitCount: hits.length, relevantHitCount: relevant, hitRelevance: hits.length ? Number((relevant / hits.length).toFixed(3)) : null, citations: await citationChecks(hits) };
}

try {
  const eigenFile = join(vault, 'linear-algebra.md');
  await writeFile(eigenFile, '# 线性代数\n\n特征值描述线性变换中特定方向上的缩放。\n');
  const quantumFile = join(vault, '量子.md');
  await writeFile(quantumFile, '# 量子纠缠\n\n量子纠缠是两个系统间的关联，英文称 quantum entanglement。\n');
  for (let i = 0; i < 3; i++) await writeFile(join(vault, `弱相关${i}.md`), `# 主题${i}\n量子关系背景资料 ${i}\n`);

  const precise = await timed('preciseHeadingMs', () => retrieve('量子纠缠'));
  assert.ok(precise.some(hit => hit.path === quantumFile));
  assert.equal(planCalls.filter(q => q === '量子纠缠').length, 0, '精确标题命中不应请求扩词');
  await assertCitations(precise);
  const fixedEvidence = [];
  fixedEvidence.push(await assertFixedEvidence(precise, { path: quantumFile, line: 3, phrase: '量子纠缠是两个系统间的关联' }));

  const synonymQuery = 'eigenvalue in Chinese';
  assert.equal((await caps.searchNotes(synonymQuery, 8)).some(hit => hit.path === eigenFile), false, '模拟扩词前本地英文检索不应命中纯中文目标文件');
  const synonym = await timed('englishSynonymMs', () => retrieve(synonymQuery));
  assert.ok(synonym.some(hit => hit.path === eigenFile), '英语查询应由模拟扩词召回中文笔记');
  assert.equal(planCalls.filter(q => q === synonymQuery).length, 1);
  await assertCitations(synonym);
  fixedEvidence.push(await assertFixedEvidence(synonym, { path: eigenFile, line: 3, phrase: '特征值描述线性变换' }));

  const weak = await timed('weakMatchExpansionMs', () => retrieve('量子纠缠的应用'));
  assert.ok(weak.some(hit => hit.path === quantumFile), '弱命中扩词应补回主题笔记');
  assert.equal(planCalls.filter(q => q === '量子纠缠的应用').length, 1);
  await assertCitations(weak);
  fixedEvidence.push(await assertFixedEvidence(weak, { path: quantumFile, line: 3, phrase: '两个系统间的关联' }));

  const editFile = join(vault, 'editable.md');
  await writeFile(editFile, '# 编辑主题\n旧版本标记\n\n# 旧尾段\n尾部独有词xyzq');
  await retrieve('旧版本标记');
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(editFile, '# 编辑主题\n新版本标记');
  const afterEdit = await timed('editRefreshMs', () => retrieve('旧版本标记'));
  assert.equal(afterEdit.some(hit => hit.path === editFile && hit.content.includes('旧版本标记')), false, '编辑后旧正文不应出现在命中中');
  assert.ok((await retrieve('新版本标记')).some(hit => hit.path === editFile && hit.content.includes('新版本标记')), '编辑后的新正文应可搜');

  const renameFrom = join(vault, 'rename-before.md'), renameTo = join(vault, 'rename-after.md');
  await writeFile(renameFrom, '# 重命名案例\n重命名检索词');
  await retrieve('重命名检索词');
  await rename(renameFrom, renameTo);
  const renamed = await timed('renameRefreshMs', () => retrieve('重命名检索词'));
  assert.ok(renamed.some(hit => hit.path === renameTo));
  assert.equal(renamed.some(hit => hit.path === renameFrom), false);

  const deleteFile = join(vault, 'delete-case.md');
  await writeFile(deleteFile, '# 删除案例\n删除专用检索词');
  await retrieve('删除专用检索词');
  await rm(deleteFile);
  const deleted = await timed('deleteRefreshMs', () => retrieve('删除专用检索词'));
  assert.equal(deleted.some(hit => hit.path === deleteFile), false);

  const deniedFile = join(vault, 'denied.md');
  await writeFile(deniedFile, '# 权限样例\n权限专用稀有词');
  await retrieve('权限专用稀有词');
  caps.canRead = async path => path !== deniedFile;
  const denied = await timed('permissionDeniedMs', () => retrieve('权限专用稀有词'));
  assert.equal(denied.some(hit => hit.path === deniedFile), false, '权限拒绝时旧索引不得披露');
  const retained = new LocalSearchIndex(join(caps.dir, 'local-search.sqlite'));
  try { assert.ok(retained.search('notes', vault, '权限专用稀有词', 8).some(hit => hit.payload.path === deniedFile), '旧索引应保留以支持恢复'); }
  finally { retained.close(); }
  caps.canRead = undefined;
  const restored = await timed('permissionRestoredMs', () => retrieve('权限专用稀有词'));
  assert.ok(restored.some(hit => hit.path === deniedFile && hit.content.includes('权限专用稀有词')), '权限恢复后应重新确认并召回笔记');
  await assertCitations(restored);

  const tailFile = join(vault, 'partial-update.md'), deniedSibling = join(vault, 'partial-denied.md');
  await writeFile(tailFile, '# 部分扫描样例\n当前有效段\n\n# 尾部标题\n部分扫描旧尾部专属词');
  await writeFile(deniedSibling, '# 拒绝样例\n触发不完整扫描');
  await retrieve('部分扫描旧尾部专属词');
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(tailFile, '# 部分扫描样例\n更新后的单段');
  caps.canRead = async path => path !== deniedSibling;
  const hiddenTail = await timed('partialScanMs', () => retrieve('部分扫描旧尾部专属词'));
  assert.equal(hiddenTail.some(hit => hit.path === tailFile && hit.content.includes('部分扫描旧尾部专属词')), false, '部分扫描中更新文件的旧尾部正文不得披露');
  assert.equal(caps.snapshot().noteScanStatus.state, 'incomplete');
  caps.canRead = undefined;

  const lostPath = join(root, 'missing-vault');
  caps.state.vaultPath = lostPath;
  const unreachable = await timed('vaultUnavailableMs', () => retrieve('量子纠缠'));
  assert.equal(unreachable.length, 0, 'Vault 不可达时不得返回旧索引');
  assert.equal(caps.snapshot().noteScanStatus.state, 'incomplete');
  caps.state.vaultPath = vault;

  // Synthetic scale check: 200 files, one heading plus 3 body paragraphs (about 800 segments).
  for (let i = 0; i < 200; i++) {
    const paragraphs = Array.from({ length: 3 }, (_, p) => `性能检索主题 样本${i} 段落${p}，用于固定规模扫描与索引计时。`);
    await writeFile(join(vault, `scale-${String(i).padStart(3, '0')}.md`), `# 性能样本 ${i}\n\n${paragraphs.join('\n\n')}\n`);
  }
  const perfHits = await timed('synthetic200FilesMs', () => retrieve('性能检索主题'));
  assert.ok(perfHits.length > 0);
  await assertCitations(perfHits);
  const warmScaleTimings = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    const hits = await retrieve('性能检索主题');
    warmScaleTimings.push(Number((performance.now() - started).toFixed(2)));
    assert.ok(hits.length > 0);
  }
  const index = new LocalSearchIndex(join(caps.dir, 'local-search.sqlite'));
  let indexedSegments;
  try { indexedSegments = index.list('notes', vault).length; }
  finally { index.close(); }
  assert.ok(indexedSegments <= 1000, `合成规模超出 1,000 段预算：${indexedSegments}`);

  const report = {
    mode: 'synthetic-local-vault; model expansion is mocked; no real model scoring',
    querySet: ['量子纠缠', synonymQuery, '量子纠缠的应用', '旧版本标记', '新版本标记', '重命名检索词', '删除专用检索词', '权限专用稀有词', '部分扫描旧尾部专属词', '性能检索主题'],
    checks: { preciseHeadingSkipsExpansion: true, englishSynonymExpanded: true, weakMatchesExpand: true, fixedQueryCitationRowsVerified: true, editRenameDeleteRefreshed: true, deniedAndUnreachableEvidenceHidden: true, permissionRestoreRecalled: true, partialScanStaleTailHidden: true },
    fixedEvidence,
    expansionCalls: planCalls,
    hitStats: { preciseHeading: await stats(precise, new Set([quantumFile])), englishSynonym: await stats(synonym, new Set([eigenFile])), weakExpansion: await stats(weak, new Set([quantumFile])), scale: await stats(perfHits, new Set(Array.from({ length: 200 }, (_, i) => join(vault, `scale-${String(i).padStart(3, '0')}.md`)))) },
    indexedSegments,
    timingsMs: timings,
    latencyBaseline: { syntheticFiles: 200, paragraphsPerFile: 3, indexedSegments, coldScanAndQueryMs: timings.synthetic200FilesMs, warmQuerySamplesMs: warmScaleTimings, warmQueryMedianMs: median(warmScaleTimings), threshold: 'measurement only; no pass/fail latency threshold' },
    notes: ['hitRelevance 是基于合成样例路径标签计算，不代表真实笔记质量。', '扩词计数来自 mock runtime，不代表真实模型行为或费用。', '行号检查验证格式和范围；真实引用是否支持回答主张需另行模型验收。'],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  caps.close();
  await rm(root, { recursive: true, force: true });
}
