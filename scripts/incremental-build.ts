#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-run

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackageConfig } from "./config.ts";
import { capture, run } from "./runtime.ts";

import {
  cacheHome,
  hostArchitecture,
  parseSelection,
  preflightBuild,
  suitesForSelection,
} from "./build-targets.ts";

export function parseIncrementalArgs(args: string[]) {
  const positional: string[] = [];
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run" && !dryRun) dryRun = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 2) {
    throw new Error("Usage: [since] [all|amd64|arm64|riscv64] [--dry-run]");
  }
  return {
    since: positional[0] ?? "24 hours ago",
    selection: parseSelection(positional[1]),
    dryRun,
  };
}

async function main() {
  const { since, selection, dryRun } = parseIncrementalArgs(Deno.args);

  const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packagesDir = join(projectDir, "packages");

  const packages: string[] = [];
  for await (const entry of Deno.readDir(packagesDir)) {
    if (entry.isDirectory) packages.push(entry.name);
  }
  packages.sort();

  // Files changed by commits within the time window.
  const committed = await capture("git", [
    "log",
    `--since=${since}`,
    "--name-only",
    "--pretty=format:",
    "--no-renames",
  ], projectDir);

  // Plus uncommitted working-tree changes (staged, unstaged, untracked).
  const uncommitted = await capture("git", [
    "status",
    "--porcelain",
    "--no-renames",
    "--untracked-files=all",
  ], projectDir);

  const changedFiles = new Set<string>();
  for (const line of committed.split("\n")) {
    const path = line.trim();
    if (path) changedFiles.add(path);
  }
  for (const line of uncommitted.split("\n")) {
    if (line.length > 3) changedFiles.add(line.slice(3).trim());
  }

  // Toolchain kind used by each package.
  const packageToolchains = new Map<string, string>();
  for (const name of packages) {
    const config = await loadPackageConfig(join(packagesDir, name));
    packageToolchains.set(name, config.build.toolchain);
  }

  const affected = new Set<string>();
  const reasons = new Map<string, string>();
  const rebuildAll = (reason: string): void => {
    for (const name of packages) {
      affected.add(name);
      reasons.set(name, reason);
    }
  };

  for (const path of changedFiles) {
    const segments = path.split("/");
    if (segments[0] === "packages" && segments.length > 2) {
      const name = segments[1];
      if (packageToolchains.has(name)) {
        affected.add(name);
        reasons.set(name, path);
      }
      continue;
    }
    if (segments[0] === "toolchains" && segments.length === 2) {
      const kind = segments[1].replace(/\.toml$/, "");
      let matched = false;
      for (const [name, toolchain] of packageToolchains) {
        if (toolchain === kind) {
          affected.add(name);
          reasons.set(name, path);
          matched = true;
        }
      }
      if (!matched) rebuildAll(path);
      continue;
    }
    if (
      segments[0] === "scripts" || path === "Justfile" ||
      path === "repository.toml"
    ) {
      rebuildAll(path);
      break;
    }
  }

  if (affected.size === 0) {
    console.log(`No package changes since ${since}`);
    Deno.exit(0);
  }

  console.log(
    `Changed since ${since} (${affected.size}/${packages.length} packages):`,
  );
  for (const name of [...affected].sort()) {
    console.log(`  ${name} (${reasons.get(name)})`);
  }
  if (dryRun) {
    for (const name of [...affected].sort()) {
      console.log(`Would run: just ${name}::build-all ${selection}`);
    }
    return;
  }

  await preflightBuild(
    suitesForSelection(selection),
    selection,
    await hostArchitecture(),
    cacheHome(),
  );

  for (const name of [...affected].sort()) {
    console.log(`\n=== Building ${name} ===`);
    await run("just", [`${name}::build-all`, selection], projectDir);
  }
}

if (import.meta.main) await main();
