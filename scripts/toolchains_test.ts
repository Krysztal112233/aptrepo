import { deepStrictEqual, ok } from "node:assert/strict";
import { join } from "node:path";
import { loadGoToolchainConfig, loadRustToolchainConfig } from "./config.ts";
import { installRustComponent } from "./toolchains.ts";

Deno.test("toolchains: Rust payload copy preserves target files, symlinks and modes without execution", async () => {
  const root = await Deno.makeTempDir({ prefix: "aptrepo-rust-test-" });
  try {
    const source = join(root, "archive/rustc");
    await Deno.mkdir(join(source, "bin"), { recursive: true });
    await Deno.mkdir(join(source, "lib"));
    await Deno.writeTextFile(join(source, "bin/rustc"), "must not execute\n");
    await Deno.chmod(join(source, "bin/rustc"), 0o755);
    await Deno.writeTextFile(join(source, "lib/libLLVM.so"), "library");
    await Deno.symlink("libLLVM.so", join(source, "lib/libLLVM-link.so"));
    await Deno.writeTextFile(join(source, "manifest.in"), "file:bin/rustc\n");
    await Deno.writeTextFile(join(root, "archive/install.sh"), "exit 99\n");
    const prefix = join(root, "package/opt/aptrepo/rust");
    await installRustComponent(join(root, "archive"), "rustc", prefix);
    deepStrictEqual(
      await Deno.readTextFile(join(prefix, "bin/rustc")),
      "must not execute\n",
    );
    deepStrictEqual(
      (await Deno.stat(join(prefix, "bin/rustc"))).mode! & 0o777,
      0o755,
    );
    deepStrictEqual(
      await Deno.readLink(join(prefix, "lib/libLLVM-link.so")),
      "libLLVM.so",
    );
    deepStrictEqual([...Deno.readDirSync(prefix)].map((e) => e.name).sort(), [
      "bin",
      "lib",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const project = new URL("../", import.meta.url).pathname;

// The real setup entrypoints use fake download/archive/packaging commands in an
// isolated project/cache. No toolchain archive or Debian package is built.
Deno.test("setup-go/setup-rust: serial target packaging plus native vendoring tools on either host", async () => {
  const denoInfo = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output();
  const denoDir = JSON.parse(new TextDecoder().decode(denoInfo.stdout)).denoDir;
  const root = await Deno.makeTempDir({ prefix: "aptrepo-setup-test-" });
  try {
    for (const dir of ["scripts", "toolchains"]) {
      const status = await new Deno.Command("cp", {
        args: ["-R", join(project, dir), root],
      }).output();
      ok(status.success);
    }
    const go = await loadGoToolchainConfig(root);
    const rust = await loadRustToolchainConfig(root);
    const checksums: Record<string, string> = {};
    for (const arch of ["amd64", "arm64"] as const) {
      checksums[`go${go.version}.${go.architectures[arch].target}.tar.gz`] =
        go.architectures[arch].sha256;
      for (const component of rust.components) {
        checksums[
          `${component}-${rust.version}-${
            rust.architectures[arch].target
          }.tar.xz`
        ] = rust.architectures[arch].sha256[component];
      }
    }
    const bin = join(root, "bin");
    await Deno.mkdir(bin);
    const stub =
      `#!/usr/bin/env -S ${Deno.execPath()} run --cached-only --allow-read --allow-write --allow-env=MOCK_HOST,MOCK_LOG
import { basename, dirname, join } from "node:path";
const command = basename(new URL(import.meta.url).pathname);
const args = Deno.args;
const log = (line) => Deno.writeTextFileSync(Deno.env.get("MOCK_LOG"), line + "\\n", { append: true });
const write = (path, content = "fixture") => { Deno.mkdirSync(dirname(path), { recursive: true }); Deno.writeTextFileSync(path, content); };
if (command === "dpkg") console.log(Deno.env.get("MOCK_HOST"));
else if (command === "curl") { log("download"); write(args[args.indexOf("--output") + 1]); }
else if (command === "sha256sum") {
  const hashes = ${JSON.stringify(checksums)};
  const hash = hashes[basename(args[0]).replace(/\\.part$/, "")];
  if (!hash) throw new Error("Unexpected checksum input");
  console.log(hash + "  " + args[0]);
} else if (command === "tar") {
  const filename = basename(args[1]);
  const dest = args[args.indexOf("-C") + 1];
  if (filename.startsWith("go")) write(join(dest, "bin/go"));
  else {
    const stem = filename.replace(/\\.tar\\.xz$/, "");
    const component = filename.startsWith("rust-std") ? "rust-std" : filename.split("-")[0];
    const triple = stem.slice((component + "-${rust.version}-").length);
    const payload = component === "rust-std" ? component + "-" + triple : component;
    write(join(dest, stem, payload, component === "rust-std" ? "lib/rustlib/fixture" : "bin/" + component));
    write(join(dest, stem, payload, "manifest.in"));
    write(join(dest, stem, "install.sh"), "exit 99\\n");
  }
} else if (command === "dpkg-deb") {
  if (args.includes("--build")) {
    const control = Deno.readTextFileSync(join(args[args.indexOf("--build") + 1], "DEBIAN/control"));
    const arch = control.match(/Architecture: (.*)/)[1];
    log("build:" + arch);
    write(args.at(-1), control);
  } else if (args[0] === "--extract") {
    const control = Deno.readTextFileSync(args[1]);
    const kind = control.includes("Package: ${go.packageName}\\n") ? "go" : "rust";
    log("extract:" + control.match(/Architecture: (.*)/)[1]);
    write(join(args[2], kind === "go" ? "${
        go.installPrefix.slice(1)
      }/bin/go" : "${rust.installPrefix.slice(1)}/bin/cargo"));
  } else throw new Error("Unexpected dpkg-deb invocation");
} else if (command === "unshare") {
  if (!args.includes("--map-auto") || !args.includes("--map-root-user") || !args.includes("--propagation") || !args.includes("--mode=root")) throw new Error("Namespace regression");
  log("chroot:" + args.find((arg) => arg.startsWith("--architectures=")));
  write(args.at(-2));
} else throw new Error("Unexpected command");
`;
    for (
      const name of ["dpkg", "curl", "sha256sum", "tar", "dpkg-deb", "unshare"]
    ) {
      await Deno.writeTextFile(join(bin, name), stub);
      await Deno.chmod(join(bin, name), 0o755);
    }
    const log = join(root, "log");
    for (const host of ["amd64", "arm64"] as const) {
      const env = {
        PATH: `${bin}:${Deno.env.get("PATH")}`,
        DENO_DIR: denoDir,
        XDG_CACHE_HOME: join(root, "cache"),
        MOCK_HOST: host,
        MOCK_LOG: log,
      };
      for (const kind of ["go", "rust"]) {
        const foreign = host === "amd64" ? "arm64" : "amd64";
        for (const selection of [undefined, host, foreign]) {
          await Deno.remove(join(root, "build"), { recursive: true }).catch(
            () => {},
          );
          await Deno.remove(env.XDG_CACHE_HOME, { recursive: true }).catch(
            () => {},
          );
          await Deno.writeTextFile(log, "");
          const result = await new Deno.Command(Deno.execPath(), {
            args: [
              "run",
              "--cached-only",
              "--allow-env=HOME,XDG_CACHE_HOME",
              "--allow-read",
              "--allow-write",
              "--allow-run",
              `scripts/setup-${kind}.ts`,
              ...(selection ? [selection] : []),
            ],
            cwd: root,
            env,
            stdout: "piped",
            stderr: "piped",
          }).output();
          ok(result.success, new TextDecoder().decode(result.stderr));
          const order = selection === undefined
            ? ["amd64", "arm64"]
            : selection === host
            ? [host]
            : [foreign, host];
          const events = (await Deno.readTextFile(log)).trim().split("\n")
            .filter((line) => line !== "download");
          deepStrictEqual(
            events,
            order.flatMap((arch) => [`build:${arch}`, `extract:${arch}`]),
          );
        }
      }
      // Native chroot setup must neither require nor invoke QEMU/arch-test.
      await Deno.writeTextFile(log, "");
      const result = await new Deno.Command("sh", {
        args: ["scripts/setup-sbuild", "trixie", host],
        cwd: root,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      ok(result.success, new TextDecoder().decode(result.stderr));
      deepStrictEqual(
        (await Deno.readTextFile(log)).trim(),
        `chroot:--architectures=${host}`,
      );
      ok(
        (await Deno.stat(
          join(env.XDG_CACHE_HOME, `sbuild/trixie-${host}.tar.zst`),
        )).isFile,
      );
      for (
        const args of [["all", host], ["trixie", "armhf"], [
          "trixie",
          host,
          "extra",
        ]]
      ) {
        await Deno.writeTextFile(log, "");
        const invalid = await new Deno.Command("sh", {
          args: ["scripts/setup-sbuild", ...args],
          cwd: root,
          env,
          stdout: "piped",
          stderr: "piped",
        }).output();
        ok(!invalid.success);
        deepStrictEqual(await Deno.readTextFile(log), "");
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
