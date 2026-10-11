#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { join } from "node:path";
import type {
  DebianArchitecture,
  GoToolchainConfig,
  RustToolchainConfig,
} from "./config.ts";
import { run } from "./runtime.ts";

/** Compiler toolchains packaged as .debs and extracted for host-side vendoring. */
export type CompilerToolchainConfig = GoToolchainConfig | RustToolchainConfig;

// Standalone Rust payloads already use prefix-relative paths. Do not run the
// host-sniffing installer (or any target executable) to package foreign tools.
export async function installRustComponent(
  archiveRoot: string,
  component: string,
  prefix: string,
): Promise<void> {
  const source = join(archiveRoot, component);
  await Deno.mkdir(prefix, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    if (entry.name === "manifest.in") continue;
    await run("cp", ["-a", join(source, entry.name), prefix]);
  }
}

export function toolchainDebPath(
  projectDir: string,
  architecture: DebianArchitecture,
  config: CompilerToolchainConfig,
): string {
  return join(
    projectDir,
    "build/toolchains",
    `${config.packageName}_${config.packageVersion}_${architecture}.deb`,
  );
}

export function installedToolchainRoot(
  cacheHome: string,
  architecture: DebianArchitecture,
  config: CompilerToolchainConfig,
): string {
  const identity = `${config.kind}-${config.version}-${
    config.fingerprint.slice(0, 12)
  }`;
  return join(
    cacheHome,
    "aptrepo/toolchains/installed",
    identity,
    architecture,
  );
}
