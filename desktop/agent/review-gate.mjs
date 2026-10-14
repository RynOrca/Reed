/**
 * Review-skill gate.
 *
 * The待复习 queue may only be read after the model actually read the spaced-review
 * skill file in the current turn. Two timing facts drove this module:
 *   - tools in one assistant step may run in parallel, so the "loaded" flag has to
 *     be set when the read is *called*, not only when its result arrives;
 *   - a steering/queued message inside the same turn must not close the gate, while
 *     a new turn still requires a fresh read.
 *
 * `match(event)` decides whether an event is the skill read; this module only owns
 * the state machine so it can be unit tested without a session.
 */
export function createReviewGate({ match, turnKey } = {}) {
  if (typeof match !== "function" || typeof turnKey !== "function") throw new TypeError("match 和 turnKey 必须是函数");
  let loadedTurn = null;
  return {
    // Called for tool_call (before execution) and tool_result (confirmation).
    mark(event, loaded = true) {
      if (!match(event)) return false;
      loadedTurn = loaded ? turnKey() : null;
      return true;
    },
    isLoaded() { return loadedTurn !== null && loadedTurn === turnKey(); },
    reset() { loadedTurn = null; },
  };
}
