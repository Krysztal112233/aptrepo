#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-run

import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackageConfig } from "./config.ts";
import { capture, exists } from "./runtime.ts";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()[\]\\|]/g, "\\$&");
}

/**
 * Compile a source.tag template into an anchored matcher for upstream version
 * tags. The version part must start with a digit but is otherwise loose: it
 * covers both dotted ("0.66.0") and date-shaped ("20240203-110809-5046fc22")
 * schemes. Prerelease suffixes are filtered in classify, not here.
 */
export function stableTagPattern(template: string): RegExp {
  const parts = template.split("{version}");
  if (parts.length !== 2) {
    throw new Error(`unsupported tag template: ${template}`);
  }
  const [prefix, suffix] = parts.map(escapeRegExp);
  return new RegExp(`^${prefix}([0-9][0-9A-Za-z.+-]*)${suffix}$`);
}

/** A hyphen-introduced prerelease marker, e.g. the "-rc.1" in "v0.66.0-rc.1". */
const PRERELEASE_MARKER = /-(rc|alpha|beta|pre|dev)/i;

export function parseTagRefs(output: string): string[] {
  const tags: string[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^[0-9a-f]+\trefs\/tags\/(.+)$/);
    if (match) tags.push(match[1]);
  }
  return tags;
}

export type UpdateStatus =
  | "up to date"
  | "update available"
  | "tag missing upstream";

export interface Classification {
  latest: string | null;
  status: UpdateStatus;
}

/**
 * Classify the pinned tag against the remote's tags, which ls-remote already
 * sorted by descending version: the first stable match is the newest, and a
 * pinned tag that sorts behind it is older. A pinned tag absent from the
 * full set no longer corresponds to any upstream commit.
 */
export function classify(
  pinnedTag: string,
  tags: string[],
  pattern: RegExp,
): Classification {
  const latest = tags.find((tag) => {
    const version = tag.match(pattern)?.[1];
    return version !== undefined && !PRERELEASE_MARKER.test(version);
  }) ?? null;
  if (!tags.includes(pinnedTag)) {
    return { latest, status: "tag missing upstream" };
  }
  if (pinnedTag === latest) return { latest, status: "up to date" };
  return { latest, status: "update available" };
}

interface Report {
  name: string;
  pinnedTag: string;
  latest: string | null;
  status: UpdateStatus;
  error?: string;
}

async function checkPackage(packageDir: string): Promise<Report> {
  const config = await loadPackageConfig(packageDir);
  const pattern = stableTagPattern(config.source.tagTemplate);
  const output = await capture("git", [
    "ls-remote",
    "--tags",
    "--refs",
    "--sort=-version:refname",
    config.source.git,
    `refs/tags/${config.source.tagTemplate.replace("{version}", "*")}`,
  ]);
  return {
    name: config.name,
    pinnedTag: config.source.tag,
    ...classify(config.source.tag, parseTagRefs(output), pattern),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const [selection, ...rest] = Deno.args;
  if (rest.length > 0) {
    throw new Error("Usage: [all|package]");
  }

  const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packageDirs: string[] = [];
  for await (const entry of Deno.readDir(join(projectDir, "packages"))) {
    if (!entry.isDirectory) continue;
    const dir = join(projectDir, "packages", entry.name);
    if (await exists(join(dir, "package.toml"))) packageDirs.push(dir);
  }
  packageDirs.sort();

  const selected = selection === undefined || selection === "all"
    ? packageDirs
    : packageDirs.filter((dir) => basename(dir) === selection);
  if (selected.length === 0) {
    throw new Error(`Unknown package: ${selection}`);
  }

  const reports = await Promise.all(selected.map(async (dir) => {
    try {
      return await checkPackage(dir);
    } catch (error) {
      return {
        name: basename(dir),
        pinnedTag: "?",
        latest: null,
        status: "tag missing upstream" as const,
        error: errorMessage(error),
      };
    }
  }));

  const nameWidth = Math.max(...reports.map((report) => report.name.length));
  let failures = 0;
  for (const report of reports) {
    const name = report.name.padEnd(nameWidth);
    if (report.error !== undefined) {
      failures++;
      console.log(`${name}  error: ${report.error}`);
      continue;
    }
    const change = report.status === "up to date"
      ? report.pinnedTag
      : `${report.pinnedTag} -> ${report.latest ?? "(none)"}`;
    if (report.status === "tag missing upstream") failures++;
    console.log(`${name}  ${change}  ${report.status}`);
  }

  const updates = reports.filter((report) =>
    report.status === "update available"
  ).length;
  console.log(
    `\n${reports.length} packages: ${updates} updates available, ${failures} problems`,
  );
  if (failures > 0) Deno.exit(1);
}
