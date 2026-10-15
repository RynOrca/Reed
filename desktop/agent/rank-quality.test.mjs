import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSearchIndex, rankHits, searchTokens } from "./local-search.mjs";
import { CapabilityStore, indexableChunk } from "./capabilities.mjs";

const fixture = async fn => { const dir = await mkdtemp(join(tmpdir(), "reed-rank-")); try { await mkdir(join(dir, "vault")); await fn(dir, join(dir, "vault")); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };

test("分隔线、围栏与零散标点不作为可检索片段", () => {
  assert.equal(indexableChunk("------"), false);
  assert.equal(indexableChunk("---"), false);
  assert.equal(indexableChunk("```"), false);
  assert.equal(indexableChunk("####"), false);
  assert.equal(indexableChunk("<div>"), false);
  assert.equal(indexableChunk("无关内容"), true);
  assert.equal(indexableChunk("## 9. kwargs 默认值"), true);
  assert.equal(indexableChunk("x=1"), false, "两个字符的碎片不足以作为证据");
  assert.equal(indexableChunk("value = 1"), true);
});

test("bm25 的短片段虚高被覆盖率重排压下去（用户实测 kwargs/temperature 场景）", () => {
  const words = searchTokens("kwargs 默认值 temperature");
  const rows = [
    // 只靠继承标题命中的分隔线：bm25 名次最好
    { id: "a:5", area: "notes", scope: "v", revision: "1", text: "note.md\nkwargs 默认值 temperature\n------", payload: JSON.stringify({ heading: "kwargs 默认值 temperature", content: "------", title: "note.md" }), rank: -36.8 },
    // 标题行自己作为一个片段
    { id: "a:3", area: "notes", scope: "v", revision: "1", text: "note.md\nkwargs 默认值 temperature\n## kwargs 默认值 temperature", payload: JSON.stringify({ heading: "kwargs 默认值 temperature", content: "## kwargs 默认值 temperature", title: "note.md" }), rank: -30.1 },
    // 真正包含答案的代码片段：bm25 名次最差
    { id: "a:9", area: "notes", scope: "v", revision: "1", text: "note.md\nkwargs\ntemperature=kwargs.get('temperature', 0.7)", payload: JSON.stringify({ heading: "kwargs 默认值", content: "temperature = kwargs.get('temperature', 0.7)", title: "note.md" }), rank: -17.2 },
  ];
  const ranked = rankHits(rows, words);
  assert.equal(ranked[0].id, "a:9", "真正含内容的片段必须排第一");
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked.every(hit => hit.bm25 !== undefined), "原始 bm25 仍保留用于诊断");
  assert.equal(ranked.at(-1).id, "a:3", "只有标题的片段排在最后");
});

test("只在标题命中的片段在没有更好候选时仍可用，但排在正文命中之后", () => {
  const words = searchTokens("复习计划");
  const rows = [
    { id: "h:1", area: "notes", scope: "v", revision: "1", text: "note.md\n复习计划\n## 复习计划", payload: JSON.stringify({ heading: "复习计划", content: "## 复习计划", title: "note.md" }), rank: -3 },
    { id: "c:4", area: "notes", scope: "v", revision: "1", text: "note.md\n其他\n复习计划安排在每周日", payload: JSON.stringify({ heading: "其他", content: "复习计划安排在每周日", title: "note.md" }), rank: -2.6 },
  ];
  const ranked = rankHits(rows, words);
  assert.equal(ranked[0].id, "c:4");
  const onlyHeadings = rankHits([rows[0]], words);
  assert.equal(onlyHeadings.length, 1, "没有正文命中时保留标题命中作为退路");
});

test("真实笔记库：分隔线不入库，正文命中排在标题命中之前", () => fixture(async (dir, vault) => {
  await writeFile(join(vault, "大模型八股100问.md"), `# 大模型八股 100 问

## 9. kwargs 默认值 temperature 怎么调

------

## 10. 其他参数

\`\`\`python
response = client.chat.completions.create(
    temperature=kwargs.get('temperature', 0.7),
)
\`\`\`
`);
  const capabilities = new CapabilityStore(dir);
  capabilities.state.vaultPath = vault;
  try {
    const hits = await capabilities.searchNotes("kwargs 默认值 temperature", 6);
    assert.ok(hits.length >= 2);
    assert.match(String(hits[0].display ?? hits[0].content), /kwargs\.get|temperature\s*=/);
    assert.equal(hits.some(hit => /^-+$/.test(String(hit.display ?? hit.content).trim())), false, "分隔线不得成为检索结果");
    assert.ok(hits[0].score <= 1 && hits[0].score >= 0, "对外的分数必须是 0~1 的可解释值");
  } finally { capabilities.close(); }
}));

