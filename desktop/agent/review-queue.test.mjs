import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearnerStore } from "./learner.mjs";

const fixture = async fn => { const root = await mkdtemp(join(tmpdir(), "reed-review-queue-")); try { await fn(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };

const seed = async root => {
  const learner = new LearnerStore(root);
  await learner.load();
  // 三条待复习概念，日期靠复习事件排定；其中一条故意用查询词以外的主题。
  await learner.record({ kind: "concept", subject: "矩阵特征值", detail: "学过特征值", evidence: "我学过矩阵特征值" }, "s", ["我学过矩阵特征值"]);
  await learner.record({ kind: "concept", subject: "层叠样式表", detail: "学过 CSS", evidence: "我学过层叠样式表" }, "s", ["我学过层叠样式表"]);
  await learner.record({ kind: "review", subject: "光合作用", detail: "复习过", evidence: "复习光合作用", result: "incorrect" }, "s", ["复习光合作用"]);
  return learner;
};

test("复习队列返回画像里全部待复习条目并按日期升序，不因查询词不匹配而为空", () => fixture(async root => {
  const learner = await seed(root);
  const profile = learner.snapshot().knowledge.filter(item => item.status === "needs_review");
  assert.equal(profile.length, 3, "画像里有三条待复习");
  const queue = learner.recall({ review: true, query: "完全不相关的查询词" });
  assert.equal(queue.length, 3, "查询词不匹配时仍必须返回完整队列");
  assert.deepEqual(queue.map(item => item.subject).sort(), profile.map(item => item.subject).sort(), "队列与画像口径一致");
  const dates = queue.map(item => Date.parse(item.nextReview));
  assert.ok(dates.every(Number.isFinite), "每条待复习条目都必须带排程日期");
  assert.deepEqual([...dates].sort((a, b) => a - b), dates, "按 nextReview 升序（逾期优先）");
  assert.equal(queue[0].order, 1);
  assert.ok(queue.every(item => item.status === "needs_review"));
}));

test("查询词只影响同日期内的先后，不改变队列内容", () => fixture(async root => {
  const learner = await seed(root);
  const all = learner.recall({ review: true });
  const focused = learner.recall({ review: true, query: "层叠样式表" });
  assert.equal(focused.length, all.length);
  assert.equal(focused[0].subject, "层叠样式表", "同日期下相关条目排前面");
  assert.deepEqual(focused.map(item => item.subject).sort(), all.map(item => item.subject).sort());
}));

test("未排程条目排最后且标为 null，复习结果写入 lastReviewResult", () => fixture(async root => {
  const learner = await seed(root);
  learner.state.knowledge.push({ subject: "未排程主题", status: "needs_review", detail: "旧条目", nextReview: undefined });
  const queue = learner.recall({ review: true });
  const last = queue.at(-1);
  assert.equal(last.subject, "未排程主题");
  assert.equal(last.nextReview, null, "未排程必须显式给 null，不能编造日期");
  assert.equal(queue.find(item => item.subject === "光合作用").lastReviewResult, "incorrect");
}));

test("非复习读取仍然不披露待复习条目", () => fixture(async root => {
  const learner = await seed(root);
  assert.deepEqual(learner.recall({ query: "矩阵特征值" }), [], "普通知识读取不含 needs_review");
  assert.doesNotMatch(learner.context(), /矩阵特征值|层叠样式表|光合作用/);
  assert.match(learner.context({ review: true }), /矩阵特征值/);
  assert.match(learner.context({ review: true }), /nextReview/);
}));
