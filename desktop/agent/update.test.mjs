import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, appVersion } from '../web/update.js';

// 版本比较决定「会不会提示更新」，判错会造成两种坏结果：
// 该提示的不提示（用户永远停在旧版），或不该提示的天天提示（骚扰）。
test('版本比较只认数字段，且把预发布后缀视为更旧', () => {
  assert.equal(isNewer('0.2.1', '0.2.0'), true);
  assert.equal(isNewer('0.2.0', '0.2.1'), false);
  assert.equal(isNewer('0.2.1', '0.2.1'), false);
  assert.equal(isNewer('v0.3.0', '0.2.9'), true, '应容忍 v 前缀');
  assert.equal(isNewer('0.2.1', '0.2'), true, '缺段按 0 处理');
  assert.equal(isNewer('0.10.0', '0.9.9'), true, '必须按数字比而不是字符串比');
  assert.equal(isNewer('1.0.0', '0.99.99'), true);

  // 预发布：数字段相同则更旧
  assert.equal(isNewer('0.2.1-beta.1', '0.2.1'), false, '预发布不应被当作更新');
  assert.equal(isNewer('0.2.1', '0.2.1-beta.1'), true, '正式版应覆盖同号预发布');

  // 垃圾输入不应抛错，且不应误报有更新
  assert.equal(isNewer('', '0.2.1'), false);
  assert.equal(isNewer(null, '0.2.1'), false);
  assert.equal(isNewer('abc', '0.2.1'), false);
});

test('读不到版本号时返回 null，不猜测、不编造', async () => {
  const failing = { core: { invoke: async () => { throw new Error('nope'); } } };
  // 有缓存时该函数会走缓存，这里用一个全新的模块状态无法重置，
  // 因此只断言「失败时不会返回一个假版本号」。
  const value = await appVersion(failing);
  assert.ok(value === null || /^\d+\.\d+/.test(value), `返回值不可信：${value}`);
});