test("工作记忆检索同样按内容覆盖率重排", () => {
  const index = new LocalSearchIndex(join(tmpdir(), `reed-rank-work-${process.pid}.sqlite`));
  try {
    index.put({ id: "w1", area: "work", scope: "", text: "PowerShell 环境变量 设置 PATH", payload: { title: "PowerShell" }, revision: "1" });
    index.put({ id: "w2", area: "work", scope: "", text: "PowerShell 环境变量 设置 PATH 的具体步骤与验证", payload: { title: "PowerShell" }, revision: "1" });
    const hits = index.search("work", "", "PowerShell 环境变量", 5);
    assert.equal(hits.length, 2);
    assert.ok(hits[0].score >= hits[1].score);
    assert.ok(hits.every(hit => hit.score <= 1));
  } finally { index.close(); }
});

test('RAG 文档切块 chunk 策略：具体切块段落优先于 FastGPT 平台介绍', () => fixture(async (dir,vault) => {
  await writeFile(join(vault,'第五章低代码平台.md'),'# FastGPT 平台介绍\n\nFastGPT 基于 RAG，可上传文档，设置 chunk 大小，通过低代码工作流构建应用。\n');
  await writeFile(join(vault,'文档预处理.md'),'# 文档切块策略\n\n文档切块需要考虑 chunk 边界、大小和重叠。固定长度策略实现简单，递归切块优先保留段落，语义切块沿语义边界划分。评估时比较检索命中率和上下文完整性。\n');
  const store=new CapabilityStore(dir);store.state.vaultPath=vault;
  try {
    for(const query of ['RAG 文档切块 chunk 策略','文档切块 策略']) {
      const hits=await store.searchNotes(query,8);
      assert.match(hits[0].content,/固定长度策略/);
      assert.ok(hits.some(hit=>hit.title.includes('低代码')),'弱相关介绍仍可作为后续候选');
      assert.ok(hits[0].score>hits.find(hit=>hit.title.includes('低代码')).score);
      assert.match(hits[0].url,/#L3$/,'保留原文定位');
    }
  } finally {store.close();}
}));

test('具体词组保留独立候选，超过旧 BM25 截断范围的正文仍能排第一',()=>fixture(async dir=>{
  const index=new LocalSearchIndex(join(dir,'candidates.sqlite'));
  try {
    index.transaction(()=>{
      for(let i=0;i<450;i++)index.put({id:`weak-${i}`,area:'notes',scope:'v',revision:'1',text:'RAG 文档 chunk 平台',payload:{title:'FastGPT',content:'RAG 文档 chunk 平台'}});
      const content='文档切块策略：固定长度、递归和语义切块，chunk overlap 保留边界上下文。'+ '需要结合资料结构评估上下文完整性。'.repeat(120);
      index.put({id:'answer',area:'notes',scope:'v',revision:'1',text:content,payload:{title:'文档切块',content}});
    });
    assert.equal(index.search('notes','v','RAG 文档切块 chunk 策略',8)[0].id,'answer');
  } finally {index.close();}
}));

test('英文按完整词匹配且正文规范化，RAG 不把 storage 算成正文命中',()=>{
  const rows=[
    {id:'weak',payload:JSON.stringify({heading:'RAG',content:'storage platform'}),text:'RAG storage platform',rank:-10},
    {id:'strong',payload:JSON.stringify({content:'ＲＡＧ retrieves relevant documents'}),text:'ＲＡＧ retrieves relevant documents',rank:-1},
  ];
  const hits=rankHits(rows,searchTokens('RAG'),{query:'RAG'});
  assert.equal(hits[0].id,'strong');
  assert.equal(hits.find(hit=>hit.id==='weak').contentHits,0);
});
