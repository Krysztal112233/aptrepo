import { deepStrictEqual, ok, rejects } from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPackage } from "./package-build.ts";
import { preflightBuild } from "./build-targets.ts";
import {
  type DebianArchitecture,
  loadGoToolchainConfig,
  loadRustToolchainConfig,
} from "./config.ts";
import { exists, run } from "./runtime.ts";
import {
  goDebPath,
  installedGoRoot,
  installedRustRoot,
  rustDebPath,
} from "./toolchains.ts";

async function touch(path: string, content = "fixture") {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
}

// Real source/debian/cache filesystem operations, but no download, compiler,
// dpkg-buildpackage or sbuild is executed. Unexpected subprocesses fail closed.
for (const kind of ["go", "rust"] as const) {
  for (const host of ["amd64", "arm64"] as const) {
    Deno.test(`package-build: ${kind} on ${host} vendors natively, builds all serially`, async () => {
      const root = await Deno.makeTempDir({ prefix: "aptrepo-build-test-" });
      try {
        const cache = join(root, "cache");
        const packageDir = join(root, "packages/fixture");
        await touch(
          join(packageDir, "package.toml"),
          `
[package]
name = "fixture"
version = "1.0"
debian_revision = "1"
[source]
git = "https://example.invalid/fixture"
tag = "v{version}"
archive = "https://example.invalid/fixture.tar.gz"
archive_root = "fixture-1.0"
sha256 = "${"a".repeat(64)}"
[build]
toolchain = "${kind}"
`,
        );
        await touch(join(packageDir, "debian/control.in"), "Source: fixture\n");
        await touch(
          join(packageDir, "debian/rules.in"),
          kind === "rust"
            ? "#!/usr/bin/make -f\n\n{{RUST_BUILD_TUNING}}\n"
            : "#!/usr/bin/make -f\n",
        );
        await touch(
          join(packageDir, "debian/changelog"),
          "fixture (1.0-1) UNRELEASED; urgency=medium\n",
        );
        await touch(
          join(root, `toolchains/${kind}.toml`),
          await Deno.readTextFile(
            new URL(`../toolchains/${kind}.toml`, import.meta.url),
          ),
        );
        const config = kind === "go"
          ? await loadGoToolchainConfig(root)
          : await loadRustToolchainConfig(root);
        const debPath = (arch: DebianArchitecture) =>
          config.kind === "go"
            ? goDebPath(root, arch, config)
            : rustDebPath(root, arch, config);
        const installedRoot = config.kind === "go"
          ? installedGoRoot(cache, host, config)
          : installedRustRoot(cache, host, config);
        // The only extracted executable is host-native. Targets have only .debs.
        const vendor = join(
          installedRoot,
          config.installPrefix.slice(1),
          `bin/${kind === "go" ? "go" : "cargo"}`,
        );
        await touch(vendor);
        for (const arch of ["amd64", "arm64", "riscv64"] as const) {
          await touch(debPath(arch));
          await touch(join(cache, `sbuild/trixie-${arch}.tar.zst`));
        }
        const events: string[] = [];
        const vendors: string[] = [];
        let building = false;
        const runtime = {
          hostArchitecture: () => Promise.resolve(host),
          cacheHome: () => cache,
          preflightBuild: async (
            ...args: Parameters<typeof preflightBuild>
          ) => {
            events.push("preflight");
            await preflightBuild(args[0], args[1], args[2], args[3], {
              exists,
              readTextFile: (path) =>
                Promise.resolve(
                  path.endsWith("/status") ? "enabled" : "enabled\nflags: F\n",
                ),
              capture: () => Promise.resolve("ok"),
            });
          },
          downloadVerified: async (_url: string, path: string) => {
            await touch(path);
          },
          capture: (command: string, args: string[]) => {
            deepStrictEqual([command, ...args], [
              vendor,
              "vendor",
              "--locked",
              "--versioned-dirs",
              "vendor",
            ]);
            vendors.push(command);
            return Promise.resolve(
              "[source.crates-io]\nreplace-with = 'vendored-sources'\n",
            );
          },
          run: async (command: string, args: string[], cwd?: string) => {
            if (command === vendor) {
              deepStrictEqual(args, ["mod", "vendor"]);
              vendors.push(command);
            } else if (command === "tar") {
              if (args.includes("-xzf")) {
                await Deno.mkdir(
                  join(args[args.indexOf("-C") + 1], "fixture-1.0"),
                  { recursive: true },
                );
              } else {
                ok(args.includes("-czf"));
                await touch(args[args.indexOf("-czf") + 1]);
              }
            } else if (command === "cp") {
              await run(command, args, cwd);
            } else if (command === "dpkg-buildpackage") {
              deepStrictEqual(args, [
                "--build=source",
                "--no-sign",
                "--no-check-builddeps",
              ]);
              ok(cwd, "dpkg-buildpackage runs in the source directory");
              const rules = await Deno.readTextFile(join(cwd, "debian/rules"));
              ok(!rules.includes("{{"), "template values must be resolved");
              if (kind === "rust") {
                ok(
                  rules.includes("include /usr/share/dpkg/architecture.mk"),
                  "rust rules must know the build and host architecture",
                );
                ok(
                  rules.includes(
                    "ifneq ($(DEB_HOST_ARCH),$(DEB_BUILD_ARCH))",
                  ),
                  "rust emulated-build tuning must be keyed on the host arch",
                );
                ok(rules.includes("export CARGO_PROFILE_RELEASE_LTO := thin"));
                ok(rules.includes("export CARGO_BUILD_JOBS := 4"));
              } else {
                ok(
                  !rules.includes("CARGO_PROFILE_RELEASE_LTO"),
                  "go rules must not receive rust tuning",
                );
              }
              events.push("source");
            } else if (command === "sbuild") {
              ok(!building, "sbuild calls must not overlap");
              building = true;
              const archArg = args.find((arg) => arg.startsWith("--arch="));
              const arch = archArg?.slice(
                "--arch=".length,
              ) as DebianArchitecture;
              events.push(arch);
              ok(
                args.includes(
                  `--chroot=${cache}/sbuild/trixie-${arch}.tar.zst`,
                ),
              );
              ok(
                args.includes(`--extra-package=${debPath(arch)}`),
              );
              ok(args.includes("--chroot-mode=unshare"));
              ok(args.includes("--dist=trixie"));
              ok(
                !args.some((arg) =>
                  arg.startsWith("--host=") || arg.startsWith("--build=")
                ),
              );
              await new Promise((resolve) => setTimeout(resolve, 5));
              const output = args.find((arg) => arg.startsWith("--build-dir="))!
                .slice(12);
              for (const extension of ["deb", "changes", "buildinfo"]) {
                await touch(
                  join(output, `fixture_1.0-1~deb13u1_${arch}.${extension}`),
                );
              }
              building = false;
            } else throw new Error(`Unexpected command: ${command}`);
          },
        };
        const moduleUrl = pathToFileURL(join(packageDir, "build.ts")).href;
        // Missing later target must stop before any source preparation/build.
        await Deno.remove(join(cache, "sbuild/trixie-riscv64.tar.zst"));
        await rejects(
          () => buildPackage(moduleUrl, undefined, undefined, runtime),
          /setup-sbuild trixie riscv64/,
        );
        deepStrictEqual(events, ["preflight"]);
        events.length = 0;
        await touch(join(cache, "sbuild/trixie-riscv64.tar.zst"));
        await buildPackage(moduleUrl, undefined, undefined, runtime);
        deepStrictEqual(events, [
          "preflight",
          "source",
          "amd64",
          "source",
          "arm64",
          "source",
          "riscv64",
        ]);
        deepStrictEqual(
          vendors,
          [vendor],
          "host-vendored orig is reused across serial targets",
        );
        for (const arch of ["amd64", "arm64", "riscv64"]) {
          for (const extension of ["deb", "changes", "buildinfo"]) {
            ok(
              await exists(
                join(
                  root,
                  `build/trixie/fixture_1.0-1~deb13u1_${arch}.${extension}`,
                ),
              ),
            );
          }
        }
        events.length = 0;
        await rejects(() =>
          buildPackage(moduleUrl, "trixie", "armhf", runtime)
        );
        deepStrictEqual(events, []);
        await buildPackage(moduleUrl, "trixie", "arm64", runtime);
        deepStrictEqual(events, ["preflight", "source", "arm64"]);
        events.length = 0;
        let failedWorkDir = "";
        await rejects(() =>
          buildPackage(moduleUrl, "trixie", "all", {
            ...runtime,
            run: async (command, args, cwd) => {
              if (command === "sbuild") {
                failedWorkDir = dirname(
                  args.find((arg) => arg.startsWith("--build-dir="))!.slice(12),
                );
                throw new Error("mock sbuild failure");
              }
              await runtime.run(command, args, cwd);
            },
          }), /mock sbuild failure/);
        ok(failedWorkDir);
        ok(
          !(await exists(failedWorkDir)),
          "temporary build directory is removed on failure",
        );
        deepStrictEqual(
          events,
          ["preflight", "source"],
          "target 2 must not start after target 1 fails",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  }
}
