#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DebianArchitecture } from "./config.ts";
import { capture, exists, run } from "./runtime.ts";
import {
  type CompilerToolchainConfig,
  installedToolchainRoot,
  toolchainDebPath,
} from "./toolchains.ts";

import {
  cacheHome,
  hostArchitecture,
  parseSetupArgs,
  toolchainArchitectures,
} from "./build-targets.ts";

export interface ToolchainSetupSpec<Config extends CompilerToolchainConfig> {
  loadConfig(projectDir: string): Promise<Config>;
  /** control Description field of the toolchain .deb. */
  description: string;
  /** Binary probed under the installed prefix, e.g. "bin/go". */
  probeBinary: string;
  /** Download and stage the payload under packageRoot (DEBIAN is prepared). */
  stage(
    config: Config,
    target: Config["architectures"][DebianArchitecture],
    packageRoot: string,
    downloadDir: string,
    workDir: string,
  ): Promise<void>;
}

export async function setupToolchain<Config extends CompilerToolchainConfig>(
  spec: ToolchainSetupSpec<Config>,
  args: string[],
): Promise<void> {
  const selection = parseSetupArgs(args);
  const host = await hostArchitecture();
  const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const config = await spec.loadConfig(projectDir);
  for (const architecture of toolchainArchitectures(selection, host)) {
    await setupArchitecture(spec, projectDir, config, architecture);
  }
}

async function setupArchitecture<Config extends CompilerToolchainConfig>(
  spec: ToolchainSetupSpec<Config>,
  projectDir: string,
  config: Config,
  architecture: DebianArchitecture,
): Promise<void> {
  const target = config.architectures[architecture];
  const cache = cacheHome();
  const downloadDir = join(cache, "aptrepo/toolchains/downloads");
  const deb = toolchainDebPath(projectDir, architecture, config);
  const fingerprintPath = `${deb}.config-sha256`;

  await Deno.mkdir(downloadDir, { recursive: true });
  await Deno.mkdir(dirname(deb), { recursive: true });

  if (!(await currentPackage())) await buildToolchain();
  await extractToolchain();

  console.log(`Ready: ${deb}`);

  async function currentPackage(): Promise<boolean> {
    if (!(await exists(deb)) || !(await exists(fingerprintPath))) {
      return false;
    }
    if (
      (await Deno.readTextFile(fingerprintPath)).trim() !==
        config.fingerprint
    ) {
      return false;
    }
    try {
      return await capture("dpkg-deb", ["-f", deb, "Version"]) ===
        config.packageVersion;
    } catch {
      return false;
    }
  }

  async function buildToolchain(): Promise<void> {
    const workDir = await Deno.makeTempDir({
      prefix: `aptrepo-${config.kind}-`,
    });
    try {
      const packageRoot = join(workDir, "package");
      await Deno.mkdir(join(packageRoot, "DEBIAN"), { recursive: true });
      await spec.stage(config, target, packageRoot, downloadDir, workDir);
      await writeControl(packageRoot);
      await buildDeb(packageRoot, workDir);
      await Deno.writeTextFile(
        fingerprintPath,
        `${config.fingerprint}\n`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  }

  async function writeControl(packageRoot: string): Promise<void> {
    const fields = [
      `Package: ${config.packageName}`,
      `Version: ${config.packageVersion}`,
      `Architecture: ${architecture}`,
      "Section: devel",
      "Priority: optional",
      "Maintainer: Krysztal Huang <krysztal.huang@outlook.com>",
      `Depends: ${config.packageDependencies.join(", ")}`,
      `X-Aptrepo-Config-SHA256: ${config.fingerprint}`,
      `Description: ${spec.description}`,
      "",
    ];
    await Deno.writeTextFile(
      join(packageRoot, "DEBIAN/control"),
      fields.join("\n"),
    );
  }

  async function buildDeb(packageRoot: string, workDir: string): Promise<void> {
    const temporaryDeb = join(workDir, "toolchain.deb");
    await run("dpkg-deb", [
      "--root-owner-group",
      "-Zxz",
      "--build",
      packageRoot,
      temporaryDeb,
    ]);
    const temporaryDestination = `${deb}.part`;
    await Deno.copyFile(temporaryDeb, temporaryDestination);
    await Deno.rename(temporaryDestination, deb);
  }

  async function extractToolchain(): Promise<void> {
    const installedRoot = installedToolchainRoot(cache, architecture, config);
    const probe = join(
      installedRoot,
      config.installPrefix.slice(1),
      spec.probeBinary,
    );
    if (await exists(probe)) return;

    await Deno.remove(installedRoot, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    await Deno.mkdir(installedRoot, { recursive: true });
    await run("dpkg-deb", ["--extract", deb, installedRoot]);
  }
}
