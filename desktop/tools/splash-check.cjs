// 单独截一张启动动画，确认加了版本号之后布局没有走形。
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.SUMMON_PLAYWRIGHT_PATH);

(async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'reed-splash-'));
  const packageDir = await require('./isolated-package.cjs')(process.env.SUMMON_TEST_PACKAGE, data);
  const artifacts = path.resolve(__dirname, '../../dist/acceptance');
  await fs.mkdir(artifacts, { recursive: true });
  const port = 9341;
  const child = spawn(path.join(packageDir, 'Reed.exe'), [], {
    windowsHide: true, cwd: packageDir,
    env: { ...process.env, SUMMON_TEST_DATA_DIR: data, SUMMON_TEST_WEBVIEW_PORT: String(port) }, stdio: 'ignore',
  });
  let browser;
  try {
    for (let n = 0; n < 50; n++) {
      if (child.exitCode !== null) throw new Error(`exited ${child.exitCode}`);
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); break; }
      catch { await new Promise(r => setTimeout(r, 400)); }
    }
    assert.ok(browser, 'WebView2 endpoint unavailable');
    const main = browser.contexts()[0].pages().find(p => !p.url().includes('settings.html'));
    await main.locator('#status').filter({ hasText: '就绪' }).waitFor({ timeout: 25000 });

    // 启动动画正常情况下已经淡出；先等它自己的隐藏定时器跑完，再恢复成可见来检查版式，
    // 否则那个 240ms 的 setTimeout 会把我们刚恢复的画面又藏回去。
    await main.waitForFunction(() => document.getElementById('startup')?.hidden === true, { timeout: 10000 }).catch(() => {});
    await main.waitForTimeout(400);
    await main.evaluate(() => {
      const splash = document.getElementById('startup');
      splash.hidden = false;
      splash.classList.remove('startup-complete');
      splash.style.opacity = '1';
      splash.style.transition = 'none';
    });
    await main.waitForTimeout(300);
    const box = await main.locator('#startup').boundingBox();
    const version = await main.locator('#startup-version').textContent();
    const icon = await main.locator('#startup .brand-icon').boundingBox();
    const title = await main.locator('#startup h1').boundingBox();
    const tagline = await main.locator('#startup p').first().boundingBox();
    const versionBox = await main.locator('#startup-version').boundingBox();
    const progress = await main.locator('.startup-progress').boundingBox();
    console.log('版本文字   :', JSON.stringify(version));
    console.log('图标       :', JSON.stringify(icon));
    console.log('标题       :', JSON.stringify(title));
    console.log('标语       :', JSON.stringify(tagline));
    console.log('版本号     :', JSON.stringify(versionBox));
    console.log('进度条     :', JSON.stringify(progress));
    // 版式断言：自上而下且不重叠
    assert.ok(icon.y + icon.height <= title.y + 1, '图标应在标题上方');
    assert.ok(title.y + title.height <= tagline.y + 1, '标题应在标语上方');
    assert.ok(tagline.y + tagline.height <= versionBox.y + 1, '标语应在版本号上方');
    assert.ok(versionBox.y + versionBox.height <= progress.y + 1, '版本号应在进度条上方');
    // 版本号必须落在启动画面里，而不是被挤出可视区
    assert.ok(versionBox.y >= box.y && versionBox.y + versionBox.height <= box.y + box.height, '版本号应位于启动画面内');
    assert.ok(progress.y + progress.height <= box.y + box.height, '进度条应位于启动画面内');
    await main.screenshot({ path: path.join(artifacts, 'startup-splash.png') });
    console.log('OK 启动动画版式检查通过');
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => { console.error('FAIL', error.message); process.exit(1); });
