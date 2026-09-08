#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DebianArchitecture, loadGoToolchainConfig } from "./config.ts";
import {
  capture,
  downloadVerified,
  exists,
  requiredEnv,
  run,
} from "./runtime.ts";
import { goDebPath, installedGoRoot } from "./toolchains.ts";

import {
  hostArchitecture,
  parseSetupArgs,
  toolchainArchitectures,
} from "./build-targets.ts";

const selection = parseSetupArgs(Deno.args);
const host = await hostArchitecture();
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadGoToolchainConfig(projectDir);
for (const architecture of toolchainArchitectures(selection, host)) {
  await setupArchitecture(architecture);
}

async function setupArchitecture(
  architecture: DebianArchitecture,
): Promise<void> {
  const target = config.architectures[architecture];
  const cacheHome = Deno.env.get("XDG_CACHE_HOME") ??
    join(requiredEnv("HOME"), ".cache");
  const downloadDir = join(cacheHome, "aptrepo/toolchains/downloads");
  const goDeb = goDebPath(projectDir, architecture, config);
  const fingerprintPath = `${goDeb}.config-sha256`;

  await Deno.mkdir(downloadDir, { recursive: true });
  await Deno.mkdir(dirname(goDeb), { recursive: true });

  if (!(await currentPackage())) await buildGoToolchain();
  await extractGoToolchain();

  console.log(`Ready: ${goDeb}`);

  async function currentPackage(): Promise<boolean> {
    if (!(await exists(goDeb)) || !(await exists(fingerprintPath))) {
      return false;
    }
    if (
      (await Deno.readTextFile(fingerprintPath)).trim() !==
        config.fingerprint
    ) {
      return false;
    }
    try {
      return await capture("dpkg-deb", ["-f", goDeb, "Version"]) ===
        config.packageVersion;
    } catch {
      return false;
    }
  }

  async function buildGoToolchain(): Promise<void> {
    const filename = `go${config.version}.${target.target}.tar.gz`;
    const archive = join(downloadDir, filename);
    await downloadVerified(
      `${config.downloadBase}/${filename}`,
      archive,
      target.sha256,
    );

    const workDir = await Deno.makeTempDir({ prefix: "aptrepo-go-" });
    try {
      const packageRoot = join(workDir, "package");
      const prefixDir = join(packageRoot, config.installPrefix.slice(1));
      await Deno.mkdir(join(packageRoot, "DEBIAN"), { recursive: true });
      await Deno.mkdir(prefixDir, { recursive: true });
      await run("tar", [
        "-xzf",
        archive,
        "-C",
        prefixDir,
        "--strip-components=1",
      ]);
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
      "Description: Pinned Go compiler for local aptrepo builds",
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
    const temporaryDestination = `${goDeb}.part`;
    await Deno.copyFile(temporaryDeb, temporaryDestination);
    await Deno.rename(temporaryDestination, goDeb);
  }

  async function extractGoToolchain(): Promise<void> {
    const installedRoot = installedGoRoot(
      cacheHome,
      architecture,
      config,
    );
    const go = join(
      installedRoot,
      config.installPrefix.slice(1),
      "bin/go",
    );
    if (await exists(go)) return;

    await Deno.remove(installedRoot, { recursive: true }).catch(() => {});
    await Deno.mkdir(installedRoot, { recursive: true });
    await run("dpkg-deb", ["--extract", goDeb, installedRoot]);
  }
}
