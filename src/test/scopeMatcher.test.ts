import assert from "node:assert/strict";
import test from "node:test";

import { ScopeMatcher } from "../scopeMatcher";

void test("supports comments, blank lines, and escaped leading rule prefixes", () => {
  const matcher = new ScopeMatcher({ ignoreText: "\n# comment\n\\#draft.md\n\\!important.md\n" });
  assert.equal(matcher.includesPath("ordinary.md"), true);
  assert.equal(matcher.includesPath("#draft.md"), false);
  assert.equal(matcher.includesPath("!important.md"), false);
});

void test("matches exact files, root-anchored paths, and nested directory rules", () => {
  const matcher = new ScopeMatcher({ ignoreText: "notes/private.md\n/archive/*.md\n**/generated/\n" });
  assert.equal(matcher.includesPath("notes/private.md"), false);
  assert.equal(matcher.includesPath("other/notes/private.md"), true);
  assert.equal(matcher.includesPath("archive/old.md"), false);
  assert.equal(matcher.includesPath("nested/archive/old.md"), true);
  assert.equal(matcher.includesPath("generated/root.md"), false);
  assert.equal(matcher.includesPath("docs/generated/nested.md"), false);
});

void test("supports wildcards, last-match ordering, and re-inclusion", () => {
  const matcher = new ScopeMatcher({ ignoreText: "/archive/*.md\n!/archive/keep.md\ndraft?.md\n" });
  assert.equal(matcher.includesPath("archive/drop.md"), false);
  assert.equal(matcher.includesPath("archive/keep.md"), true);
  assert.equal(matcher.includesPath("draft1.md"), false);
  assert.equal(matcher.includesPath("draft-long.md"), true);
});

void test("normalizes Windows separators and isolates rules between workspace matchers", () => {
  const firstRoot = new ScopeMatcher({ ignoreText: "private/\n" });
  const secondRoot = new ScopeMatcher();
  assert.equal(firstRoot.includesPath("private\\plan.md"), false);
  assert.equal(secondRoot.includesPath("private\\plan.md"), true);
});

void test("built-in safety exclusions cannot be negated and scope stays Markdown-only", () => {
  const matcher = new ScopeMatcher({ ignoreText: "!node_modules/keep.md\n!notes.txt\n" });
  assert.equal(matcher.includesPath("node_modules/keep.md"), false);
  assert.equal(matcher.includesPath("notes.txt"), false);
  assert.equal(matcher.includesPath("notes.md"), true);
  assert.equal(matcher.includesPath(".plantrackerignore"), false);
});

void test("rejects unsupported NUL characters", () => {
  assert.throws(() => new ScopeMatcher({ ignoreText: "bad\0rule.md" }), /NUL/u);
});
