import assert from "node:assert/strict";
import test from "node:test";

import { matchesAnyGlob } from "../glob";

void test("Markdown include globs match root and nested files", () => {
  const globs = ["**/*.md", "**/*.markdown"];
  assert.equal(matchesAnyGlob("README.md", globs), true);
  assert.equal(matchesAnyGlob("docs/plan.markdown", globs), true);
  assert.equal(matchesAnyGlob("docs/plan.txt", globs), false);
});

void test("exclusion globs match complete directory segments", () => {
  const globs = ["**/node_modules/**", "**/.plan-tracker/**"];
  assert.equal(matchesAnyGlob("node_modules/pkg/README.md", globs), true);
  assert.equal(matchesAnyGlob("app/node_modules/pkg/README.md", globs), true);
  assert.equal(matchesAnyGlob("docs/node_modules-notes.md", globs), false);
  assert.equal(matchesAnyGlob(".plan-tracker/index.md", globs), true);
});
