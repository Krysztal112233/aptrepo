import { ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { loadPackageConfig } from "./config.ts";
import { denoDir, makeSandbox } from "./test-harness.ts";

Deno.test("check-updates: snapshot discovery is read-only and fails closed", async () => {
  const sandbox = await makeSandbox("aptrepo-snapshot-updates-test-", [
    "scripts",
    "packages",
  ]);
  const { root, bin } = sandbox;
  try {
    const configPath = join(root, "packages/wezterm/package.toml");
    const before = await Deno.readTextFile(configPath);
    const config = await loadPackageConfig(join(root, "packages/wezterm"));
    const source = config.source;
    ok(source.kind === "commit");
    const refsPath = join(root, "refs");
    const failurePath = join(root, "fail");
    // The real entrypoint must query only this exact branch, not tags or HEAD.
    await sandbox.installSh(
      "git",
      `
test "$#" = 5
test "$1" = ls-remote
test "$2" = --heads
test "$3" = --refs
test "$4" = '${source.git}'
test "$5" = 'refs/heads/${source.updateBranch}'
if test -f '${failurePath}'; then exit 71; fi
cat '${refsPath}'
`,
    );
    const env = {
      PATH: `${bin}:${Deno.env.get("PATH")}`,
      DENO_DIR: await denoDir(),
      HOME: root,
      XDG_CACHE_HOME: join(root, "cache"),
    };
    const invoke = async () => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--cached-only",
          "--allow-env=HOME,XDG_CACHE_HOME",
          "--allow-read",
          "--allow-run",
          "scripts/check-updates.ts",
          "wezterm",
        ],
        cwd: root,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        success: result.success,
        output: new TextDecoder().decode(result.stdout) +
          new TextDecoder().decode(result.stderr),
      };
    };
    const writeHead = (sha: string) =>
      Deno.writeTextFile(
        refsPath,
        `${sha}\trefs/heads/${source.updateBranch}\n`,
      );
    await writeHead(source.ref);
    const current = await invoke();
    ok(current.success, current.output);
    ok(current.output.includes(`[${source.updateBranch}]`), current.output);
    ok(current.output.includes("up to date"), current.output);
    ok(!current.output.includes("->"), current.output);

    const candidate = "1".repeat(40);
    await writeHead(candidate);
    const update = await invoke();
    ok(update.success, update.output);
    ok(update.output.includes(`${source.ref} -> ${candidate}`), update.output);
    ok(update.output.includes("branch head differs"), update.output);
    ok(
      update.output.includes(
        "0 updates available, 1 snapshot candidates, 0 problems",
      ),
      update.output,
    );

    for (const refs of ["", `${candidate}\trefs/heads/other\n`]) {
      await Deno.writeTextFile(refsPath, refs);
      const missing = await invoke();
      ok(!missing.success, missing.output);
      ok(missing.output.includes("branch missing upstream"), missing.output);
      ok(missing.output.includes("1 problems"), missing.output);
    }
    for (
      const refs of [
        `short\trefs/heads/${source.updateBranch}\n`,
        `${candidate}\trefs/heads/${source.updateBranch}\n`.repeat(2),
      ]
    ) {
      await Deno.writeTextFile(refsPath, refs);
      const malformed = await invoke();
      ok(!malformed.success, malformed.output);
      ok(
        malformed.output.includes("error: Invalid ls-remote response"),
        malformed.output,
      );
    }
    await Deno.writeTextFile(failurePath, "simulate network failure");
    const failed = await invoke();
    ok(!failed.success, failed.output);
    ok(failed.output.includes("error: git failed"), failed.output);
    strictEqual(await Deno.readTextFile(configPath), before);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
