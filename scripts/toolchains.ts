#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { join } from "node:path";
import { run } from "./runtime.ts";

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
import type {
  DebianArchitecture,
  GoToolchainConfig,
  RustToolchainConfig,
} from "./config.ts";

export function goDebPath(
  projectDir: string,
  architecture: DebianArchitecture,
  config: GoToolchainConfig,
): string {
  return join(
    projectDir,
    "build/toolchains",
    `${config.packageName}_${config.packageVersion}_${architecture}.deb`,
  );
}

export function rustDebPath(
  projectDir: string,
  architecture: DebianArchitecture,
  config: RustToolchainConfig,
): string {
  return join(
    projectDir,
    "build/toolchains",
    `${config.packageName}_${config.packageVersion}_${architecture}.deb`,
  );
}

export function installedGoRoot(
  cacheHome: string,
  architecture: DebianArchitecture,
  config: GoToolchainConfig,
): string {
  const identity = `go-${config.version}-${config.fingerprint.slice(0, 12)}`;
  return join(
    cacheHome,
    "aptrepo/toolchains/installed",
    identity,
    architecture,
  );
}

export function installedRustRoot(
  cacheHome: string,
  architecture: DebianArchitecture,
  config: RustToolchainConfig,
): string {
  const identity = `rust-${config.version}-${config.fingerprint.slice(0, 12)}`;
  return join(
    cacheHome,
    "aptrepo/toolchains/installed",
    identity,
    architecture,
  );
}
