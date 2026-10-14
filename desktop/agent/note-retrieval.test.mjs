import test from "node:test";
import assert from "node:assert/strict";
import { createNoteRetriever } from "./note-retrieval.mjs";

const hit = (name, startLine = 1) => ({ path: `/vault/${name}.md`, title: `${name}.md`, heading: "", startLine, endLine: startLine + 1, content: `${name} 的正文`, url: `summon-file:${name}` });

function planner(queries) {
  return { completeSimple: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ queries }) }] }) };
}

test("一次检索规划的多个扩词共用一次扫描，原问题仍单独检索", async () => {
  const calls = { notes: [], many: [] };
  const capabilities = {
    state: { vaultPath: "/vault" },
    async searchNotes(query) { calls.notes.push(query); return [hit("原始")]; },
    async searchMany(queries) { calls.many.push(queries); return queries.map(name => [hit(name)]); },
  };
  const retrieve = createNoteRetriever({ capabilities, runtime: async () => planner(["线性代数", "特征值", "eigenvalue"]), model: () => ({ provider: "test", id: "planner" }) });
  const hits = await retrieve("矩阵是什么", {});
  assert.deepEqual(calls.notes, ["矩阵是什么"], "原问题只扫描一次");
  assert.deepEqual(calls.many, [["线性代数", "特征值", "eigenvalue"]], "扩词合并为一次调用");
  assert.equal(hits.length, 4);
});

test("扩词与原问题重复时不重复检索，精确命中时完全不扩词", async () => {
  const calls = { notes: [], many: 0 };
  const capabilities = {
    state: { vaultPath: "/vault" },
    async searchNotes(query) { calls.notes.push(query); return [hit("矩阵是什么")]; },
    async searchMany() { calls.many++; return []; },
  };
  const retrieve = createNoteRetriever({ capabilities, runtime: async () => planner(["矩阵是什么"]), model: () => ({ provider: "test", id: "planner" }) });
  await retrieve("矩阵是什么", {});
  assert.equal(calls.many, 0, "扩词与原问题相同就不需要第二次检索");

  const precise = createNoteRetriever({ capabilities, runtime: async () => { throw Error("不得调用模型"); }, model: () => ({ provider: "test", id: "planner" }) });
  const hits = await precise("原始", {});
  assert.equal(hits.length, 1, "标题/正文精确命中时跳过模型扩词");
});

test("取消后不再发起扩词检索，只返回已得到的本地结果", async () => {
  const controller = new AbortController();
  let searched = 0;
  const capabilities = {
    state: { vaultPath: "/vault" },
    async searchNotes(query, limit, { signal } = {}) { searched++; signal?.throwIfAborted(); return [hit("原始")]; },
    async searchMany() { searched++; return []; },
  };
  const retrieve = createNoteRetriever({ capabilities, runtime: async () => { controller.abort(); return planner(["线性代数"]); }, model: () => ({ provider: "test", id: "planner" }) });
  const hits = await retrieve("矩阵是什么", { signal: controller.signal });
  assert.equal(searched, 1, "取消后不得再扫描笔记库");
  assert.equal(hits.length, 1);
});
