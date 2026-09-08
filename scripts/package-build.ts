#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DebianArchitecture,
  loadGoToolchainConfig,
  loadPackageConfig,
  loadRustToolchainConfig,
  type PackageConfig,
} from "./config.ts";
import {
  capture,
  copyBuildArtifacts,
  downloadVerified,
  exists,
  releaseChangelog,
  renderDebianTemplate,
  run,
} from "./runtime.ts";
import {
  goDebPath,
  installedGoRoot,
  installedRustRoot,
  rustDebPath,
} from "./toolchains.ts";

import {
  cacheHome as getCacheHome,
  chrootPath,
  hostArchitecture,
  parseBuildArgs,
  preflightBuild,
  type Suite,
  targetArchitectures,
} from "./build-targets.ts";

const versionSuffixes = new Map([
  ["bookworm", "deb12u1"],
  ["trixie", "deb13u1"],
  ["forky", "deb14u1"],
]);

const buildRuntime = {
  capture,
  run,
  downloadVerified,
  hostArchitecture,
  cacheHome: getCacheHome,
  preflightBuild,
};

interface BuildEnvironment {
  runtime: typeof buildRuntime;
  projectDir: string;
  packageConfig: PackageConfig;
  architecture: DebianArchitecture;
  hostArchitecture: DebianArchitecture;
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
  suite = "trixie",
  architectureSelection = "all",
  runtime = buildRuntime,
): Promise<void> {
  const { suite: selectedSuite, selection } = parseBuildArgs([
    suite,
    architectureSelection,
  ]);
  const host = await runtime.hostArchitecture();
  const cacheHome = runtime.cacheHome();
  await runtime.preflightBuild([selectedSuite], selection, host, cacheHome);
  for (const architecture of targetArchitectures(selection)) {
    await buildTarget(
      packageModuleUrl,
      selectedSuite,
      architecture,
      host,
      cacheHome,
      runtime,
    );
  }
}

async function buildTarget(
  packageModuleUrl: string,
  suite: Suite,
  architecture: DebianArchitecture,
  hostArchitecture: DebianArchitecture,
  cacheHome: string,
  runtime: typeof buildRuntime,
): Promise<void> {
  const versionSuffix = versionSuffixes.get(suite)!;
  const packageDir = dirname(fileURLToPath(packageModuleUrl));
  const projectDir = resolve(packageDir, "../..");
  const packageConfig = await loadPackageConfig(packageDir);
  const packageVersion = `${packageConfig.baseVersion}~${versionSuffix}`;
  const chroot = chrootPath(cacheHome, suite, architecture);

  const archiveName = `${packageConfig.name}-${packageConfig.version}.tar.gz`;
  const downloadDir = join(projectDir, "build/downloads");
  const outputDir = join(projectDir, "build", suite);
  const download = join(downloadDir, archiveName);
  const environment: BuildEnvironment = {
    runtime,
    projectDir,
    packageConfig,
    architecture,
    hostArchitecture,
    cacheHome,
    downloadDir,
    download,
  };
  const adapter = await createBuildAdapter(environment);

  await Deno.mkdir(downloadDir, { recursive: true });
  await Deno.mkdir(outputDir, { recursive: true });
  await runtime.downloadVerified(
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
    await runtime.run("cp", ["-R", join(packageDir, "debian"), sourceDir]);
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

    await runtime.run(
      "dpkg-buildpackage",
      ["--build=source", "--no-sign", "--no-check-builddeps"],
      sourceDir,
    );

    const sourcePackage = join(
      workDir,
      `${packageConfig.name}_${packageVersion}.dsc`,
    );
    await runtime.run("sbuild", [
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
  const goBin = join(
    installedGoRoot(
      environment.cacheHome,
      environment.hostArchitecture,
      config,
    ),
    config.installPrefix.slice(1),
    "bin",
  );
  const go = join(goBin, "go");
  if (!(await exists(goToolchain)) || !(await exists(go))) {
    throw new Error(
      `Missing Go build toolchain\nRun: just setup-go ${environment.architecture}`,
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
    extraPackages: [goToolchain],
    controlReplacements: {
      GO_PACKAGE_NAME: config.packageName,
      GO_PACKAGE_VERSION: config.packageVersion,
    },
    rulesReplacements: {
      GO_BINARY_PATH: join(config.installPrefix, "bin"),
    },
    prepareSource(sourceEnvironment) {
      return prepareGoSource(
        sourceEnvironment,
        go,
        vendoredOrig,
      );
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
      environment.hostArchitecture,
      config,
    ),
    config.installPrefix.slice(1),
    "bin/cargo",
  );
  if (!(await exists(rustToolchain)) || !(await exists(cargo))) {
    throw new Error(
      `Missing Rust build toolchain\nRun: just setup-rust ${environment.architecture}`,
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

async function prepareGoSource(
  environment: SourceEnvironment,
  go: string,
  vendoredOrig: string,
): Promise<string> {
  if (await exists(vendoredOrig)) {
    await environment.runtime.run("tar", [
      "-xzf",
      vendoredOrig,
      "-C",
      environment.workDir,
    ]);
    return vendoredOrig;
  }

  await environment.runtime.run("tar", [
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

  const vendorDir = join(environment.sourceDir, "vendor");
  if (!(await exists(vendorDir))) {
    await environment.runtime.run(go, ["mod", "vendor"], environment.sourceDir);
  }

  const temporaryOrig = await Deno.makeTempFile({
    dir: environment.downloadDir,
    prefix: `.${environment.packageConfig.name}-orig-`,
    suffix: ".tar.gz",
  });
  await environment.runtime.run("tar", [
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

async function prepareRustSource(
  environment: SourceEnvironment,
  cargo: string,
  vendoredOrig: string,
): Promise<string> {
  if (await exists(vendoredOrig)) {
    await environment.runtime.run("tar", [
      "-xzf",
      vendoredOrig,
      "-C",
      environment.workDir,
    ]);
    return vendoredOrig;
  }

  await environment.runtime.run("tar", [
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

  const cargoConfig = await environment.runtime.capture(
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
  await environment.runtime.run("tar", [
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
