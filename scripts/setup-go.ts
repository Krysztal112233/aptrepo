#!/usr/bin/env -S deno run --allow-env=HOME --allow-read --allow-write --allow-net --allow-run

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGoToolchainConfig, parseArchitecture } from "./config.ts";
import { capture, downloadVerified } from "./runtime.ts";
import { goDebPaths } from "./toolchains.ts";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = await loadGoToolchainConfig(projectDir);
const architecture = parseArchitecture(
  await capture("dpkg", ["--print-architecture"]),
);
const target = config.architectures[architecture];
const [compilerDeb, sourceDeb] = goDebPaths(
  projectDir,
  architecture,
  config,
);

await Deno.mkdir(dirname(compilerDeb), { recursive: true });
await Promise.all([
  downloadVerified(
    `${config.downloadBase}/${config.compilerPackage}_${config.debianVersion}_${architecture}.deb`,
    compilerDeb,
    target.compilerSha256,
  ),
  downloadVerified(
    `${config.downloadBase}/${config.sourcePackage}_${config.debianVersion}_all.deb`,
    sourceDeb,
    config.sourceSha256,
  ),
]);

console.log(`Ready: ${compilerDeb}`);
console.log(`Ready: ${sourceDeb}`);
