#!/usr/bin/env -S deno run --allow-read

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPackageConfig,
  loadRepositoryConfig,
  loadToolchainConfig,
} from "./config.ts";
import { exists } from "./runtime.ts";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(projectDir, "packages");
const packageDirs: string[] = [];
const repositoryConfig = await loadRepositoryConfig(projectDir);

console.log(
  `${repositoryConfig.label}: origin=${repositoryConfig.origin}, ` +
    `components=${repositoryConfig.components.join(",")}, ` +
    `suites=${repositoryConfig.suites.join(",")}, ` +
    `architectures=${repositoryConfig.architectures.join(",")}`,
);

for await (const entry of Deno.readDir(packagesDir)) {
  if (!entry.isDirectory) continue;
  const packageDir = join(packagesDir, entry.name);
  if (await exists(join(packageDir, "package.toml"))) {
    packageDirs.push(packageDir);
  }
}

for (const packageDir of packageDirs.sort()) {
  const packageConfig = await loadPackageConfig(packageDir);
  const toolchain = await loadToolchainConfig(
    projectDir,
    packageConfig.build.toolchain,
  );
  console.log(
    `${packageConfig.name} ${packageConfig.version}: ` +
      `${packageConfig.source.git}@${packageConfig.source.tag}, ` +
      `sha256=${packageConfig.source.sha256}, ` +
      `${toolchain.kind}=${toolchain.version}`,
  );
}
