export const SMOKE_TEST_MESSAGE = "PromptTrace is active.";

export function getSmokeTestMessage(isEnabled: boolean): string {
  return isEnabled ? SMOKE_TEST_MESSAGE : "PromptTrace is disabled in settings.";
}
