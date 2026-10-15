// Packaged-app check for the retry state fix: the mock model drops the first two
// connections, then answers. Idle state may only appear after the retried turn
// really ends, and the intermediate failures must never reach the error area.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.SUMMON_PLAYWRIGHT_PATH);

(async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'reed-retry-native-'));
  const pkg = await require('./isolated-package.cjs')(process.env.SUMMON_TEST_PACKAGE, data);
  const artifacts = path.resolve(__dirname, '../../dist/retry-native-acceptance');
  await fs.mkdir(artifacts, { recursive: true });
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'retry-native-model', context_length: 65536, supports_reasoning: true, reasoning_efforts: ['off', 'low', 'medium'] }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    if (requests.length <= 2) { req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const part of [{ delta: { role: 'assistant', content: '自动重连后的回复。' }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) {
      res.write(`data: ${JSON.stringify({ id: 'retry-native', choices: [{ index: 0, ...part }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // The SDK default backoff is 2s/4s/8s, which leaves a wide window to observe the
  // reconnecting state before the retried request is sent.
  const port = 9322;
  const child = spawn(path.join(pkg, 'Reed.exe'), [], { cwd: pkg, windowsHide: true, env: { ...process.env, SUMMON_TEST_DATA_DIR: data, SUMMON_TEST_WEBVIEW_PORT: String(port) }, stdio: 'ignore' });
  let browser, page;
  const errors = [], checks = [], notes = [], seen = [];
  try {
    for (let i = 0; i < 80; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 600 }); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
    assert.ok(browser, 'WebView2 debugging endpoint unavailable');
    page = browser.contexts()[0].pages().find(item => !item.url().includes('settings.html'));
    page.on('pageerror', error => errors.push(String(error)));
    await page.locator('#status').filter({ hasText: '就绪' }).waitFor({ timeout: 30000 });
    await page.exposeFunction('__retryRecord', entry => { seen.push(entry); });
    await page.evaluate(() => window.__TAURI__.event.listen('agent-event', event => window.__retryRecord({ ...event.payload, at: Date.now() })));
    const command = (type, args = {}) => page.evaluate(({ type, args }) => new Promise(async (resolve, reject) => {
      const id = 'retry-native-' + Math.random();
      const timer = setTimeout(() => { off(); reject(Error('timeout ' + type)); }, 30000);
      const off = await window.__TAURI__.event.listen('agent-event', event => { const reply = event.payload; if (reply.id === id) { clearTimeout(timer); off(); reply.type === 'error' ? reject(Error(reply.message)) : resolve(reply); } });
      await window.__TAURI__.core.invoke('agent_command', { command: { id, type, ...args } });
    }), { type, args });
    const provider = await command('save_provider', { template: 'custom', name: '重试隔离验收', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'openai-completions' });
    await command('discover_models', { providerId: provider.providerId });
    await command('update_model', { providerId: provider.providerId, model: { id: 'retry-native-model', enabled: true } });
    await command('select_model', { provider: provider.providerId, model: 'retry-native-model' });
    for (const layer of ['l1', 'l2', 'l3', 'work']) await command('memory_enabled', { layer, enabled: false });

    await page.locator('#prompt').fill('隔离验收：连接失败后应自动重连。');
    await page.locator('#send-button').click();
    await page.locator('#status').filter({ hasText: '自动重连' }).waitFor({ timeout: 20000 });
    checks.push('重试期间状态栏显示自动重连');
    assert.equal(await page.locator('.message-error').count(), 0, '中间失败不能进入气泡区');
    assert.equal(await page.locator('#stop-button').isVisible(), true, '重试期间必须保留停止按钮');
    assert.equal((await page.locator('#status').innerText()).includes('就绪'), false, '重试期间不能显示就绪');
    // A turn that is reconnecting still owns the input: the same command the
    // composer issues is rejected, and the rejection must not paint idle.
    const rejection = await page.evaluate(() => new Promise(async resolve => {
      const id = 'retry-native-second';
      const off = await window.__TAURI__.event.listen('agent-event', event => { const reply = event.payload; if (reply.id === id) { off(); resolve(reply); } });
      await window.__TAURI__.core.invoke('agent_command', { command: { id, type: 'prompt', text: '重试期间的第二条消息' } });
    }));
    assert.equal(rejection.type, 'error', JSON.stringify(rejection));
    assert.equal(rejection.busy, true, '拒绝发送必须说明后台仍在运行');
    assert.equal(rejection.retrying, true, '拒绝发送必须说明正在自动重连');
    assert.match(rejection.message, /自动重连/);
    await page.locator('.message-error').filter({ hasText: '自动重连' }).waitFor({ timeout: 15000 });
    checks.push('重试期间再次发送被明确拒绝并说明原因');
    assert.equal((await page.locator('#status').innerText()).includes('就绪'), false, '拒绝发送后界面不能显示就绪');
    assert.equal(await page.locator('#stop-button').isVisible(), true);
    assert.equal(await page.locator('#stop-button').isDisabled(), false);
    checks.push('拒绝发送后仍可停止本轮');

    await page.locator('.prose-chat').filter({ hasText: '自动重连后的回复' }).waitFor({ timeout: 30000 });
    await page.locator('#status').filter({ hasText: '就绪' }).waitFor({ timeout: 20000 });
    checks.push('重试成功后正常完成并回到就绪');
    assert.equal(await page.locator('#stop-button').isVisible(), false);
    assert.equal(requests.length, 3, `模型请求次数应为 3（实际 ${requests.length}）`);
    assert.ok(requests.every(body => JSON.stringify(body.messages).includes('隔离验收：连接失败后应自动重连。')), '每次重试都保留原任务');
    assert.ok(!requests.some(body => JSON.stringify(body.messages).includes('重试期间的第二条消息')), '被拒绝的消息不能进入上下文');
    checks.push('重试保留原任务、被拒消息不进上下文');

    // The reply the user is waiting for must still be usable afterwards.
    await page.locator('#prompt').fill('重连之后的正常提问');
    await page.locator('#send-button').click();
    await page.locator('.prose-chat').filter({ hasText: '自动重连后的回复' }).nth(1).waitFor({ timeout: 30000 });
    await page.locator('#status').filter({ hasText: '就绪' }).waitFor({ timeout: 20000 });
    assert.equal(await page.locator('.message-error').filter({ hasText: 'Connection error' }).count(), 0, '整轮结束后仍不应留下中间失败提示');
    assert.equal(await page.locator('.message-error').filter({ hasText: '当前任务或配置仍在结束' }).count(), 0, '不应再出现笼统的忙碌提示');
    checks.push('随后一轮正常完成，界面无残留错误');
    assert.deepEqual(errors, []);
    const report = { checks, errors, notes, requests: requests.length, data, events: seen.filter(entry => !['telemetry', 'delta', 'message_outcome'].includes(entry.type)) };
    await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    console.error('RECENT EVENTS ' + JSON.stringify(seen.filter(entry => !['telemetry', 'delta', 'message_outcome'].includes(entry.type)).slice(-25), null, 1));
    console.error('ERROR ROWS ' + JSON.stringify(await page?.locator('.message-error').allTextContents().catch(() => [])));
    throw error;
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
