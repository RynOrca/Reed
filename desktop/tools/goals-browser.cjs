const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.SUMMON_PLAYWRIGHT_PATH || 'playwright');

(async () => {
  const allowed = new Set(['goals.js', 'icons.js', 'markdown.js', 'goal-tasks.js', 'vendor/marked.esm.js', 'style.css', 'learning-workspace.css']);
  const server = createServer(async (request, response) => {
    const file = request.url.slice(1);
    if (allowed.has(file)) {
      response.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(await readFile(path.resolve(__dirname, '../web', file))); return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/learning-workspace.css"><div class="chat-shell"><div class="chat-body"></div></div><button id="workspace-button">项目</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      const { createGoals } = await import('/goals.js');
      window.reads = 0;
      window.panel = createGoals({ command: async type => {
        if (type !== 'get_goals') throw Error('Unexpected mutation');
        window.reads++;
        if (window.delayRead) return new Promise(resolve => { window.resolveRead = resolve; });
        return { enabled: true, goal: { body: '# 隔离目标', revision: 'test' } };
      } });
      await window.panel.session('test-project', false);
    });
    assert.equal(await page.locator('.goals-handle').isVisible(), false);
    assert.equal(await page.evaluate(() => window.reads), 0);
    await page.evaluate(() => window.panel.session('test-project', true));
    await page.locator('.goals-handle').click();
    await page.locator('[data-goal="edit"]').click();
    await page.locator('textarea').fill('# 未保存的隔离草稿');
    await page.evaluate(() => window.panel.session('test-project', false));
    assert.equal(await page.locator('.goals-handle').isVisible(), false);
    assert.equal(await page.locator('.goals-slot').isVisible(), false);
    assert.equal(await page.locator('.goals-document').textContent(), '');
    assert.equal(await page.locator('textarea').inputValue(), '');
    await page.evaluate(() => window.panel.session('test-project', true));
    assert.match(await page.locator('.goals-document').textContent(), /未保存的隔离草稿/);
    await page.evaluate(async () => {
      window.delayRead = true;
      window.pendingRead = window.panel.session('other-project', true);
      await window.panel.session('other-project', false);
      window.resolveRead({ goal: { body: '# 过期响应不能显示', revision: 'late' } });
      await window.pendingRead;
    });
    assert.equal(await page.locator('.goals-handle').isVisible(), false);
    assert.equal(await page.locator('.goals-document').textContent(), '');
    console.log('Goals browser checks passed: disabled entry/content, same-project toggle, draft preservation and stale response.');
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
