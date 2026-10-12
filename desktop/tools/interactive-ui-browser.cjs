const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.SUMMON_PLAYWRIGHT_PATH || 'playwright');

(async () => {
  const source = path.resolve(__dirname, '../web/interactive-ui.js');
  const stylesheet = path.resolve(__dirname, '../web/style.css');
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', request.url === '/interactive-ui.js' ? 'text/javascript' : request.url === '/style.css' ? 'text/css' : 'text/html');
    response.end(request.url === '/interactive-ui.js' ? await readFile(source) : request.url === '/style.css' ? await readFile(stylesheet) : '<link rel="stylesheet" href="/style.css"><main id="cards"></main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      const { createInteractiveCard } = await import('/interactive-ui.js');
      const artifact = { artifactId: 'fixture', document: { steps: [{ title: '失配', body: '先观察当前对齐。' }, { title: '移动', body: '跳过已排除的起点。' }] }, state: { step: 0 } };
      const card = createInteractiveCard({ artifactId: 'fixture', title: 'KMP 固定测试', status: 'available' }, {
        load: async () => artifact,
        save: async (_id, state) => { window.savedStep = state.step; },
      });
      document.querySelector('#cards').append(card);
      document.querySelector('#cards').append(createInteractiveCard({ artifactId: 'missing', status: 'missing' }, {}));
    });
    await page.getByRole('button', { name: '展开' }).first().click();
    assert.equal(await page.locator('.interactive-card-detail h4').innerText(), '失配');
    await page.getByRole('button', { name: '下一步' }).click();
    assert.equal(await page.locator('.interactive-card-detail h4').innerText(), '移动');
    await page.waitForFunction(() => window.savedStep === 1);
    await page.getByRole('button', { name: '重置' }).click();
    await page.waitForFunction(() => window.savedStep === 0);
    assert.equal(await page.locator('.interactive-card-error').innerText(), '作品文件不可用，聊天文字仍可查看。');
    assert.equal(await page.locator('.interactive-card').count(), 2);
    assert.ok(await page.locator('.interactive-card').first().evaluate(element => element.getBoundingClientRect().right <= window.innerWidth));
    console.log('Interactive card browser checks passed: narrow viewport, expand, next, reset, missing file.');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
