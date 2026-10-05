/**
 * Did an action work? Shared by the voice pipeline (progress outcomes) and
 * the task agent (step checks).
 */

export function toolFailed(result) {
  return result?.status === 'error' || !!result?.error;
}

/** An AI turn failed if it errored, any action failed, or nothing was done. */
export function aiCommandFailed(result) {
  if (!result || result.error || result.noAction) return true;
  return Array.isArray(result.toolCalls) && result.toolCalls.some(call => toolFailed(call.result));
}
