// Explicit deployment type: a remote LAN server can also host a local model.
export function foregroundWaitPolicy(provider) {
  const local = provider?.deployment === 'local';
  return {
    idleMs: provider?.foregroundIdleMs ?? (local ? 0 : 90000),
    totalMs: provider?.foregroundTotalMs ?? (local ? 0 : 300000),
  };
}

export function validateWaitSettings(input, previous = {}) {
  previous ||= {};
  const deployment = input.deployment ?? previous.deployment ?? 'remote';
  if (!['local', 'remote'].includes(deployment)) throw new Error('模型部署类型无效');
  const settings = { deployment };
  for (const field of ['foregroundIdleMs', 'foregroundTotalMs']) {
    const value = input[field] === undefined ? previous[field] ?? null : input[field];
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 2147483647)) throw new Error('等待时限须为有效的非负整数，0表示不限');
    settings[field] = value;
  }
  return settings;
}
