import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoleStore } from "./roles.mjs";

test("角色预设可保存、重载、选择和删除，内置角色受保护", async () => {
  const directory = await mkdtemp(join(tmpdir(), "summon-roles-test-"));
  try {
    const first = new RoleStore(directory);
    await first.load();
    assert.deepEqual(first.list().roles.map((role) => role.id), ["agent", "quick"]);
    const id = await first.save({ name: "翻译官", system: "只做准确翻译" });
    await first.select(id);

    const second = new RoleStore(directory);
    await second.load();
    assert.equal(second.current().system, "只做准确翻译");
    assert.equal(second.current().name, "翻译官");
    await assert.rejects(second.delete("agent"), /内置角色/);
    await second.delete(id);
    assert.equal(second.activeId, "agent");

    const third = new RoleStore(directory);
    await third.load();
    assert.equal(third.list().roles.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('旧 Planner 配置退出角色列表，交互能力默认关闭并可独立持久化', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reed-role-migration-'));
  try {
    await writeFile(join(directory, 'roles.json'), JSON.stringify({activeId:'planner',roles:[{id:'planner',name:'Planner',system:'旧预设'}]}));
    const roles = new RoleStore(directory); await roles.load();
    assert.equal(roles.activeId, 'agent');
    assert.ok(roles.roles.every(role => !role.interactiveUiEnabled && role.id !== 'planner'));
    await roles.save({roleId:'agent',name:'Agent',system:'保留角色原则',interactiveUiEnabled:true});
    await assert.rejects(roles.save({roleId:'quick',name:'快捷',system:'',interactiveUiEnabled:'true'}), /布尔值/);
    const next = new RoleStore(directory); await next.load();
    assert.equal(next.current().interactiveUiEnabled,true);
    assert.equal(next.current().learningGoalsEnabled,false);
    assert.equal(next.roles.find(r=>r.id==='quick').interactiveUiEnabled,false);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
