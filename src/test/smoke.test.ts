import assert from "node:assert/strict";
import test from "node:test";

import { getSmokeTestMessage, SMOKE_TEST_MESSAGE } from "../smoke";

void test("smoke command reports an active extension when enabled", () => {
  assert.equal(getSmokeTestMessage(true), SMOKE_TEST_MESSAGE);
});

void test("smoke command explains when Plan Tracker is disabled", () => {
  assert.equal(
    getSmokeTestMessage(false),
    "Plan Tracker is disabled in settings.",
  );
});
