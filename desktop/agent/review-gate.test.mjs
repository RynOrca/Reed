import test from "node:test";
import assert from "node:assert/strict";
import { createReviewGate } from "./review-gate.mjs";

const event = (toolName, path) => ({ toolName, input: { path } });
const match = item => item?.toolName === "read" && item?.input?.path === "/skills/spaced-review/SKILL.md";

function fixture() {
  let turn = "turn-1";
  const gate = createReviewGate({ match, turnKey: () => turn });
  return { gate, nextTurn: value => { turn = value; } };
}

test("同一轮里 read 一调用就放行（不必等结果），后续并行工具也能看到", () => {
  const { gate } = fixture();
  assert.equal(gate.isLoaded(), false);
  assert.equal(gate.mark(event("read", "/skills/spaced-review/SKILL.md")), true);
  assert.equal(gate.isLoaded(), true, "tool_call 阶段就要放行，覆盖同批并行调用");
});

test("读取失败会关闭门控，其他工具与其他文件不会误开", () => {
  const { gate } = fixture();
  gate.mark(event("read", "/skills/spaced-review/SKILL.md"));
  gate.mark(event("read", "/skills/spaced-review/SKILL.md"), false); // isError
  assert.equal(gate.isLoaded(), false, "读取失败不能算已加载");
  assert.equal(gate.mark(event("grep", "/skills/spaced-review/SKILL.md")), false, "非 read 工具不能开门");
  assert.equal(gate.isLoaded(), false);
  assert.equal(gate.mark(event("read", "/vault/notes/其他.md")), false);
  assert.equal(gate.isLoaded(), false);
});

test("同一轮的引导消息不关闭门控，新一轮必须重新读取", () => {
  const { gate, nextTurn } = fixture();
  gate.mark(event("read", "/skills/spaced-review/SKILL.md"));
  assert.equal(gate.isLoaded(), true);
  // 同一轮里再来一条引导消息：轮次键不变（这里不调用 nextTurn）。
  assert.equal(gate.isLoaded(), true, "引导消息不改变轮次身份");
  nextTurn("turn-2");
  assert.equal(gate.isLoaded(), false, "新一轮必须重新读取技能文件");
  gate.mark(event("read", "/skills/spaced-review/SKILL.md"));
  assert.equal(gate.isLoaded(), true);
  gate.reset();
  assert.equal(gate.isLoaded(), false);
});

test("缺少 match/turnKey 时直接报错，避免静默放行", () => {
  assert.throws(() => createReviewGate({}), /match/);
  assert.throws(() => createReviewGate({ match }), /turnKey/);
});
