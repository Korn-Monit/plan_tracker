export const SMOKE_TEST_MESSAGE = "Plan Tracker is active.";

export function getSmokeTestMessage(isEnabled: boolean): string {
  return isEnabled ? SMOKE_TEST_MESSAGE : "Plan Tracker is disabled in settings.";
}
