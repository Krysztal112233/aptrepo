#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { join } from "node:path";
import { loadRustToolchainConfig } from "./config.ts";
import { downloadVerified, run } from "./runtime.ts";
import { installRustComponent } from "./toolchains.ts";
import { setupToolchain } from "./setup-toolchain.ts";

await setupToolchain({
  loadConfig: loadRustToolchainConfig,
  description: "Pinned Rust compiler for local aptrepo builds",
  probeBinary: "bin/cargo",
  async stage(config, target, packageRoot, downloadDir, workDir) {
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
        component === "rust-std" ? `${component}-${target.target}` : component,
        join(packageRoot, config.installPrefix.slice(1)),
      );
    }
  },
}, Deno.args);
