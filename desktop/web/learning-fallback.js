// Failed diagram attempts are internal. The agent writes the final plain-text
// explanation after its bounded correction attempts; do not expose diagnostics.
export function renderLearningFailure(root) { root.replaceChildren(); }
