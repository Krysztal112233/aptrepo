#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { join } from "node:path";
import type {
  DebianArchitecture,
  GoToolchainConfig,
  RustToolchainConfig,
} from "./config.ts";

export function goDebPaths(
  projectDir: string,
  architecture: DebianArchitecture,
  config: GoToolchainConfig,
): [string, string] {
  const directory = join(projectDir, "build/toolchains");
  return [
    join(
      directory,
      `${config.compilerPackage}_${config.debianVersion}_${architecture}.deb`,
    ),
    join(
      directory,
      `${config.sourcePackage}_${config.debianVersion}_all.deb`,
    ),
  ];
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
