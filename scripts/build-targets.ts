#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-run

import { join } from "node:path";
import {
  type DebianArchitecture,
  parseArchitecture,
  supportedSuites,
} from "./config.ts";
import { capture, exists, requiredEnv } from "./runtime.ts";

export const suites = supportedSuites;
export type Suite = typeof suites[number];
export type ArchitectureSelection = "all" | DebianArchitecture;

export function parseSuite(value: string): Suite {
  if (!suites.includes(value as Suite)) {
    throw new Error(`Unsupported Debian release: ${value}`);
  }
  return value as Suite;
}

export function parseSelection(value = "all"): ArchitectureSelection {
  if (value === "all") return value;
  return parseArchitecture(value);
}

export function targetArchitectures(
  selection: ArchitectureSelection,
): DebianArchitecture[] {
  return selection === "all" ? ["amd64", "arm64"] : [selection];
}

export function parseBuildArgs(args: string[]) {
  if (args.length > 2) throw new Error("Usage: [suite] [all|amd64|arm64]");
  return {
    suite: parseSuite(args[0] ?? "trixie"),
    selection: parseSelection(args[1]),
  };
}

export function parseSetupArgs(args: string[]): ArchitectureSelection {
  if (args.length > 1) throw new Error("Usage: [all|amd64|arm64]");
  return parseSelection(args[0]);
}

// Foreign packages are never used to vendor sources on the build host.
export function toolchainArchitectures(
  selection: ArchitectureSelection,
  host: DebianArchitecture,
): DebianArchitecture[] {
  return [...new Set([...targetArchitectures(selection), host])];
}

export async function hostArchitecture(): Promise<DebianArchitecture> {
  return parseArchitecture(await capture("dpkg", ["--print-architecture"]));
}

export function cacheHome(): string {
  return Deno.env.get("XDG_CACHE_HOME") ?? join(requiredEnv("HOME"), ".cache");
}

export function chrootPath(
  cache: string,
  suite: Suite,
  arch: DebianArchitecture,
) {
  return join(cache, "sbuild", `${suite}-${arch}.tar.zst`);
}

interface PreflightRuntime {
  exists: typeof exists;
  readTextFile: (path: string) => Promise<string>;
  capture: typeof capture;
}
const preflightRuntime: PreflightRuntime = {
  exists,
  // Deno restricts direct /proc reads even with --allow-read; use the existing
  // --allow-run boundary for these fixed binfmt paths, without a shell.
  readTextFile: (path) => capture("cat", [path]),
  capture,
};

export async function preflightForeignExecution(
  targets: DebianArchitecture[],
  host: DebianArchitecture,
  runtime = preflightRuntime,
): Promise<void> {
  for (const arch of targets) {
    if (arch === host) continue;
    const emulator = arch === "arm64" ? "qemu-aarch64" : "qemu-x86_64";
    try {
      const status = await runtime.readTextFile(
        "/proc/sys/fs/binfmt_misc/status",
      );
      const registration = await runtime.readTextFile(
        `/proc/sys/fs/binfmt_misc/${emulator}`,
      );
      // F pins the interpreter outside the chroot; a host-only registration
      // without it can pass arch-test but fail inside an unshare chroot.
      if (
        status.trim() !== "enabled" || !/^enabled$/m.test(registration) ||
        !/^flags:.*F/m.test(registration)
      ) {
        throw new Error("binfmt registration must be enabled with the F flag");
      }
      await runtime.capture("arch-test", [arch]);
    } catch (cause) {
      throw new Error(
        `Cannot execute ${arch} in sbuild chroots on ${host}. ` +
          `Install host QEMU user-mode/binfmt and arch-test, enable ${emulator} ` +
          `with the F flag, then check: arch-test ${arch}. ` +
          "See docs/build-environment.md. " + String(cause),
      );
    }
  }
}

export async function preflightBuild(
  selectedSuites: readonly Suite[],
  selection: ArchitectureSelection,
  host: DebianArchitecture,
  cache: string,
  runtime = preflightRuntime,
): Promise<void> {
  const targets = targetArchitectures(selection);
  for (const suite of selectedSuites) {
    for (const arch of targets) {
      const chroot = chrootPath(cache, suite, arch);
      if (!(await runtime.exists(chroot))) {
        throw new Error(
          `Missing sbuild chroot: ${chroot}\nRun: just setup-sbuild ${suite} ${arch}`,
        );
      }
    }
  }
  await preflightForeignExecution(targets, host, runtime);
}

if (import.meta.main) {
  // Internal Just/shell seam: setup checks execution, not yet-created chroots.
  const [mode, ...args] = Deno.args;
  if (!["--build", "--build-all", "--setup", "--setup-all"].includes(mode)) {
    throw new Error("Expected --build, --build-all, --setup or --setup-all");
  }
  const allSuites = mode.endsWith("-all");
  const setup = mode.startsWith("--setup");
  if (args.length !== (allSuites ? 1 : 2)) {
    throw new Error(
      "Usage: --build|--setup suite selection OR --build-all|--setup-all selection",
    );
  }
  const selectedSuites = allSuites ? suites : [parseSuite(args[0])];
  const selection = parseSelection(args[allSuites ? 0 : 1]);
  const host = await hostArchitecture();
  if (setup) {
    await preflightForeignExecution(targetArchitectures(selection), host);
    console.log(targetArchitectures(selection).join(" "));
  } else {
    await preflightBuild(selectedSuites, selection, host, cacheHome());
  }
}
