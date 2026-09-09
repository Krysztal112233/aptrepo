#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-run

import { join } from "node:path";
import {
  type DebianArchitecture,
  defaultSuiteArchitectures,
  parseArchitecture,
  suiteArchitectures,
  supportedSuites,
  uniqueArchitectures,
} from "./config.ts";
import { capture, exists, requiredEnv } from "./runtime.ts";

export const suites = supportedSuites;
export type Suite = typeof suites[number];
export type ArchitectureSelection = "all" | DebianArchitecture;

const qemuEmulators: Record<DebianArchitecture, string> = {
  amd64: "qemu-x86_64",
  arm64: "qemu-aarch64",
  riscv64: "qemu-riscv64",
};

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
  suite: Suite = "trixie",
  matrix = defaultSuiteArchitectures,
): DebianArchitecture[] {
  const allowed = suiteArchitectures(suite, matrix);
  if (selection === "all") return allowed;
  if (!allowed.includes(selection)) {
    throw new Error(
      `Architecture ${selection} is not supported for ${suite} ` +
        `(supported: ${allowed.join(", ")})`,
    );
  }
  return [selection];
}

/** Suites that can honor a selection; multi-suite commands skip the rest. */
export function suitesForSelection(
  selection: ArchitectureSelection,
  matrix = defaultSuiteArchitectures,
): Suite[] {
  if (selection === "all") return [...suites];
  return suites.filter((suite) => matrix[suite].includes(selection));
}

export function parseBuildArgs(args: string[]) {
  if (args.length > 2) {
    throw new Error("Usage: [suite] [all|amd64|arm64|riscv64]");
  }
  const suite = parseSuite(args[0] ?? "trixie");
  const selection = parseSelection(args[1]);
  // Validate suite/arch combinations at parse time so Just recipes fail before
  // toolchain setup.
  targetArchitectures(selection, suite);
  return { suite, selection };
}

export function parseSetupArgs(args: string[]): ArchitectureSelection {
  if (args.length > 1) {
    throw new Error("Usage: [all|amd64|arm64|riscv64]");
  }
  return parseSelection(args[0]);
}

// Foreign packages are never used to vendor sources on the build host.
export function toolchainArchitectures(
  selection: ArchitectureSelection,
  host: DebianArchitecture,
): DebianArchitecture[] {
  const targets = selection === "all"
    ? uniqueArchitectures(suites)
    : [selection];
  return [...new Set([...targets, host])];
}

export async function hostArchitecture(): Promise<DebianArchitecture> {
  const architecture = parseArchitecture(
    await capture("dpkg", ["--print-architecture"]),
  );
  if (architecture !== "amd64" && architecture !== "arm64") {
    throw new Error(
      `Unsupported build host architecture: ${architecture} ` +
        `(supported hosts: amd64, arm64)`,
    );
  }
  return architecture;
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

export function qemuEmulator(architecture: DebianArchitecture): string {
  return qemuEmulators[architecture];
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
    const emulator = qemuEmulator(arch);
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
  const foreignTargets = new Set<DebianArchitecture>();
  for (const suite of selectedSuites) {
    const targets = targetArchitectures(selection, suite);
    for (const arch of targets) {
      const chroot = chrootPath(cache, suite, arch);
      if (!(await runtime.exists(chroot))) {
        throw new Error(
          `Missing sbuild chroot: ${chroot}\nRun: just setup-sbuild ${suite} ${arch}`,
        );
      }
      if (arch !== host) foreignTargets.add(arch);
    }
  }
  await preflightForeignExecution([...foreignTargets], host, runtime);
}

if (import.meta.main) {
  // Internal Just/shell seam: setup checks execution, not yet-created chroots.
  const [mode, ...args] = Deno.args;
  if (
    !["--build", "--build-all", "--setup", "--setup-all", "--suites"].includes(
      mode,
    )
  ) {
    throw new Error(
      "Expected --build, --build-all, --setup, --setup-all or --suites",
    );
  }
  if (mode === "--suites") {
    if (args.length !== 1) throw new Error("Usage: --suites selection");
    console.log(suitesForSelection(parseSelection(args[0])).join(" "));
    Deno.exit(0);
  }
  const allSuites = mode.endsWith("-all");
  const setup = mode.startsWith("--setup");
  if (args.length !== (allSuites ? 1 : 2)) {
    throw new Error(
      "Usage: --build|--setup suite selection OR --build-all|--setup-all selection",
    );
  }
  const selection = parseSelection(args[allSuites ? 0 : 1]);
  const selectedSuites = allSuites
    ? suitesForSelection(selection)
    : [parseSuite(args[0])];
  if (selectedSuites.length === 0) {
    throw new Error(`No Debian suite supports architecture ${selection}`);
  }
  const host = await hostArchitecture();
  if (setup) {
    if (allSuites) {
      // Validate every supported suite/selection pair, then print the union for
      // callers that only need a single arch list (toolchains). Per-suite setup
      // still uses --setup <suite> <selection>.
      const targets = new Set<DebianArchitecture>();
      for (const suite of selectedSuites) {
        for (const arch of targetArchitectures(selection, suite)) {
          targets.add(arch);
        }
      }
      await preflightForeignExecution([...targets], host);
      console.log([...targets].join(" "));
    } else {
      const suite = selectedSuites[0];
      const targets = targetArchitectures(selection, suite);
      await preflightForeignExecution(targets, host);
      console.log(targets.join(" "));
    }
  } else {
    await preflightBuild(selectedSuites, selection, host, cacheHome());
  }
}
