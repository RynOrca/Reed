import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalSearchIndex } from "./local-search.mjs";
import { CapabilityStore } from "./capabilities.mjs";

const fixture = async fn => {
  const root = await mkdtemp(join(tmpdir(), "reed-local-search-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
};

test("FTS supports Chinese bigrams and English words, and keeps payload text", () => fixture(async root => {
  const index = new LocalSearchIndex(join(root, "index.sqlite"));
  index.put({ id: "a", area: "notes", scope: "vault", text: "矩阵特征值 eigenvalue", payload: { content: "原始中文与英文" }, revision: "1" });
  assert.equal(index.search("notes", "vault", "特征值")[0].payload.content, "原始中文与英文");
  assert.equal(index.search("notes", "vault", "eigenvalue")[0].text, "矩阵特征值 eigenvalue");
  assert.deepEqual(index.search("notes", "vault", "!!!"), []);
  index.close();
}));

test("更新、删除、scope 隔离与重开数据库", () => fixture(async root => {
  const path = join(root, "index.sqlite");
  let index = new LocalSearchIndex(path);
  index.put({ id: "same", area: "work", scope: "project-a", text: "PowerShell 旧命令", payload: { body: "旧正文" }, revision: "1" });
  index.put({ id: "same", area: "work", scope: "project-b", text: "PowerShell 项目工具", payload: { body: "B 正文" }, revision: "1" });
  assert.equal(index.put({ id: "same", area: "work", scope: "project-a", text: "ignored", payload: {}, revision: "1" }), false);
  index.put({ id: "same", area: "work", scope: "project-a", text: "PowerShell 新命令", payload: { body: "新正文" }, revision: "2" });
  assert.equal(index.search("work", "project-a", "新命令")[0].payload.body, "新正文");
  assert.deepEqual(index.search("work", "project-a", "项目工具"), []);
  assert.equal(index.search("work", "project-b", "项目工具")[0].payload.body, "B 正文");
  index.close();

  index = new LocalSearchIndex(path);
  assert.equal(index.search("work", "project-a", "新命令").length, 1);
  assert.equal(index.remove("work", "same"), 2);
  assert.deepEqual(index.search("work", "project-a", "新命令"), []);
  index.close();
}));

test("retain removes stale documents only in the selected area and scope", () => fixture(async root => {
  const index = new LocalSearchIndex(join(root, "index.sqlite"));
  for (const [id, scope] of [["keep", "a"], ["stale", "a"], ["other", "b"]]) {
    index.put({ id, area: "notes", scope, text: "矩阵知识", payload: { id }, revision: "1" });
  }
  assert.equal(index.retain("notes", "a", ["keep"]), 1);
  assert.equal(index.search("notes", "a", "矩阵").length, 1);
  assert.equal(index.search("notes", "b", "矩阵").length, 1);
  index.close();
}));

test("CapabilityStore builds persistent note chunks without load and tracks edits, renames, and deletion", () => fixture(async dir => {
  const vault = join(dir, "vault");
  await mkdir(vault);
  const original = join(vault, "线代.md");
  await writeFile(original, "# 特征值\n\n矩阵的 eigenvalue 描述不变方向。\n");
  const capabilities = new CapabilityStore(dir);
  capabilities.state.vaultPath = vault;
  let hits = await capabilities.searchNotes("eigenvalue");
  assert.equal(hits[0].path, original);
  assert.ok(hits[0].startLine && hits[0].endLine && hits[0].url.includes("#L"));
  assert.equal(hits[0].content, "矩阵的 eigenvalue 描述不变方向。");

  await writeFile(original, "# 特征值\n\n更新后的谱分解内容。\n");
  hits = await capabilities.searchNotes("谱分解");
  assert.match(hits[0].content, /更新后的谱分解/);
  assert.deepEqual(await capabilities.searchNotes("eigenvalue"), []);

  const renamed = join(vault, "谱理论.md");
  await rename(original, renamed);
  hits = await capabilities.searchNotes("谱分解");
  assert.equal(hits[0].path, renamed);
  await rm(renamed);
  assert.deepEqual(await capabilities.searchNotes("谱分解"), []);
  capabilities.close();

  const restored = new CapabilityStore(dir);
  restored.state.vaultPath = vault;
  await writeFile(join(vault, "新笔记.md"), "# 矩阵\n\n重载后仍可索引。");
  assert.ok((await restored.searchNotes("重载"))[0].content.includes("重载后"));
  restored.close();
}));

test("未连接笔记库时搜索不创建索引文件", () => fixture(async dir => {
  const capabilities = new CapabilityStore(dir);
  assert.deepEqual(await capabilities.searchNotes("matrix"), []);
  assert.equal(capabilities.localSearch, null);
}));

test("一次检索的多个查询只扫描索引一次", () => fixture(async dir => {
  const vault = join(dir, "vault");
  await mkdir(vault);
  await writeFile(join(vault, "线代.md"), "# 特征值\n\n矩阵的 eigenvalue 描述不变方向。\n");
  const capabilities = new CapabilityStore(dir);
  capabilities.state.vaultPath = vault;
  const original = capabilities.searchNotesOnce.bind(capabilities);
  let scans = 0;
  capabilities.searchNotesOnce = (...args) => { scans++; return original(...args); };
  const [first, second, third] = await capabilities.searchMany(["特征值", "eigenvalue", "无关主题"], 4);
  assert.equal(scans, 1, "扩词查询必须共用同一次扫描");
  assert.equal(first[0].path, join(vault, "线代.md"));
  assert.equal(second[0].path, join(vault, "线代.md"));
  assert.deepEqual(third, []);
  assert.equal(await capabilities.searchNotes("eigenvalue").then(hits => hits.length), 1);
  assert.equal(scans, 2, "单独一次检索仍然扫描");
  capabilities.close();
}));

test("中断或重复的元数据在重开时自动修复，且不产生重复文档", () => fixture(async root => {
  const path = join(root, "index.sqlite");
  let index, db;
  try {
  index = new LocalSearchIndex(path);
  index.put({ id: "a:1", area: "notes", scope: "vault", text: "矩阵特征值", payload: { content: "矩阵特征值" }, revision: "1" });
  index.close(); index = null;

  // 建表后中断：元数据为空且版本未写入，文档仍在 FTS 表中。
  db = new DatabaseSync(path);
  db.exec("DELETE FROM search_metadata; PRAGMA user_version = 0;");
  db.close(); db = null;
  index = new LocalSearchIndex(path);
  assert.equal(index.list("notes", "vault").length, 1, "元数据必须重建");
  assert.equal(index.search("notes", "vault", "特征值").length, 1);
  assert.equal(index.put({ id: "a:1", area: "notes", scope: "vault", text: "矩阵特征值", payload: {}, revision: "1" }), false, "重新索引前必须先认得同一条文档");
  assert.equal(index.search("notes", "vault", "特征值").length, 1);
  index.close(); index = null;

  // 版本已写入但出现重复文档行：数量不一致触发重建并去重。
  db = new DatabaseSync(path);
  db.exec("INSERT INTO search_documents (id,area,scope,revision,tokens,text,payload) SELECT id,area,scope,revision,tokens,text,payload FROM search_documents");
  db.close(); db = null;
  index = new LocalSearchIndex(path);
  assert.equal(index.list("notes", "vault").length, 1);
  assert.equal(index.search("notes", "vault", "特征值").length, 1, "重复文档必须被清理");
  assert.equal(index.retain("notes", "vault", []), 1);
  assert.deepEqual(index.search("notes", "vault", "特征值"), []);
  index.close(); index = null;

  // 修复后重开保持稳定。
  index = new LocalSearchIndex(path);
  assert.deepEqual(index.list("notes", "vault"), []);
  index.put({ id: "b:1", area: "work", scope: "", text: "PowerShell 经验", payload: {}, revision: "1" });
  index.close(); index = null;
  index = new LocalSearchIndex(path);
  assert.equal(index.search("work", "", "PowerShell").length, 1);
  } finally { db?.close(); index?.close(); }
}));
