import ignore, { Ignore } from "ignore";

import { matchesAnyGlob } from "./glob";

export const DEFAULT_MARKDOWN_INCLUDES = ["**/*.md", "**/*.markdown"] as const;
export const BUILT_IN_SAFETY_EXCLUDES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/.plan-tracker/**",
  "**/.vscode-test/**",
] as const;

export interface ScopeMatcherOptions {
  ignoreText?: string;
  includes?: readonly string[];
  excludes?: readonly string[];
}

/** Applies all capture and display scope rules to workspace-relative paths. */
export class ScopeMatcher {
  private readonly ignores: Ignore;
  private readonly includes: readonly string[];
  private readonly excludes: readonly string[];

  public constructor(options: ScopeMatcherOptions = {}) {
    this.includes = options.includes ?? DEFAULT_MARKDOWN_INCLUDES;
    this.excludes = options.excludes ?? [];
    this.ignores = ignore();
    const ignoreText = options.ignoreText ?? "";
    if (ignoreText.includes("\0")) {
      throw new Error("NUL characters are not supported in .plantrackerignore rules.");
    }
    this.ignores.add(ignoreText);
  }

  public includesPath(relativePath: string): boolean {
    const normalized = normalizeScopePath(relativePath);
    if (normalized.length === 0 || normalized === ".plantrackerignore") {
      return false;
    }
    if (!/\.(?:md|markdown)$/iu.test(normalized)) {
      return false;
    }
    if (!matchesAnyGlob(normalized, this.includes)) {
      return false;
    }
    if (matchesAnyGlob(normalized, BUILT_IN_SAFETY_EXCLUDES)
      || matchesAnyGlob(normalized, this.excludes)) {
      return false;
    }
    return !this.ignores.ignores(normalized);
  }
}

export function normalizeScopePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}
