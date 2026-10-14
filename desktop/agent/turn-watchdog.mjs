// A cancelled turn must always reach a terminal state, even when the model
// service or a tool keeps its promise pending. The watchdog escalates once and
// then forces a local end, so the window never stays on "正在停止…" forever.
export function createAbortWatchdog({ escalate, force, escalateMs = 15000, forceMs = 30000, timers = {} } = {}) {
  if (typeof escalate !== "function" || typeof force !== "function") throw new TypeError("escalate 和 force 必须是函数");
  if (!(forceMs > escalateMs && escalateMs >= 0)) throw new TypeError("forceMs 必须大于 escalateMs");
  const set = timers.setTimeout || setTimeout, clear = timers.clearTimeout || clearTimeout;
  let state = null;
  const stop = () => { if (!state) return null; const current = state; state = null; clear(current.escalateTimer); clear(current.forceTimer); return current; };
  return {
    arm(turnId) {
      stop();
      if (turnId === undefined || turnId === null) return false;
      const current = { turnId, escalated: false, forced: false };
      current.escalateTimer = set(() => {
        if (state !== current || current.forced) return;
        current.escalated = true;
        try { escalate(current.turnId); } catch {}
        current.forceTimer = set(() => {
          if (state !== current || current.forced) return;
          current.forced = true;
          state = null;
          try { force(current.turnId); } catch {}
        }, forceMs - escalateMs);
      }, escalateMs);
      state = current;
      return true;
    },
    // Disarm only the given turn; a late settlement of a replaced turn must not
    // cancel the watchdog protecting the turn that is actually running now.
    disarm(turnId) { if (state && (turnId === undefined || state.turnId === turnId)) stop(); },
    get armed() { return state ? { turnId: state.turnId, escalated: state.escalated } : null; },
  };
}
