import { deepStrictEqual, ok, rejects, throws } from "node:assert/strict";
import { dirname, join } from "node:path";
import { parseIncrementalArgs } from "./incremental-build.ts";

const project = new URL("../", import.meta.url).pathname;
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
];

async function command(
  executable: string,
  args: string[],
  cwd = project,
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

Deno.test("Justfile and all nine package modules: default and explicit forwarding (9x3x2)", async () => {
  for (const name of names) {
    const defaultBuild = await command("just", ["--dry-run", `${name}::build`]);
    ok(defaultBuild.includes(`./packages/${name}/build.ts 'trixie' 'all'`));
    for (const arch of ["amd64", "arm64"]) {
      for (const suite of ["bookworm", "trixie", "forky"]) {
        const build = await command("just", [
          "--dry-run",
          `${name}::build`,
          suite,
          arch,
        ]);
        const preflight =
          `./scripts/build-targets.ts --build '${suite}' '${arch}'`;
        const setup = `just setup-${
          ["d2", "lazygit"].includes(name) ? "go" : "rust"
        } '${arch}'`;
        ok(build.includes(preflight));
        ok(build.indexOf(preflight) < build.indexOf(setup));
        ok(build.includes(`./packages/${name}/build.ts '${suite}' '${arch}'`));
      }
      const all = await command("just", [
        "--dry-run",
        `${name}::build-all`,
        arch,
      ]);
      for (const suite of ["bookworm", "trixie", "forky"]) {
        ok(all.includes(`just ${name}::build ${suite} '${arch}'`));
      }
    }
  }
  for (const arch of ["all", "amd64", "arm64"]) {
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
  // Shell interpolation must not turn malformed input into commands.
  const malformed = await command("just", [
    "--dry-run",
    "d2::build",
    "trixie",
    "arm64; echo unsafe",
  ]);
  ok(malformed.includes("'arm64; echo unsafe'"));
  for (
    const args of [["all", "amd64"], ["trixie", "armhf"], [
      "--build-all",
      "amd64",
    ]]
  ) {
    const invalid = await new Deno.Command("just", {
      args: ["d2::build", ...args],
      cwd: project,
      stdout: "piped",
      stderr: "piped",
    }).output();
    ok(!invalid.success);
    const output = new TextDecoder().decode(invalid.stderr);
    ok(output.includes("Unsupported"), output);
    ok(
      !output.includes("just setup-go"),
      "invalid suite/arch must fail before setup",
    );
  }
});

Deno.test("incremental-build: real entrypoint forwards targets serially, dry-run needs no chroots", async () => {
  const denoInfo = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output();
  const denoDir = JSON.parse(new TextDecoder().decode(denoInfo.stdout)).denoDir;
  const root = await Deno.makeTempDir({ prefix: "aptrepo-cli-test-" });
  try {
    for (const path of ["scripts", "packages", "toolchains"]) {
      await command("cp", ["-R", join(project, path), root]);
    }
    const bin = join(root, "bin");
    await Deno.mkdir(bin);
    const log = join(root, "calls");
    for (
      const [name, body] of Object.entries({
        git: "printf 'scripts/package-build.ts\\n'",
        dpkg: "echo amd64",
        just: `printf '%s\\n' "$*" >> '${log}'`,
      })
    ) {
      const path = join(bin, name);
      await Deno.writeTextFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
      await Deno.chmod(path, 0o755);
    }
    const env = {
      PATH: `${bin}:${Deno.env.get("PATH")}`,
      DENO_DIR: denoDir,
      XDG_CACHE_HOME: join(root, "cache"),
    };
    for (const arch of ["all", "amd64", "arm64"]) {
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
  const info = JSON.parse(
    await command(Deno.execPath(), ["info", "--json"]),
  );
  const root = await Deno.makeTempDir({
    prefix: "aptrepo-proc-entrypoint-test-",
  });
  try {
    for (const path of ["scripts", "packages", "toolchains"]) {
      await command("cp", ["-R", join(project, path), root]);
    }
    const bin = join(root, "bin");
    await Deno.mkdir(bin);
    await Deno.symlink(Deno.execPath(), join(bin, "deno"));
    await Deno.symlink("/usr/bin/dirname", join(bin, "dirname"));
    const cache = join(root, "cache");
    await Deno.mkdir(join(cache, "sbuild"), { recursive: true });
    for (const suite of ["bookworm", "trixie", "forky"]) {
      for (const arch of ["amd64", "arm64"]) {
        await Deno.writeTextFile(
          join(cache, "sbuild", `${suite}-${arch}.tar.zst`),
          "fixture only, never open as a chroot",
        );
      }
    }
    const log = join(root, "calls");
    const install = async (name: string, body: string) => {
      const path = join(bin, name);
      await Deno.writeTextFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
      await Deno.chmod(path, 0o755);
    };
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
        const target = host === "amd64" ? "arm64" : "amd64";
        const emulator = host === "amd64" ? "qemu-aarch64" : "qemu-x86_64";
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
/proc/sys/fs/binfmt_misc/${emulator})
  echo ${failure === "disabled-registration" ? "disabled" : "enabled"}
  echo 'flags: ${failure === "missing-F" ? "PO" : "POF"}';;
*) exit 94;;
esac`,
        );
        await install(
          "arch-test",
          `test "$#" = 1\ntest "$1" = ${target}
printf 'arch-test %s\\n' "$1" >> "$PROBE_LOG"
${failure === "arch-test-failure" ? "exit 95" : "echo ok"}`,
        );
        if (failure === "missing-cat") await Deno.remove(join(bin, "cat"));
        if (failure === "missing-arch-test" || failure === "missing-cat") {
          await Deno.remove(join(bin, "arch-test"));
        }
        const result = await new Deno.Command(join(root, entrypoint), {
          args,
          cwd: root,
          clearEnv: true,
          env: {
            HOME: root,
            XDG_CACHE_HOME: cache,
            DENO_DIR: info.denoDir,
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

const arm64Probes = [
  "cat /proc/sys/fs/binfmt_misc/status",
  "cat /proc/sys/fs/binfmt_misc/qemu-aarch64",
  "arch-test arm64",
];

Deno.test("build-targets: actual restricted shebang probes both mappings and bypasses native", async () => {
  await withPreflightEntrypoints(async ({ invoke }) => {
    for (const host of ["amd64", "arm64"] as const) {
      const target = host === "amd64" ? "arm64" : "amd64";
      const foreign = await invoke(
        "scripts/build-targets.ts",
        ["--setup", "trixie", target],
        { host },
      );
      ok(foreign.success, foreign.output);
      deepStrictEqual(foreign.output.trim(), target);
      deepStrictEqual(foreign.calls, [
        arm64Probes[0],
        `cat /proc/sys/fs/binfmt_misc/${
          host === "amd64" ? "qemu-aarch64" : "qemu-x86_64"
        }`,
        `arch-test ${target}`,
      ]);
      const native = await invoke(
        "scripts/build-targets.ts",
        ["--setup", "trixie", host],
        { host, failure: "missing-cat" },
      );
      ok(native.success, native.output);
      deepStrictEqual(native.output.trim(), host);
      deepStrictEqual(native.calls, []);
    }
  });
});

Deno.test("incremental-build: actual restricted importer preflights default all before dispatch", async () => {
  await withPreflightEntrypoints(async ({ invoke }) => {
    const incremental = await invoke("scripts/incremental-build.ts", [
      "yesterday",
    ]);
    ok(incremental.success, incremental.output);
    deepStrictEqual(incremental.calls, [
      ...arm64Probes,
      ...[...names].sort().map((name) => `just ${name}::build-all all`),
    ]);
  });
});

Deno.test("d2: actual restricted importer preflights default all before toolchain checks", async () => {
  await withPreflightEntrypoints(async ({ invoke }) => {
    const pkg = await invoke("packages/d2/build.ts", []);
    ok(!pkg.success, pkg.output);
    ok(pkg.output.includes("Missing Go build toolchain"), pkg.output);
    ok(!pkg.output.includes("Cannot execute"), pkg.output);
    ok(!pkg.output.includes("NotCapable"), pkg.output);
    deepStrictEqual(pkg.calls, arm64Probes);
  });
});

Deno.test("build-targets, incremental-build, d2 and setup-sbuild: real preflight fails closed", async () => {
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
      for (
        const [entrypoint, args] of [
          ["scripts/build-targets.ts", ["--setup", "trixie", "all"]],
          ["scripts/incremental-build.ts", ["yesterday"]],
          ["packages/d2/build.ts", []],
          ["scripts/setup-sbuild", ["trixie", "all"]],
        ] as const
      ) {
        const result = await invoke(entrypoint, [...args], { failure });
        const context = `${entrypoint} ${failure}: ${result.output}`;
        ok(!result.success, context);
        ok(result.output.includes("Cannot execute arm64 in sbuild"), context);
        ok(
          result.output.includes(
            "with the F flag, then check: arch-test arm64",
          ),
          context,
        );
        ok(!result.output.includes("Missing Go build toolchain"), context);
        ok(!result.output.includes("NotCapable"), context);
        const count = failure === "missing-cat"
          ? 0
          : failure === "cat-failure"
          ? 1
          : failure === "arch-test-failure"
          ? 3
          : 2;
        // Exact trace also rules out arch-test on invalid registration, Just
        // dispatch (including native target 1), and any shell setup work.
        deepStrictEqual(result.calls, arm64Probes.slice(0, count), context);
      }
    }
  });
});
