// The recovery reason is context, never a replacement for actual request progress.
export function requestStatus(response, recovery = '') {
  const phase = response.phase;
  const detail = phase === 'waiting'
    ? `等待模型返回，已等待 ${Math.max(1, Math.floor((response.elapsedMs || 0) / 60000))} 分钟，可手动停止。`
    : phase === 'connecting' ? '正在连接模型服务…'
    : phase === 'headers' ? '模型服务已响应，等待首段数据…'
    : phase === 'first_body' ? '已收到模型数据，正在生成回复…'
    : '正在生成回复…';
  return recovery ? `${recovery}；${detail}` : detail;
}
