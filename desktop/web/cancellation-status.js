export function cancellationStatus(sample) {
  return '本地已取消；'+(sample?.message||'服务端状态未知，取消尚未确认');
}
export function cancellationApplies(event,{running,stopping,cancelledTurnId}={}) {
  return Boolean(event?.turnId&&event.turnId===cancelledTurnId&&(!running||stopping));
}
