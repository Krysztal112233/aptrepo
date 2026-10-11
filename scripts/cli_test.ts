import { deepStrictEqual, ok, rejects, throws } from "node:assert/strict";
import { dirname, join } from "node:path";
import { parseIncrementalArgs } from "./incremental-build.ts";
import { denoDir, makeSandbox, projectRoot } from "./test-harness.ts";

const names = [
  "lazygit",
  "himalaya",
  "starship",
  "zellij",
  "mdbook",
  "uv",
  "just",
  "sccache",
  "d2",
  "neovim",
  "gix",
  "gleam",
];

async function command(
  executable: string,
  args: string[],
  cwd = projectRoot,
  env?: Record<string, string>,
) {
  const result = await new Deno.Command(executable, {
    args,
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const output = new TextDecoder().decode(result.stdout) +
    new TextDecoder().decode(result.stderr);
  ok(result.success, output);
  return output;
}

Deno.test("incremental-build: preserve since/dry-run order and validate all arguments", () => {
  deepStrictEqual(parseIncrementalArgs([]), {
    since: "24 hours ago",
    selection: "all",
    dryRun: false,
  });
  for (
    const args of [["yesterday", "arm64", "--dry-run"], [
      "--dry-run",
      "yesterday",
      "arm64",
    ]]
  ) {
    deepStrictEqual(parseIncrementalArgs(args), {
      since: "yesterday",
      selection: "arm64",
      dryRun: true,
    });
  }
  for (
    const args of [["today", "bad"], ["--unknown"], ["today", "all", "extra"], [
      "--dry-run",
      "--dry-run",
    ]]
  ) {
    throws(() => parseIncrementalArgs(args));
  }
});

Deno.test("Justfile and all twelve package modules: default and explicit forwarding", async () => {
  for (const name of names) {
    const defaultBuild = await command("just", ["--dry-run", `${name}::build`]);
    ok(defaultBuild.includes(`./packages/${name}/build.ts 'trixie' 'all'`));
    for (const arch of ["amd64", "arm64", "riscv64"]) {
      for (const suite of ["bookworm", "trixie", "forky"]) {
        if (arch === "riscv64" && suite === "bookworm") continue;
        const build = await command("just", [
          "--dry-run",
          `${name}::build`,
          suite,
          arch,
        ]);
        const preflight =
          `./scripts/build-targets.ts --build '${suite}' '${arch}'`;
        const setup = name === "neovim"
          ? null
          : `just setup-${
            ["d2", "lazygit"].includes(name) ? "go" : "rust"
          } '${arch}'`;
        ok(build.includes(preflight));
        if (setup === null) {
          // The system toolchain takes its build tools from the chroot and
          // has no setup-* recipe.
          ok(!build.includes("setup-"));
        } else {
          ok(build.indexOf(preflight) < build.indexOf(setup));
        }
        ok(build.includes(`./packages/${name}/build.ts '${suite}' '${arch}'`));
      }
      const all = await command("just", [
        "--dry-run",
        `${name}::build-all`,
        arch,
      ]);
      ok(all.includes(`./scripts/build-targets.ts --build-all '${arch}'`));
      ok(all.includes(`./scripts/build-targets.ts --suites '${arch}'`));
      ok(all.includes(`just ${name}::build "$suite" '${arch}'`));
    }
  }
  for (const arch of ["all", "amd64", "arm64", "riscv64"]) {
    const all = await command("just", ["--dry-run", "build-all", arch]);
    for (const name of names) {
      ok(all.includes(`just ${name}::build-all '${arch}'`));
    }
    ok(all.indexOf("build-targets.ts") < all.indexOf("lazygit::build-all"));
    for (const recipe of ["build-changed", "build-changed-dry"]) {
      const output = await command("just", [
        "--dry-run",
        recipe,
        "2 days ago",
        arch,
      ]);
      ok(
        output.includes(
          `./scripts/incremental-build.ts '2 days ago' '${arch}'`,
        ),
      );
      deepStrictEqual(output.includes("--dry-run"), recipe.endsWith("-dry"));
    }
    for (const kind of ["go", "rust"]) {
      ok(
        (await command("just", ["--dry-run", `setup-${kind}`, arch])).includes(
          `./scripts/setup-${kind}.ts '${arch}'`,
        ),
      );
    }
    ok(
      (await command("just", ["--dry-run", "setup-sbuild", "trixie", arch]))
        .includes(`./scripts/setup-sbuild 'trixie' '${arch}'`),
    );
  }
  const setupAll = await command("just", [
    "--dry-run",
    "setup-sbuild-all",
    "riscv64",
  ]);
  ok(setupAll.includes(`./scripts/build-targets.ts --setup-all 'riscv64'`));
  ok(setupAll.includes(`./scripts/build-targets.ts --suites 'riscv64'`));
  ok(setupAll.includes(`just setup-sbuild "$suite" 'riscv64'`));
  for (const args of [[], ["all"], ["d2"]]) {
    const expected = args[0] ?? "all";
    ok(
      (await command("just", ["--dry-run", "check-updates", ...args]))
        .includes(`./scripts/check-updates.ts '${expected}'`),
    );
  }
  // Shell interpolation must not turn malformed input into commands.
  const malformed = await command("just", [
    "--dry-run",
    "d2::build",
    "trixie",
    "arm64; echo unsafe",
  ]);
  ok(malformed.includes("'arm64; echo unsafe'"));
  const malformedUpdates = await command("just", [
    "--dry-run",
    "check-updates",
    "d2; echo unsafe",
  ]);
  ok(malformedUpdates.includes("'d2; echo unsafe'"));
  for (
    const args of [["all", "amd64"], ["trixie", "armhf"], [
      "--build-all",
      "amd64",
    ], ["bookworm", "riscv64"]]
  ) {
    const invalid = await new Deno.Command("just", {
      args: ["d2::build", ...args],
      cwd: projectRoot,
      stdout: "piped",
      stderr: "piped",
    }).output();
    ok(!invalid.success);
    const output = new TextDecoder().decode(invalid.stderr);
    ok(
      output.includes("Unsupported") || output.includes("not supported"),
      output,
    );
    ok(
      !output.includes("just setup-go"),
      "invalid suite/arch must fail before setup",
    );
  }
});

Deno.test("incremental-build: real entrypoint forwards targets serially, dry-run needs no chroots", async () => {
  const sandbox = await makeSandbox("aptrepo-cli-test-", [
    "scripts",
    "packages",
    "toolchains",
  ]);
  const { root, bin } = sandbox;
  try {
    const log = join(root, "calls");
    for (
      const [name, body] of Object.entries({
        git: "printf 'scripts/package-build.ts\\n'",
        dpkg: "echo amd64",
        just: `printf '%s\\n' "$*" >> '${log}'`,
      })
    ) {
      await sandbox.installSh(name, body);
    }
    const env = {
      PATH: `${bin}:${Deno.env.get("PATH")}`,
      DENO_DIR: await denoDir(),
      XDG_CACHE_HOME: join(root, "cache"),
    };
    for (const arch of ["all", "amd64"]) {
      const output = await command(
        Deno.execPath(),
        [
          "run",
          "--cached-only",
          "--allow-env=HOME,XDG_CACHE_HOME",
          "--allow-read",
          "--allow-run",
          "scripts/incremental-build.ts",
          "yesterday",
          arch,
          "--dry-run",
        ],
        root,
        env,
      );
      for (const name of names) {
        ok(output.includes(`Would run: just ${name}::build-all ${arch}`));
      }
    }
    for (const suite of ["bookworm", "trixie", "forky"]) {
      const path = join(env.XDG_CACHE_HOME, `sbuild/${suite}-amd64.tar.zst`);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, "fixture");
    }
    await command(
      Deno.execPath(),
      [
        "run",
        "--cached-only",
        "--allow-env=HOME,XDG_CACHE_HOME",
        "--allow-read",
        "--allow-run",
        "scripts/incremental-build.ts",
        "yesterday",
        "amd64",
      ],
      root,
      env,
    );
    deepStrictEqual(
      (await Deno.readTextFile(log)).trim().split("\n"),
      [...names].sort().map((name) => `${name}::build-all amd64`),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// Run unchanged shebangs against real Deno, with only deterministic fixture
// commands on PATH. No injected preflight/runtime and no host binfmt dependency.
type ProbeFailure =
  | "disabled-status"
  | "disabled-registration"
  | "missing-F"
  | "cat-failure"
  | "missing-cat"
  | "missing-arch-test"
  | "arch-test-failure";

async function withPreflightEntrypoints(
  test: (fixture: {
    invoke: (
      entrypoint: string,
      args: string[],
      options?: { host?: "amd64" | "arm64"; failure?: ProbeFailure },
    ) => Promise<{ success: boolean; output: string; calls: string[] }>;
  }) => Promise<void>,
) {
  const sandbox = await makeSandbox("aptrepo-proc-entrypoint-test-", [
    "scripts",
    "packages",
    "toolchains",
  ]);
  const { root, bin } = sandbox;
  const sharedDenoDir = await denoDir();
  try {
    await Deno.symlink(Deno.execPath(), join(bin, "deno"));
    await Deno.symlink("/usr/bin/dirname", join(bin, "dirname"));
    const cache = join(root, "cache");
    await Deno.mkdir(join(cache, "sbuild"), { recursive: true });
    for (const suite of ["bookworm", "trixie", "forky"]) {
      for (
        const arch of suite === "bookworm"
          ? ["amd64", "arm64"]
          : ["amd64", "arm64", "riscv64"]
      ) {
        await Deno.writeTextFile(
          join(cache, "sbuild", `${suite}-${arch}.tar.zst`),
          "fixture only, never open as a chroot",
        );
      }
    }
    const log = join(root, "calls");
    const install = sandbox.installSh;
    await install(
      "git",
      'case "$1" in log) printf "scripts/package-build.ts\\n";; status) :;; *) exit 91;; esac',
    );
    await install(
      "just",
      'test "$#" = 2\nprintf "just %s\\n" "$*" >> "$PROBE_LOG"',
    );
    // Negative shell setup cases must stop before even creating a directory.
    for (const name of ["mkdir", "mktemp", "unshare", "mmdebstrap"]) {
      await install(
        name,
        `printf 'forbidden ${name}\\n' >> "$PROBE_LOG"\nexit 92`,
      );
    }
    await test({
      async invoke(entrypoint, args, { host = "amd64", failure } = {}) {
        const foreigners = host === "amd64"
          ? ["arm64", "riscv64"]
          : ["amd64", "riscv64"];
        const emulatorPaths = host === "amd64"
          ? [
            "/proc/sys/fs/binfmt_misc/qemu-aarch64",
            "/proc/sys/fs/binfmt_misc/qemu-riscv64",
          ]
          : [
            "/proc/sys/fs/binfmt_misc/qemu-x86_64",
            "/proc/sys/fs/binfmt_misc/qemu-riscv64",
          ];
        await Deno.writeTextFile(log, "");
        await install(
          "dpkg",
          `test "$#" = 1\ntest "$1" = --print-architecture\necho ${host}`,
        );
        await install(
          "cat",
          `test "$#" = 1
printf 'cat %s\\n' "$1" >> "$PROBE_LOG"
case "$1" in
/proc/sys/fs/binfmt_misc/status)
  ${failure === "cat-failure" ? "exit 93" : ":"}
  echo ${failure === "disabled-status" ? "disabled" : "enabled"};;
${emulatorPaths.join("|")})
  echo ${failure === "disabled-registration" ? "disabled" : "enabled"}
  echo 'flags: ${failure === "missing-F" ? "PO" : "POF"}';;
*) exit 94;;
esac`,
        );
        await install(
          "arch-test",
          `test "$#" = 1
case "$1" in ${foreigners.join("|")}) ;; *) exit 96;; esac
printf 'arch-test %s\\n' "$1" >> "$PROBE_LOG"
${failure === "arch-test-failure" ? "exit 95" : "echo ok"}`,
        );
        if (failure === "missing-cat") await Deno.remove(join(bin, "cat"));
        if (failure === "missing-arch-test") {
          await Deno.remove(join(bin, "arch-test"));
        }
        const result = await new Deno.Command(join(root, entrypoint), {
          args,
          cwd: root,
          clearEnv: true,
          env: {
            HOME: root,
            XDG_CACHE_HOME: cache,
            DENO_DIR: sharedDenoDir,
            DENO_NO_UPDATE_CHECK: "1",
            DENO_NO_PROMPT: "1",
            PATH: bin,
            PROBE_LOG: log,
          },
          stdout: "piped",
          stderr: "piped",
        }).output();
        const output = new TextDecoder().decode(result.stdout) +
          new TextDecoder().decode(result.stderr);
        const calls = (await Deno.readTextFile(log)).trim();
        return {
          success: result.success,
          output,
          calls: calls ? calls.split("\n") : [],
        };
      },
    });
    // The real package path must stop at missing toolchains, before downloads,
    // output creation, or compilation, even when foreign preflight succeeds.
    await rejects(Deno.stat(join(root, "build")), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("build-targets entrypoint: rejects foreign selections and bypasses binfmt probes for native builds", async () => {
  await withPreflightEntrypoints(async ({ invoke }) => {
    for (const host of ["amd64", "arm64"] as const) {
      // arm64 and riscv64 are outside the amd64-only build matrix on any
      // host and must be rejected before any binfmt probing.
      for (const target of ["arm64", "riscv64"] as const) {
        const foreign = await invoke(
          "scripts/build-targets.ts",
          ["--setup", "trixie", target],
          { host },
        );
        ok(!foreign.success, foreign.output);
        ok(
          foreign.output.includes("not supported"),
          foreign.output,
        );
        deepStrictEqual(foreign.calls, []);
      }
    }
    // amd64 is the only build-matrix architecture: native on an amd64 host
    // (no binfmt probes) and a foreign cross-selection on an arm64 host.
    const native = await invoke(
      "scripts/build-targets.ts",
      ["--setup", "trixie", "amd64"],
      { host: "amd64", failure: "missing-cat" },
    );
    ok(native.success, native.output);
    deepStrictEqual(native.output.trim(), "amd64");
    deepStrictEqual(native.calls, []);
    const cross = await invoke(
      "scripts/build-targets.ts",
      ["--setup", "trixie", "amd64"],
      { host: "arm64" },
    );
    ok(cross.success, cross.output);
    deepStrictEqual(cross.output.trim(), "amd64");
    deepStrictEqual(cross.calls, [
      "cat /proc/sys/fs/binfmt_misc/status",
      "cat /proc/sys/fs/binfmt_misc/qemu-x86_64",
      "arch-test amd64",
    ]);
  });
});

Deno.test("incremental-build entrypoint: preflights the default selection before dispatch", async () => {
  await withPreflightEntrypoints(async ({ invoke }) => {
    const incremental = await invoke("scripts/incremental-build.ts", [
      "yesterday",
    ]);
    ok(incremental.success, incremental.output);
    deepStrictEqual(incremental.calls, [
      ...[...names].sort().map((name) => `just ${name}::build-all all`),
    ]);
  });
});

Deno.test("d2 entrypoint: preflights the default selection before toolchain checks", async () => {
  await withPreflightEntrypoints(async ({ invoke }) => {
    const pkg = await invoke("packages/d2/build.ts", []);
    ok(!pkg.success, pkg.output);
    ok(pkg.output.includes("Missing Go build toolchain"), pkg.output);
    ok(!pkg.output.includes("Cannot execute"), pkg.output);
    ok(!pkg.output.includes("NotCapable"), pkg.output);
    deepStrictEqual(pkg.calls, []);
  });
});

Deno.test("build-targets, incremental-build, d2 and setup-sbuild: foreign selections rejected before any probe runs", async () => {
  await withPreflightEntrypoints(async ({ invoke }) => {
    const failures: ProbeFailure[] = [
      "disabled-status",
      "disabled-registration",
      "missing-F",
      "cat-failure",
      "missing-cat",
      "missing-arch-test",
      "arch-test-failure",
    ];
    for (const failure of failures) {
      // Every probe is broken, but the amd64-only build matrix must reject
      // foreign selections before any of them run.
      for (
        const [entrypoint, args] of [
          ["scripts/build-targets.ts", ["--setup", "trixie", "arm64"]],
          ["scripts/incremental-build.ts", ["yesterday", "arm64"]],
          ["packages/d2/build.ts", ["trixie", "arm64"]],
          ["scripts/setup-sbuild", ["trixie", "arm64"]],
        ] as const
      ) {
        const result = await invoke(entrypoint, [...args], { failure });
        const context = `${entrypoint} ${failure}: ${result.output}`;
        ok(!result.success, context);
        ok(/architecture arm64/i.test(result.output), context);
        ok(!result.output.includes("Missing Go build toolchain"), context);
        ok(!result.output.includes("NotCapable"), context);
        deepStrictEqual(result.calls, [], context);
      }
    }
  });
});
