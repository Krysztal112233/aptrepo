#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { join } from "node:path";
// @ts-types="npm:@types/mustache@4"
import Mustache from "npm:mustache@4";

Mustache.escape = (text: string): string => text;

const decoder = new TextDecoder();

export async function capture(
  command: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error(`${command} failed`);
  return decoder.decode(result.stdout).trim();
}

export async function run(
  command: string,
  args: string[],
  cwd?: string,
): Promise<void> {
  const status = await new Deno.Command(command, {
    args,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error(`${command} failed`);
}

export async function downloadVerified(
  url: string,
  path: string,
  expectedSha256: string,
): Promise<void> {
  if (await exists(path)) {
    if (await checksum(path) === expectedSha256) return;
    await Deno.remove(path);
  }

  console.log(`Downloading ${url}`);
  const temporaryPath = `${path}.part`;
  try {
    await run("curl", [
      "--fail",
      "--location",
      "--retry",
      "3",
      "--retry-all-errors",
      "--output",
      temporaryPath,
      url,
    ]);
    if (await checksum(temporaryPath) !== expectedSha256) {
      throw new Error(`Checksum mismatch for ${url}`);
    }
    await Deno.rename(temporaryPath, path);
  } catch (error) {
    await Deno.remove(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function renderDebianTemplate(
  debianDir: string,
  name: string,
  replacements: Record<string, string>,
  executable = false,
): Promise<void> {
  const templatePath = join(debianDir, `${name}.in`);
  const destination = join(debianDir, name);
  const content = Mustache.render(
    await Deno.readTextFile(templatePath),
    replacements,
  );
  const unresolved = content.match(/\{\{[^{}]*\}\}/)?.[0];
  if (unresolved) {
    throw new Error(
      `${templatePath}: unresolved template value ${unresolved}`,
    );
  }
  await Deno.writeTextFile(destination, content);
  if (executable) await Deno.chmod(destination, 0o755);
  await Deno.remove(templatePath);
}

export async function releaseChangelog(
  changelogPath: string,
  packageName: string,
  packageVersion: string,
  suite: string,
): Promise<void> {
  const changelog = await Deno.readTextFile(changelogPath);
  const newline = changelog.indexOf("\n");
  const firstLine = newline === -1 ? changelog : changelog.slice(0, newline);
  const match = firstLine.match(/^([^ ]+) \([^)]+\) UNRELEASED;(.*)$/);
  if (!match || match[1] !== packageName) {
    throw new Error(
      `${changelogPath}: unexpected first changelog line`,
    );
  }
  const released = `${packageName} (${packageVersion}) ${suite};${match[2]}`;
  await Deno.writeTextFile(
    changelogPath,
    newline === -1 ? released : released + changelog.slice(newline),
  );
}

export async function copyBuildArtifacts(
  sbuildDir: string,
  outputDir: string,
  packageName: string,
  packageVersion: string,
  architecture: string,
): Promise<void> {
  for (const extension of ["deb", "changes", "buildinfo"]) {
    const artifact =
      `${packageName}_${packageVersion}_${architecture}.${extension}`;
    await Deno.copyFile(
      join(sbuildDir, artifact),
      join(outputDir, artifact),
    );
  }
}

export async function checksum(path: string): Promise<string> {
  return (await capture("sha256sum", [path])).split(/\s+/, 1)[0];
}

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
