#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { join } from "node:path";
import { loadGoToolchainConfig } from "./config.ts";
import { downloadVerified, run } from "./runtime.ts";
import { setupToolchain } from "./setup-toolchain.ts";

await setupToolchain({
  loadConfig: loadGoToolchainConfig,
  description: "Pinned Go compiler for local aptrepo builds",
  probeBinary: "bin/go",
  async stage(config, target, packageRoot, downloadDir) {
    const filename = `go${config.version}.${target.target}.tar.gz`;
    const archive = join(downloadDir, filename);
    await downloadVerified(
      `${config.downloadBase}/${filename}`,
      archive,
      target.sha256,
    );
    const prefixDir = join(packageRoot, config.installPrefix.slice(1));
    await Deno.mkdir(prefixDir, { recursive: true });
    await run("tar", [
      "-xzf",
      archive,
      "-C",
      prefixDir,
      "--strip-components=1",
    ]);
  },
}, Deno.args);
