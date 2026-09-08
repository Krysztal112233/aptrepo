#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DebianArchitecture, loadRustToolchainConfig } from "./config.ts";
import {
  capture,
  downloadVerified,
  exists,
  requiredEnv,
  run,
} from "./runtime.ts";
import {
  installedRustRoot,
  installRustComponent,
  rustDebPath,
} from "./toolchains.ts";

import {
  hostArchitecture,
  parseSetupArgs,
  toolchainArchitectures,
} from "./build-targets.ts";

const selection = parseSetupArgs(Deno.args);
const host = await hostArchitecture();
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadRustToolchainConfig(projectDir);
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
  const rustDeb = rustDebPath(projectDir, architecture, config);
  const fingerprintPath = `${rustDeb}.config-sha256`;

  await Deno.mkdir(downloadDir, { recursive: true });
  await Deno.mkdir(dirname(rustDeb), { recursive: true });

  if (!(await currentPackage())) await buildRustToolchain();
  await extractRustToolchain();

  console.log(`Ready: ${rustDeb}`);

  async function currentPackage(): Promise<boolean> {
    if (!(await exists(rustDeb)) || !(await exists(fingerprintPath))) {
      return false;
    }
    if (
      (await Deno.readTextFile(fingerprintPath)).trim() !==
        config.fingerprint
    ) {
      return false;
    }
    try {
      return await capture("dpkg-deb", ["-f", rustDeb, "Version"]) ===
        config.packageVersion;
    } catch {
      return false;
    }
  }

  async function buildRustToolchain(): Promise<void> {
    const archives = await Promise.all(
      config.components.map(async (component) => {
        const filename =
          `${component}-${config.version}-${target.target}.tar.xz`;
        const archive = join(downloadDir, filename);
        await downloadVerified(
          `${config.downloadBase}/${filename}`,
          archive,
          target.sha256[component],
        );
        return archive;
      }),
    );

    const workDir = await Deno.makeTempDir({ prefix: "aptrepo-rust-" });
    try {
      const packageRoot = join(workDir, "package");
      await Deno.mkdir(join(packageRoot, "DEBIAN"), {
        recursive: true,
      });
      for (let index = 0; index < config.components.length; index++) {
        const component = config.components[index];
        const extractDir = join(workDir, component);
        await Deno.mkdir(extractDir);
        await run("tar", [
          "-xJf",
          archives[index],
          "-C",
          extractDir,
        ]);
        await installRustComponent(
          join(extractDir, `${component}-${config.version}-${target.target}`),
          component === "rust-std"
            ? `${component}-${target.target}`
            : component,
          join(packageRoot, config.installPrefix.slice(1)),
        );
      }
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
      "Description: Pinned Rust compiler for local aptrepo builds",
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
    const temporaryDestination = `${rustDeb}.part`;
    await Deno.copyFile(temporaryDeb, temporaryDestination);
    await Deno.rename(temporaryDestination, rustDeb);
  }

  async function extractRustToolchain(): Promise<void> {
    const installedRoot = installedRustRoot(
      cacheHome,
      architecture,
      config,
    );
    const cargo = join(
      installedRoot,
      config.installPrefix.slice(1),
      "bin/cargo",
    );
    if (await exists(cargo)) return;

    await Deno.remove(installedRoot, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    await Deno.mkdir(installedRoot, { recursive: true });
    await run("dpkg-deb", ["--extract", rustDeb, installedRoot]);
  }
}
