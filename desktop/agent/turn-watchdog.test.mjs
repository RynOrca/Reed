import test from "node:test";
import assert from "node:assert/strict";
import { createAbortWatchdog } from "./turn-watchdog.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("escalates once and then forces a local end for the same turn", async () => {
  const events = [];
  const watchdog = createAbortWatchdog({
    escalate: turnId => events.push(["escalate", turnId]),
    force: turnId => events.push(["force", turnId]),
    escalateMs: 10, forceMs: 30,
  });
  assert.equal(watchdog.arm("turn-1"), true);
  assert.deepEqual(watchdog.armed, { turnId: "turn-1", escalated: false });
  await wait(60);
  assert.deepEqual(events, [["escalate", "turn-1"], ["force", "turn-1"]]);
  assert.equal(watchdog.armed, null);
  await wait(40);
  assert.equal(events.length, 2, "a forced turn does not escalate again");
});

test("a settled turn disarms the watchdog and never fires", async () => {
  const events = [];
  const watchdog = createAbortWatchdog({ escalate: () => events.push("escalate"), force: () => events.push("force"), escalateMs: 10, forceMs: 25 });
  watchdog.arm("turn-1");
  watchdog.disarm("turn-1");
  await wait(50);
  assert.deepEqual(events, []);
  assert.equal(watchdog.armed, null);
});

test("arming a new turn replaces the previous watchdog and ignores late settlement of the old turn", async () => {
  const events = [];
  const watchdog = createAbortWatchdog({ escalate: turnId => events.push(["escalate", turnId]), force: turnId => events.push(["force", turnId]), escalateMs: 10, forceMs: 25 });
  watchdog.arm("turn-1");
  watchdog.arm("turn-2");
  watchdog.disarm("turn-1");
  await wait(50);
  assert.deepEqual(events, [["escalate", "turn-2"], ["force", "turn-2"]]);
});

test("arming without a turn id is a no-op and rejects an inverted schedule", () => {
  const watchdog = createAbortWatchdog({ escalate: () => {}, force: () => {} });
  assert.equal(watchdog.arm(undefined), false);
  assert.equal(watchdog.armed, null);
  assert.throws(() => createAbortWatchdog({ escalate: () => {}, force: () => {}, escalateMs: 30, forceMs: 10 }), /forceMs/);
});
