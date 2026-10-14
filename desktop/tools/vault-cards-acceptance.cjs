// Card layout acceptance for the note preview area: columns follow the width
// that is actually available next to the sidebar, the preview shows body text
// without leading YAML frontmatter, and it is clamped to five lines.
// Runs the real settings page in a real Chromium/Edge window with a mocked Agent.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');
const { chromium } = require(process.env.SUMMON_PLAYWRIGHT_PATH);

const LONG_BODY = '层叠样式表（Cascading Style Sheets，缩写为 CSS）是一种样式表语言，用来描述 HTML 文档的表现。'.repeat(6);
const hits = (offset, count) => Array.from({ length: count }, (_, index) => ({
  title: `数学/笔记${offset + index + 1}.md`,
  content: `---\ntags: [学习, 编程]\naliases:\n---\n\n${LONG_BODY}`,
  display: LONG_BODY,
  startLine: 1,
  endLine: 12,
  url: `summon-file:note-${offset + index}`,
}));

(async () => {
  const root = path.resolve(__dirname, '../web');
  const artifacts = path.resolve(__dirname, '../../dist/vault-cards');
  await fs.mkdir(artifacts, { recursive: true });
  const server = createServer(async (req, res) => {
    try {
      const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
      if (!file.startsWith(root + path.sep)) throw Error('outside');
      res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.SUMMON_EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.addInitScript(() => {
      const handlers = {};
      const emit = payload => (handlers['agent-event'] || []).forEach(fn => fn({ payload }));
      const provider = { id: 'test', template: 'custom', name: '隔离模型', baseUrl: 'http://localhost/v1', protocol: 'openai-completions', models: [{ id: 'test-model', name: '测试模型', contextWindow: 65536, reasoning: false }] };
      window.SUMMON_SETTINGS_SECTION = 'vault';
      window.__TAURI__ = {
        event: { listen: async (name, fn) => { (handlers[name] ??= []).push(fn); return () => {}; } },
        core: {
          invoke: async (name, args) => {
            if (name === 'desktop_preferences') return { theme: 'dark' };
            if (name === 'app_version') return '0.2.2';
            if (name !== 'agent_command') return;
            const command = args.command;
            queueMicrotask(() => {
              if (command.type === 'get_state') {
                emit({ type: 'providers', templates: [{ id: 'custom', name: '自定义', protocol: 'openai-completions' }], providers: [provider] });
                emit({ type: 'capabilities', state: { vaultPath: 'C:\\test-vault', skills: [] } });
                emit({ type: 'vault_overview', state: 'ready', path: 'C:\\test-vault\\Reed-笔记库总览.md', model: 'test/test-model' });
              }
              if (command.type === 'browse_notes') {
                const body = window.__VaultHits;
                emit({ type: 'ack', id: command.id, results: body.slice(command.offset, command.offset + 5), next: command.offset + 5 < body.length ? command.offset + 5 : null, total: body.length });
                return;
              }
              if (command.type === 'search_notes') {
                emit({ type: 'ack', id: command.id, results: window.__VaultHits.slice(0, 3) });
                return;
              }
              emit({ type: 'ack', id: command.id });
            });
          },
        },
      };
    });
    await page.addInitScript(`window.__VaultHits = ${JSON.stringify([...hits(0, 12), ...hits(12, 3).map(hit => ({ ...hit, title: '编程/CSS.md' }))])};`);
    await page.goto(`http://127.0.0.1:${server.address().port}/settings.html`);
    await page.waitForFunction(() => document.querySelectorAll('#vault-browse .card').length === 5);

    const columns = () => page.evaluate(() => getComputedStyle(document.querySelector('#vault-browse')).gridTemplateColumns.trim().split(/\s+/).length);
    const rows = () => page.evaluate(() => new Set([...document.querySelectorAll('#vault-browse .card')].map(card => card.getBoundingClientRect().top)).size);

    assert.equal(await columns(), 3, '宽窗口三列');
    assert.equal(await rows(), 2, '五篇卡片排成 3 + 2');
    await page.screenshot({ path: path.join(artifacts, 'wide-1400.png'), fullPage: true });

    await page.setViewportSize({ width: 1000, height: 900 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#vault-browse')).gridTemplateColumns.trim().split(/\s+/).length === 2);
    assert.equal(await rows(), 3, '中等窗口两列');
    await page.screenshot({ path: path.join(artifacts, 'medium-1000.png'), fullPage: true });

    await page.setViewportSize({ width: 640, height: 900 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#vault-browse')).gridTemplateColumns.trim().split(/\s+/).length === 1);
    assert.equal(await rows(), 5, '窄窗口一列');
    await page.screenshot({ path: path.join(artifacts, 'narrow-640.png'), fullPage: true });

    const excerpt = await page.evaluate(() => {
      const node = document.querySelector('#vault-browse .note-excerpt');
      const style = getComputedStyle(node);
      return { text: node.textContent, height: node.clientHeight, scrollHeight: node.scrollHeight, lineHeight: parseFloat(style.lineHeight), clamp: style.webkitLineClamp };
    });
    assert.doesNotMatch(excerpt.text, /tags:|aliases:/, '卡片预览不得包含 YAML frontmatter');
    assert.doesNotMatch(excerpt.text, /^\s*---/m, '卡片预览不得包含 frontmatter 分隔线');
    assert.match(excerpt.text, /层叠样式表/, '卡片预览必须显示正文');
    assert.equal(excerpt.clamp, '5');
    assert.ok(excerpt.height <= Math.ceil(excerpt.lineHeight * 5) + 1, `预览最多五行（height=${excerpt.height}, lineHeight=${excerpt.lineHeight}）`);
    assert.ok(excerpt.scrollHeight > excerpt.height, '超长正文必须被截断而不是继续撑高卡片');

    // 五篇一批：继续浏览追加五篇并保持列数一致。
    await page.locator('#vault-browse-more').click();
    await page.waitForFunction(() => document.querySelectorAll('#vault-browse .card').length === 10);
    assert.equal(await columns(), 1, '追加卡片后列数不变（窄窗口仍是一列）');
    const spacing = await page.evaluate(() => {
      const grid = document.querySelector('#vault-browse');
      const style = getComputedStyle(grid);
      const cards = [...grid.querySelectorAll('.card')];
      const first = cards[0].getBoundingClientRect(), second = cards[1].getBoundingClientRect();
      return { gap: parseFloat(style.gap || style.rowGap), margin: parseFloat(getComputedStyle(cards[0]).marginBottom), horizontal: Math.round(second.top - first.bottom) };
    });
    assert.equal(spacing.gap, 14, '行列间距统一为 14px');
    assert.equal(spacing.margin, 0, '卡片不再叠加外边距');
    assert.equal(spacing.horizontal, 14, '相邻卡片实际间距与 gap 一致');

    // 检索结果区与浏览区使用同一套卡片规则。
    await page.fill('#vault-query', '层叠样式表');
    await page.locator('#vault-search-form button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#vault-results .card').length === 3);
    const result = await page.evaluate(() => {
      const node = document.querySelector('#vault-results .note-excerpt');
      const card = document.querySelector('#vault-results .card');
      return { text: node.textContent, clamp: getComputedStyle(node).webkitLineClamp, padding: getComputedStyle(card).padding, columns: getComputedStyle(document.querySelector('#vault-results')).gridTemplateColumns.trim().split(/\s+/).length };
    });
    assert.doesNotMatch(result.text, /tags:|^\s*---/m, '检索结果同样不得显示 frontmatter');
    assert.match(result.text, /层叠样式表/);
    assert.equal(result.clamp, '5');
    assert.equal(result.padding, '16px');
    assert.equal(result.columns, 1);
    await page.screenshot({ path: path.join(artifacts, 'search-results.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: 三/二/一列随可用宽度变化、卡片 14px 统一间距、预览去 frontmatter 且限五行、每批五篇、检索结果同一规则、页面错误 0');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
