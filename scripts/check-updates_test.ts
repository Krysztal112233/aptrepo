import { deepStrictEqual, ok, throws } from "node:assert/strict";
import { join } from "node:path";
import {
  classify,
  classifyCommit,
  parseBranchHead,
  parseTagRefs,
  stableTagPattern,
} from "./check-updates.ts";
import { denoDir, makeSandbox } from "./test-harness.ts";

Deno.test("check-updates: tag template compiles to a version-tag matcher", () => {
  const vPrefixed = stableTagPattern("v{version}");
  ok(vPrefixed.test("v0.66.0"));
  ok(!vPrefixed.test("gix-v0.66.0"));
  ok(!vPrefixed.test("nightly"));

  const bare = stableTagPattern("{version}");
  ok(bare.test("0.12.9"));
  ok(!bare.test("v0.12.9"));
  // Date-shaped tags (wezterm) match the loose version shape; per-crate
  // tags starting with letters do not.
  ok(bare.test("20240203-110809-5046fc22"));
  ok(!bare.test("wezterm-ssh-0.3.0"));

  throws(() => stableTagPattern("{tag}"));
  throws(() => stableTagPattern("v{version}{version}"));
});

Deno.test("check-updates: ls-remote output yields tag names only", () => {
  deepStrictEqual(
    parseTagRefs(
      "3dae1da7a2e4e5f6a7b8c9d0e1f2a3b4c5d6e7f8\trefs/tags/v0.59.0\n" +
        "fb742911d437e024e50f383da18da9c1a866b461\trefs/tags/gix-v0.59.0\n",
    ),
    ["v0.59.0", "gix-v0.59.0"],
  );
  deepStrictEqual(parseTagRefs(""), []);
  deepStrictEqual(parseTagRefs("garbage line\n"), []);
});

Deno.test("check-updates: classify by position in the version-sorted tag list", () => {
  const pattern = stableTagPattern("v{version}");
  deepStrictEqual(
    classify("v0.9.0", ["v0.9.0", "v0.8.0"], pattern),
    { latest: "v0.9.0", status: "up to date" },
  );
  deepStrictEqual(
    classify("v0.9.0", ["v0.10.0", "v0.9.0", "v0.8.0"], pattern),
    { latest: "v0.10.0", status: "update available" },
  );
  // Prereleases sort high but never count as the latest stable.
  deepStrictEqual(
    classify("v0.9.0", ["v0.10.0-rc.1", "v0.9.0"], pattern),
    { latest: "v0.9.0", status: "up to date" },
  );
  deepStrictEqual(
    classify(
      "0.12.9",
      ["0.13.0-beta.1", "0.12.9"],
      stableTagPattern("{version}"),
    ),
    { latest: "0.12.9", status: "up to date" },
  );
  // Date-shaped versions (wezterm) classify like any other series.
  deepStrictEqual(
    classify(
      "20240203-110809-5046fc22",
      ["20240203-110809-5046fc22", "20240128-202157-1e552d76"],
      stableTagPattern("{version}"),
    ),
    { latest: "20240203-110809-5046fc22", status: "up to date" },
  );
  // A pinned tag absent from the remote no longer has a commit there.
  deepStrictEqual(
    classify("v0.9.0", ["v0.10.0", "v0.8.0"], pattern),
    { latest: "v0.10.0", status: "tag missing upstream" },
  );
  deepStrictEqual(
    classify("v0.9.0", ["nightly"], pattern),
    { latest: null, status: "tag missing upstream" },
  );
});

Deno.test("check-updates: branch lookup matches one exact full-SHA ref", () => {
  const sha = "1".repeat(40);
  deepStrictEqual(
    parseBranchHead(
      `${"2".repeat(40)}\trefs/heads/main-old\n${sha}\trefs/heads/main\n`,
      "main",
    ),
    sha,
  );
  deepStrictEqual(parseBranchHead("", "main"), null);
  deepStrictEqual(parseBranchHead(`${sha}\trefs/tags/main`, "main"), null);
  throws(() => parseBranchHead("short\trefs/heads/main", "main"));
  throws(() => parseBranchHead(`${sha}\tgarbage\trefs/heads/main`, "main"));
  throws(() =>
    parseBranchHead(`${sha}\trefs/heads/main\n${sha}\trefs/heads/main`, "main")
  );
});

Deno.test("check-updates: a differing branch head is only a snapshot candidate", () => {
  const pinned = "1".repeat(40);
  const candidate = "2".repeat(40);
  deepStrictEqual(classifyCommit(pinned, pinned), {
    latest: pinned,
    status: "up to date",
  });
  deepStrictEqual(classifyCommit(pinned, candidate), {
    latest: candidate,
    status: "branch head differs",
  });
  deepStrictEqual(classifyCommit(pinned, null), {
    latest: null,
    status: "branch missing upstream",
  });
});

// The real entrypoint against a stub git: tag fixtures stand in for remotes.
Deno.test("check-updates: entrypoint classifies pinned tags end to end", async () => {
  const sandbox = await makeSandbox("aptrepo-updates-test-", [
    "scripts",
    "packages",
  ]);
  const { root, bin } = sandbox;
  const sharedDenoDir = await denoDir();
  try {
    const tagsPath = join(root, "tags");
    await sandbox.installSh("git", `cat '${tagsPath}'`);
    const env = {
      PATH: `${bin}:${Deno.env.get("PATH")}`,
      DENO_DIR: sharedDenoDir,
      HOME: root,
      XDG_CACHE_HOME: join(root, "cache"),
    };
    const invoke = async (...args: string[]) => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--cached-only",
          "--allow-env=HOME,XDG_CACHE_HOME",
          "--allow-read",
          "--allow-run",
          "scripts/check-updates.ts",
          ...args,
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
    // ls-remote hands us tags newest-first; fixtures must keep that contract.
    const writeTags = (tags: string[]) =>
      Deno.writeTextFile(
        tagsPath,
        tags.map((tag) => `${"0".repeat(40)}\trefs/tags/${tag}\n`).join(""),
      );

    // d2 pins v0.9.0.
    await writeTags(["v0.9.0", "v0.8.0"]);
    const current = await invoke("d2");
    ok(current.success, current.output);
    ok(current.output.includes("v0.9.0"), current.output);
    ok(current.output.includes("up to date"), current.output);
    ok(!current.output.includes("->"), current.output);

    await writeTags(["v0.10.0", "v0.9.0"]);
    const update = await invoke("d2");
    ok(update.success, update.output);
    ok(update.output.includes("v0.9.0 -> v0.10.0"), update.output);
    ok(update.output.includes("update available"), update.output);

    await writeTags(["v0.8.0"]);
    const missing = await invoke("d2");
    ok(!missing.success, missing.output);
    ok(missing.output.includes("tag missing upstream"), missing.output);

    const unknown = await invoke("nonexistent");
    ok(!unknown.success, unknown.output);
    ok(unknown.output.includes("Unknown package"), unknown.output);

    // The default selection covers every package directory.
    await writeTags(["v0.9.0"]);
    const all = await invoke();
    ok(!all.success, all.output);
    ok(all.output.includes("d2"), all.output);
    ok(all.output.includes("lazygit"), all.output);
    ok(all.output.includes("13 packages"), all.output);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
