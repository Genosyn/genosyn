import assert from "node:assert/strict";
import test from "node:test";
import { cloneWorkspaceGitRemote, fetchWorkspaceGitRemote } from "./workspaceGitRemote.js";

test("remote clone and fetch reject unsafe legacy URLs before filesystem access", async () => {
  const unsafeUrl = "https://user:plain-text-secret@git.example/acme/repo.git";
  const missingWorkspace = "/definitely/missing/genosyn-workspace";

  for (const operation of [
    () =>
      cloneWorkspaceGitRemote({
        workspaceRoot: missingWorkspace,
        destinationPath: `${missingWorkspace}/checkout`,
        remoteUrl: unsafeUrl,
      }),
    () =>
      fetchWorkspaceGitRemote({
        workspaceRoot: missingWorkspace,
        cwd: `${missingWorkspace}/checkout`,
        remoteUrl: unsafeUrl,
      }),
  ]) {
    await assert.rejects(operation, (error: Error) => {
      assert.match(error.message, /without embedded credentials or options/);
      assert.doesNotMatch(error.message, /plain-text-secret|git\.example/);
      return true;
    });
  }
});
