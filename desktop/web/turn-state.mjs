// A retry is part of the turn that scheduled it, so the reply is still running
// while the model service is being reconnected. These helpers keep that decision
// in one place: the window may only return to its idle state when the Agent says
// the whole turn is over, never because of an intermediate failure.
export function retryStarted(response) {
  return {
    running: true,
    status: response?.message || "模型服务连接失败，正在自动重连…",
    attempts: Number.isInteger(response?.attempt) ? response.attempt : null,
    maxAttempts: Number.isInteger(response?.maxAttempts) ? response.maxAttempts : null,
  };
}

export function retryEnded(response) {
  return { running: true, notice: response?.success ? "" : response?.message || "", reconnecting: false };
}

// A failure is terminal only when the Agent reports that nothing is running. An
// intermediate retry failure, or a message the Agent rejected while the previous
// turn was still in flight, keeps the running state and the stop button.
export function turnStillRunning(response) {
  return response?.busy === true;
}

export function terminalErrorMessage(response) {
  return response?.message || "PI Agent 出错";
}
