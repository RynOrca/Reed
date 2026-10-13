const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.SUMMON_PLAYWRIGHT_PATH || 'playwright');

(async () => {
  const { createFixedDocument } = await import('../agent/interactive-ui/fixtures.mjs');
  const source = path.resolve(__dirname, '../web/interactive-ui.js');
  const components = path.resolve(__dirname, '../web/interactive-components.js');
  const stylesheet = path.resolve(__dirname, '../web/style.css');
  const server = createServer(async (request, response) => {
    if (request.url.startsWith('/fixture/')) {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(createFixedDocument(request.url.split('/').pop()))); return;
    }
    response.setHeader('content-type', request.url.endsWith('.js') ? 'text/javascript' : request.url === '/style.css' ? 'text/css' : 'text/html');
    response.end(request.url === '/interactive-ui.js' ? await readFile(source) : request.url === '/interactive-components.js' ? await readFile(components) : request.url === '/style.css' ? await readFile(stylesheet) : '<link rel="stylesheet" href="/style.css"><main id="cards"></main>');
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
    await page.evaluate(async () => {
      const { createInteractiveCard } = await import('/interactive-ui.js');
      window.sampleArtifacts = {};
      window.sampleCards = {};
      for (const topic of ['kmp', 'quicksort', 'attention', 'bellman']) {
        const doc = await (await fetch(`/fixture/${topic}`)).json();
        const artifact = { artifactId: topic, document: doc, state: { ...doc.initialState } };
        window.sampleArtifacts[topic] = artifact;
        const makeCard = () => {
          const card = createInteractiveCard({ artifactId: topic, title: doc.title, status: 'available' }, {
          load: async () => artifact,
          save: async (_id, state) => { artifact.state = { ...state }; },
          }); card.dataset.topic = topic; return card;
        };
        window.sampleCards[topic] = makeCard;
        document.querySelector('#cards').append(makeCard());
      }
    });
    const kmp = page.locator('.interactive-card').filter({ hasText: 'KMP：' });
    await kmp.getByRole('button', { name: '展开' }).click();
    await kmp.locator('input[type=range]').focus(); await page.keyboard.press('End');
    await page.waitForFunction(() => window.sampleArtifacts.kmp.state.offset === 2);
    assert.ok((await kmp.locator('.interactive-feedback').innerText()).includes('右移两格'));
    assert.equal(await kmp.locator('.interactive-reveal:visible').count(), 1);
    await kmp.getByRole('button', { name: '重新尝试' }).click();
    await page.waitForFunction(() => window.sampleArtifacts.kmp.state.offset === 0);
    await kmp.locator('input[type=range]').focus(); await page.keyboard.press('End');
    await page.waitForFunction(() => window.sampleArtifacts.kmp.state.offset === 2);
    await page.evaluate(() => { document.querySelector('[data-topic="kmp"]').remove(); document.querySelector('#cards').append(window.sampleCards.kmp()); });
    const restoredKmp = page.locator('.interactive-card').filter({ hasText: 'KMP：' });
    await restoredKmp.getByRole('button', { name: '展开' }).click();
    assert.equal(await restoredKmp.locator('input[type=range]').inputValue(), '2');
    const quicksort = page.locator('.interactive-card').filter({ hasText: '快排：' });
    await quicksort.getByRole('button', { name: '展开' }).click();
    const drag = quicksort.getByRole('slider', { name: '拖动分界线' });
    await drag.focus(); await page.keyboard.press('End'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => window.sampleArtifacts.quicksort.state.cut === 2);
    assert.ok((await quicksort.locator('.interactive-feedback').innerText()).includes('正确'));
    const box = await drag.boundingBox();
    await page.mouse.move(box.x + 10, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
    await page.waitForFunction(() => window.sampleArtifacts.quicksort.state.cut === 4);
    const attention = page.locator('.interactive-card').filter({ hasText: 'Attention：' });
    await attention.getByRole('button', { name: '展开' }).click();
    await attention.locator('input[type=range]').focus(); await page.keyboard.press('End');
    await page.waitForFunction(() => window.sampleArtifacts.attention.state.temperature === 3);
    assert.ok((await attention.locator('.interactive-bar-value').allInnerTexts()).includes('0.449'));
    const bellman = page.locator('.interactive-card').filter({ hasText: 'Bellman：' });
    await bellman.getByRole('button', { name: '展开' }).click();
    await bellman.locator('input[type=range]').focus(); await page.keyboard.press('End');
    await page.waitForFunction(() => window.sampleArtifacts.bellman.state.gamma_tenths === 10);
    assert.ok((await bellman.locator('.interactive-bar-value').allInnerTexts()).includes('5.0'));
    for (const card of await page.locator('.interactive-card').all()) assert.ok(await card.evaluate(element => element.getBoundingClientRect().right <= window.innerWidth));
    const touchPage = await browser.newPage({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
    await touchPage.goto(`http://127.0.0.1:${server.address().port}/`);
    await touchPage.evaluate(async () => {
      const { createInteractiveCard } = await import('/interactive-ui.js');
      const doc = await (await fetch('/fixture/quicksort')).json();
      window.touchState = { ...doc.initialState };
      document.querySelector('#cards').append(createInteractiveCard({ artifactId: 'touch', title: doc.title, status: 'available' }, {
        load: async () => ({ document: doc, state: window.touchState }),
        save: async (_id, state) => { window.touchState = state; },
      }));
    });
    await touchPage.getByRole('button', { name: '展开' }).click();
    const touchRail = touchPage.locator('.interactive-drag-rail');
    const touchBox = await touchRail.boundingBox();
    await touchPage.touchscreen.tap(touchBox.x + touchBox.width / 2, touchBox.y + touchBox.height / 2);
    await touchPage.waitForFunction(() => window.touchState.cut === 2);
    assert.equal(await touchPage.getByRole('slider', { name: '拖动分界线' }).getAttribute('aria-valuenow'), '2');
    await touchPage.close();
    console.log('Interactive card browser checks passed: 4 topics, keyboard, mouse/touch drag, state restoration, reset, missing file and 360px layout.');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
