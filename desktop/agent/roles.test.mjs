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
    assert.deepEqual(first.list().roles.map((role) => role.id), ["agent", "planner", "quick"]);
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
    assert.equal(third.list().roles.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('学习模式按角色统一权限，旧混合配置不扩大权限，画布显式开启并重载',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'reed-learning-mode-'));
  try{
    await writeFile(join(directory,'roles.json'),JSON.stringify({activeId:'agent',roles:[{id:'agent',name:'旧导师',system:'学习',learningGoalsEnabled:false,learnerProfileEnabled:true}]}));
    const store=new RoleStore(directory);await store.load();
    assert.equal(store.current().learningModeEnabled,null);assert.equal(store.current().learningGoalsEnabled,false);assert.equal(store.current().learnerProfileEnabled,true);assert.equal(store.current().canvasEnabled,false);
    await store.save({roleId:'agent',name:'改名',system:'学习'});assert.equal(store.current().learningGoalsEnabled,false);
    await store.save({roleId:'agent',name:'导师',system:'学习',learningModeEnabled:true,canvasEnabled:true});assert.equal(store.current().learningGoalsEnabled,true);assert.equal(store.current().learnerProfileEnabled,true);
    const reload=new RoleStore(directory);await reload.load();assert.equal(reload.current().learningModeEnabled,true);assert.equal(reload.current().canvasEnabled,true);
    await reload.save({roleId:'agent',name:'导师',system:'学习',learningModeEnabled:false});assert.equal(reload.current().learningGoalsEnabled,false);assert.equal(reload.current().learnerProfileEnabled,false);
    assert.equal(reload.current().canvasEnabled,true,'关闭学习模式保留画布偏好，由有效权限控制可用性');
    await assert.rejects(reload.save({name:'无效',learningModeEnabled:'true'}),/布尔值/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
