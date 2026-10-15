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

test('多条扩词反复命中的平台介绍不能压过原问题的切块策略',async()=>{
  const weak={...hit('FastGPT'),content:'FastGPT 基于 RAG，可以上传文档，设置 chunk 大小。'};
  const answer={...hit('文档切块'),heading:'文档切块策略',content:'文档切块应评估 chunk 边界；固定长度、递归切块和语义切块是三种策略。'};
  const capabilities={state:{vaultPath:'/vault'},async searchNotes(){return [weak,answer];},async searchMany(queries){return queries.map(()=>[weak]);}};
  const retrieve=createNoteRetriever({capabilities,runtime:async()=>planner(['FastGPT','低代码平台','RAG 平台']),model:()=>({provider:'test',id:'planner'})});
  const hits=await retrieve('RAG 文档切块 chunk 策略');
  assert.equal(hits[0].path,answer.path);
  assert.ok(hits[0].score>hits[1].score);
  assert.equal(hits.length,2,'重复扩词命中只保留一份原文');
});
