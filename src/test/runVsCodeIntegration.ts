import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  delete process.env["ELECTRON_RUN_AS_NODE"];
  const projectRoot = path.resolve(__dirname, "../..");
  const testRoot = path.join(projectRoot, ".vscode-test");
  const workspacePath = path.join(testRoot, "phase1-workspace");
  const userDataPath = path.join(testRoot, "phase1-profile");
  const extensionTestsPath = path.join(__dirname, "vscode.integration.js");
  await rm(userDataPath, { recursive: true, force: true });
  await rm(workspacePath, { recursive: true, force: true });
  await mkdir(path.join(workspacePath, "node_modules"), { recursive: true });
  await writeFile(path.join(workspacePath, "baseline.md"), "baseline\n", "utf8");
  await writeFile(path.join(workspacePath, "node_modules", "excluded.md"), "must not be captured\n", "utf8");

  for (const phase of ["capture", "restart"]) {
    await runTests({
      extensionDevelopmentPath: projectRoot,
      extensionTestsPath,
      extensionTestsEnv: { PROMPTTRACE_TEST_PHASE: phase },
      launchArgs: [workspacePath, "--disable-workspace-trust", `--user-data-dir=${userDataPath}`],
    });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
