import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  delete process.env["ELECTRON_RUN_AS_NODE"];
  const projectRoot = path.resolve(__dirname, "../..");
  const extensionPath = process.argv[2] ?? projectRoot;
  const testRoot = path.join(projectRoot, ".vscode-test");
  const runId = `run-${process.pid}-${Date.now()}`;
  const workspacePath = path.join(testRoot, runId, "workspace");
  const userDataPath = path.join(testRoot, runId, "profile");
  const extensionTestsPath = path.join(__dirname, "vscode.integration.js");
  await rm(userDataPath, { recursive: true, force: true });
  await rm(workspacePath, { recursive: true, force: true });
  await mkdir(path.join(workspacePath, "node_modules"), { recursive: true });
  await writeFile(path.join(workspacePath, "baseline.md"), "baseline\n", "utf8");
  await writeFile(path.join(workspacePath, "node_modules", "excluded.md"), "must not be captured\n", "utf8");

  const phases = process.argv[3]?.split(",")
    ?? ["capture", "restart", "timeline", "attribution", "restore", "hardening"];
  for (const phase of phases) {
    await runTests({
      extensionDevelopmentPath: extensionPath,
      extensionTestsPath,
      extensionTestsEnv: { PLAN_TRACKER_TEST_PHASE: phase },
      launchArgs: [workspacePath, "--disable-workspace-trust", `--user-data-dir=${userDataPath}`],
    });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
