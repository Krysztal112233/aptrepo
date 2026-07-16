#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DebianArchitecture,
  loadGoToolchainConfig,
  loadPackageConfig,
  loadRustToolchainConfig,
  type PackageConfig,
  parseArchitecture,
} from "./config.ts";
import {
  capture,
  copyBuildArtifacts,
  downloadVerified,
  exists,
  releaseChangelog,
  renderDebianTemplate,
  requiredEnv,
  run,
} from "./runtime.ts";
import { goDebPath, installedRustRoot, rustDebPath } from "./toolchains.ts";

const versionSuffixes = new Map([
  ["bookworm", "deb12u1"],
  ["trixie", "deb13u1"],
  ["forky", "deb14u1"],
]);

interface BuildEnvironment {
  projectDir: string;
  packageConfig: PackageConfig;
  architecture: DebianArchitecture;
  cacheHome: string;
  downloadDir: string;
  download: string;
}

interface SourceEnvironment extends BuildEnvironment {
  workDir: string;
  sourceDir: string;
}

interface BuildAdapter {
  extraPackages: string[];
  controlReplacements: Record<string, string>;
  rulesReplacements: Record<string, string>;
  prepareSource(environment: SourceEnvironment): Promise<string>;
}

export async function buildPackage(
  packageModuleUrl: string,
  suite = Deno.args[0] ?? "trixie",
): Promise<void> {
  const versionSuffix = versionSuffixes.get(suite);
  if (!versionSuffix) {
    console.error(`Unsupported Debian release: ${suite}`);
    Deno.exit(2);
  }

  const packageDir = dirname(fileURLToPath(packageModuleUrl));
  const projectDir = resolve(packageDir, "../..");
  const packageConfig = await loadPackageConfig(packageDir);
  const packageVersion = `${packageConfig.baseVersion}~${versionSuffix}`;
  const architecture = parseArchitecture(
    await capture("dpkg", ["--print-architecture"]),
  );
  const cacheHome = Deno.env.get("XDG_CACHE_HOME") ??
    join(requiredEnv("HOME"), ".cache");
  const chroot = join(
    cacheHome,
    "sbuild",
    `${suite}-${architecture}.tar.zst`,
  );
  if (!(await exists(chroot))) {
    throw new Error(
      `Missing sbuild chroot: ${chroot}\nRun: just setup-sbuild ${suite}`,
    );
  }

  const archiveName = `${packageConfig.name}-${packageConfig.version}.tar.gz`;
  const downloadDir = join(projectDir, "build/downloads");
  const outputDir = join(projectDir, "build", suite);
  const download = join(downloadDir, archiveName);
  const environment: BuildEnvironment = {
    projectDir,
    packageConfig,
    architecture,
    cacheHome,
    downloadDir,
    download,
  };
  const adapter = await createBuildAdapter(environment);

  await Deno.mkdir(downloadDir, { recursive: true });
  await Deno.mkdir(outputDir, { recursive: true });
  await downloadVerified(
    packageConfig.source.archive,
    download,
    packageConfig.source.sha256,
  );

  const workDir = await Deno.makeTempDir({
    prefix: `${packageConfig.name}-build-`,
  });
  try {
    const sourceDir = join(
      workDir,
      packageConfig.source.archiveRoot,
    );
    const sbuildDir = join(workDir, "sbuild");
    await Deno.mkdir(sbuildDir);

    const origArchive = await adapter.prepareSource({
      ...environment,
      workDir,
      sourceDir,
    });
    if (!(await exists(sourceDir))) {
      throw new Error(
        `${packageConfig.configPath}: archive_root was not found after extraction`,
      );
    }

    await Deno.copyFile(
      origArchive,
      join(
        workDir,
        `${packageConfig.name}_${packageConfig.version}.orig.tar.gz`,
      ),
    );
    await run("cp", ["-R", join(packageDir, "debian"), sourceDir]);
    const debianDir = join(sourceDir, "debian");
    await renderDebianTemplate(debianDir, "control", {
      ...adapter.controlReplacements,
      SOURCE_GIT: packageConfig.source.git,
    });
    await renderDebianTemplate(
      debianDir,
      "rules",
      adapter.rulesReplacements,
      true,
    );
    await releaseChangelog(
      join(debianDir, "changelog"),
      packageConfig.name,
      packageVersion,
      suite,
    );

    await run(
      "dpkg-buildpackage",
      ["--build=source", "--no-sign", "--no-check-builddeps"],
      sourceDir,
    );

    const sourcePackage = join(
      workDir,
      `${packageConfig.name}_${packageVersion}.dsc`,
    );
    await run("sbuild", [
      "--chroot-mode=unshare",
      `--chroot=${chroot}`,
      `--dist=${suite}`,
      `--arch=${architecture}`,
      `--build-dir=${sbuildDir}`,
      "--no-run-lintian",
      "--no-run-autopkgtest",
      "--no-run-piuparts",
      "--no-source-only-changes",
      ...adapter.extraPackages.map((path) => `--extra-package=${path}`),
      sourcePackage,
    ]);

    await copyBuildArtifacts(
      sbuildDir,
      outputDir,
      packageConfig.name,
      packageVersion,
      architecture,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }

  console.log(
    `Built ${
      join(
        outputDir,
        `${packageConfig.name}_${packageVersion}_${architecture}.deb`,
      )
    }`,
  );
}

async function createBuildAdapter(
  environment: BuildEnvironment,
): Promise<BuildAdapter> {
  return environment.packageConfig.build.toolchain === "go"
    ? await createGoAdapter(environment)
    : await createRustAdapter(environment);
}

async function createGoAdapter(
  environment: BuildEnvironment,
): Promise<BuildAdapter> {
  const config = await loadGoToolchainConfig(environment.projectDir);
  const goToolchain = goDebPath(
    environment.projectDir,
    environment.architecture,
    config,
  );
  if (!(await exists(goToolchain))) {
    throw new Error(
      "Missing Go build toolchain\nRun: just setup-go",
    );
  }

  return {
    extraPackages: [goToolchain],
    controlReplacements: {
      GO_PACKAGE_NAME: config.packageName,
      GO_PACKAGE_VERSION: config.packageVersion,
    },
    rulesReplacements: {
      GO_BINARY_PATH: join(config.installPrefix, "bin"),
    },
    async prepareSource({ download, workDir }) {
      await run("tar", ["-xzf", download, "-C", workDir]);
      return download;
    },
  };
}

async function createRustAdapter(
  environment: BuildEnvironment,
): Promise<BuildAdapter> {
  const config = await loadRustToolchainConfig(environment.projectDir);
  const rustToolchain = rustDebPath(
    environment.projectDir,
    environment.architecture,
    config,
  );
  const cargo = join(
    installedRustRoot(
      environment.cacheHome,
      environment.architecture,
      config,
    ),
    config.installPrefix.slice(1),
    "bin/cargo",
  );
  if (!(await exists(rustToolchain)) || !(await exists(cargo))) {
    throw new Error(
      "Missing Rust build toolchain\nRun: just setup-rust",
    );
  }

  const vendoredIdentity = [
    environment.packageConfig.source.sha256.slice(0, 12),
    config.fingerprint.slice(0, 12),
  ].join("-");
  const vendoredOrig = join(
    environment.downloadDir,
    `${environment.packageConfig.name}_${environment.packageConfig.version}.${vendoredIdentity}.orig.tar.gz`,
  );

  return {
    extraPackages: [rustToolchain],
    controlReplacements: {
      RUST_PACKAGE_NAME: config.packageName,
      RUST_PACKAGE_VERSION: config.packageVersion,
    },
    rulesReplacements: {
      RUST_INSTALL_PREFIX: config.installPrefix,
    },
    prepareSource(sourceEnvironment) {
      return prepareRustSource(
        sourceEnvironment,
        cargo,
        vendoredOrig,
      );
    },
  };
}

async function prepareRustSource(
  environment: SourceEnvironment,
  cargo: string,
  vendoredOrig: string,
): Promise<string> {
  if (await exists(vendoredOrig)) {
    await run("tar", [
      "-xzf",
      vendoredOrig,
      "-C",
      environment.workDir,
    ]);
    return vendoredOrig;
  }

  await run("tar", [
    "-xzf",
    environment.download,
    "-C",
    environment.workDir,
  ]);
  if (!(await exists(environment.sourceDir))) {
    throw new Error(
      `${environment.packageConfig.configPath}: archive_root was not found after extraction`,
    );
  }

  const cargoConfig = await capture(
    cargo,
    ["vendor", "--locked", "--versioned-dirs", "vendor"],
    environment.sourceDir,
  );
  await Deno.mkdir(join(environment.sourceDir, ".cargo"), {
    recursive: true,
  });
  await Deno.writeTextFile(
    join(environment.sourceDir, ".cargo/config.toml"),
    cargoConfig,
  );

  const temporaryOrig = await Deno.makeTempFile({
    dir: environment.downloadDir,
    prefix: `.${environment.packageConfig.name}-orig-`,
    suffix: ".tar.gz",
  });
  await run("tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-czf",
    temporaryOrig,
    "-C",
    environment.workDir,
    environment.packageConfig.source.archiveRoot,
  ]);
  await Deno.rename(temporaryOrig, vendoredOrig);
  return vendoredOrig;
}
