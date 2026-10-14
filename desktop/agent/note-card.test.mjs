import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityStore, noteBody } from "./capabilities.mjs";

const fixture = async fn => { const dir = await mkdtemp(join(tmpdir(), "reed-note-card-")); try { await mkdir(join(dir, "vault")); await fn(dir, join(dir, "vault")); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };

test("只剥离完整开头的 YAML frontmatter，普通 Markdown 原样保留", () => {
  assert.equal(noteBody("---\ntags: [学习, 编程]\naliases:\n---\n\n层叠样式表正文"), "层叠样式表正文");
  assert.equal(noteBody("\uFEFF---\r\ntags: x\r\n...\r\n正文"), "正文");
  assert.equal(noteBody("# 标题\n\n正文"), "# 标题\n\n正文");
  assert.equal(noteBody("--- 不是 frontmatter\n正文"), "--- 不是 frontmatter\n正文");
  assert.equal(noteBody("正文\n\n---\n\ntags: x\n---"), "正文\n\n---\n\ntags: x\n---", "中间的水平线不是 frontmatter");
  assert.equal(noteBody("---\n未闭合的 frontmatter\n正文"), "---\n未闭合的 frontmatter\n正文");
});

test("检索卡片预览去掉 frontmatter，浏览预览同样只给正文", () => fixture(async (dir, root) => {
  await mkdir(join(root, "编程"));
  await writeFile(join(root, "编程", "CSS.md"), "---\ntags: [学习, 编程]\n---\n\n层叠样式表（Cascading Style Sheets，缩写为 CSS）是一种样式表语言。\n");
  const capabilities = new CapabilityStore(dir);
  capabilities.state.vaultPath = root;
  try {
    const hits = await capabilities.searchNotes("层叠样式表", 8);
    assert.ok(hits.length, "正文必须能被检索到");
    const withFrontmatter = hits.find(hit => String(hit.display ?? hit.content).includes("Cascading"));
    assert.ok(withFrontmatter, "命中的段落应包含正文");
    assert.doesNotMatch(String(withFrontmatter.display ?? withFrontmatter.content), /tags:|^---/m, "卡片预览不得包含 frontmatter");
    const browse = await capabilities.browseNotes();
    assert.equal(browse.results.length, 1);
    assert.doesNotMatch(browse.results[0].content, /tags:|^---/m);
    assert.match(browse.results[0].content, /层叠样式表/);
  } finally { capabilities.close(); }
}));

test("每批仍然五篇且不跨批重复", () => fixture(async (dir, root) => {
  for (let i = 0; i < 12; i++) await writeFile(join(root, `note-${String(i).padStart(2, "0")}.md`), `# 笔记 ${i}\n\n矩阵正文 ${i}`);
  const capabilities = new CapabilityStore(dir);
  capabilities.state.vaultPath = root;
  try {
    const first = await capabilities.browseNotes();
    const second = await capabilities.browseNotes(first.next);
    assert.deepEqual([first.results.length, second.results.length], [5, 5]);
    assert.equal(new Set([...first.results, ...second.results].map(item => item.path)).size, 10);
  } finally { capabilities.close(); }
}));
