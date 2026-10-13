import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 这一组断言守护的是一个「结构不变式」，不是样式审美：
// 角色列表复用 .memory-item，而它是 justify-content:space-between。
// 若把按钮平铺成同级子元素，内置角色行（1 个按钮）与自定义角色行（2 个按钮）
// 的子元素数量不同，space-between 就会把「编辑」放在不同水平位置——
// 这正是用户截图里「编辑按钮布局不对」的成因。
// 修法是把行尾按钮统一收进一个容器，使顶层恒为两个子元素（名称 + 按钮组）。

const settingsJs = await readFile(new URL('../web/settings.js', import.meta.url), 'utf8');
const settingsCss = await readFile(new URL('../web/settings.css', import.meta.url), 'utf8');

function renderRolesSource() {
  const start = settingsJs.indexOf('function renderRoles');
  assert.ok(start >= 0, '应能找到 renderRoles');
  const end = settingsJs.indexOf('\n}', start);
  return settingsJs.slice(start, end);
}

test('角色列表把行尾按钮收进同一容器，避免 space-between 造成错位', () => {
  const body = renderRolesSource();

  // 必须存在按钮组容器，并把「编辑」放进去
  assert.match(body, /createElement\("div"\)[^\n]*row-actions/, '应创建 .row-actions 容器');
  assert.match(body, /actions\.append\(edit\)/, '「编辑」必须进按钮组');

  // 删除按钮也必须进同一个容器，否则两级子元素数量又不一致
  assert.match(body, /actions\.append\(deletionButton/, '「删除」必须进同一个按钮组');

  // 顶层只允许 append(name, actions)：多平铺一个按钮就会重新引入错位
  assert.match(body, /row\.append\(name,\s*actions\)/, '顶层应只 append(name, actions)');
  assert.doesNotMatch(body, /row\.append\(name,\s*edit\)/, '不应再把「编辑」平铺到行上');
});

test('按钮组样式已定义并靠右，且未被 memory-item 的 gap 规则破坏', () => {
  assert.match(settingsCss, /\.row-actions\s*\{[^}]*display:flex/, '.row-actions 应为 flex 容器');
  assert.match(settingsCss, /\.row-actions\s*\{[^}]*margin-left:auto/, '.row-actions 应 margin-left:auto 靠右');
  assert.match(settingsCss, /\.row-actions\s*\{[^}]*flex:none/, '.row-actions 不应被压缩');

  // 前提仍然成立：如果哪天 .memory-item 不再是 space-between，这个修法的理由就该重新评估
  assert.match(settingsCss, /\.memory-item\s*\{[^}]*justify-content:space-between/,
    '.memory-item 仍是 space-between——本修法的前提');
});
