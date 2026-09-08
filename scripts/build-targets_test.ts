import { deepStrictEqual, rejects, throws } from "node:assert/strict";
import {
  parseBuildArgs,
  parseSelection,
  parseSetupArgs,
  preflightBuild,
  preflightForeignExecution,
  suites,
  targetArchitectures,
  toolchainArchitectures,
} from "./build-targets.ts";

Deno.test("build-targets: defaults, explicit targets, host toolchains", () => {
  deepStrictEqual(parseBuildArgs([]), { suite: "trixie", selection: "all" });
  deepStrictEqual(targetArchitectures(parseSetupArgs([])), ["amd64", "arm64"]);
  for (const host of ["amd64", "arm64"] as const) {
    for (const target of ["amd64", "arm64"] as const) {
      deepStrictEqual(targetArchitectures(parseSelection(target)), [target]);
      deepStrictEqual(
        toolchainArchitectures(target, host),
        target === host ? [target] : [target, host],
      );
      for (const suite of suites) {
        deepStrictEqual(parseBuildArgs([suite, target]), {
          suite,
          selection: target,
        });
      }
    }
    deepStrictEqual(toolchainArchitectures("all", host), ["amd64", "arm64"]);
  }
});

Deno.test("build-targets: reject malformed or surplus arguments", () => {
  for (
    const arch of ["", "ARM64", "armhf", "amd64,arm64", "../arm64", "--dry-run"]
  ) {
    throws(() => parseSelection(arch));
    throws(() => parseBuildArgs(["trixie", arch]));
    throws(() => parseSetupArgs([arch]));
  }
  for (const suite of ["", "all", "sid", "../trixie"]) {
    throws(() => parseBuildArgs([suite]));
  }
  throws(() => parseBuildArgs(["trixie", "amd64", "extra"]));
  throws(() => parseSetupArgs(["amd64", "extra"]));
});

Deno.test("build-targets: check every chroot before foreign execution", async () => {
  const checked: string[] = [];
  await rejects(() =>
    preflightBuild(suites, "all", "amd64", "/cache", {
      exists: (path) => {
        checked.push(path);
        return Promise.resolve(!path.endsWith("forky-arm64.tar.zst"));
      },
      readTextFile: () => {
        throw new Error("must not probe yet");
      },
      capture: () => {
        throw new Error("must not execute yet");
      },
    }), /just setup-sbuild forky arm64/);
  deepStrictEqual(
    checked,
    suites.flatMap((suite) =>
      ["amd64", "arm64"].map((arch) => `/cache/sbuild/${suite}-${arch}.tar.zst`)
    ),
  );
});

Deno.test("build-targets: native bypass, enabled F registration, arch-test failures", async () => {
  for (const host of ["amd64", "arm64"] as const) {
    const foreign = host === "amd64" ? "arm64" : "amd64";
    const probes: string[] = [];
    const runtime = {
      exists: () => Promise.resolve(true),
      readTextFile: (path: string) => {
        probes.push(path);
        return Promise.resolve(
          path.endsWith("/status") ? "enabled\n" : "enabled\nflags: POF\n",
        );
      },
      capture: (command: string, args: string[]) => {
        probes.push(`${command} ${args.join(" ")}`);
        return Promise.resolve("ok");
      },
    };
    await preflightBuild(["trixie"], host, host, "/cache", runtime);
    deepStrictEqual(probes, []);
    await preflightForeignExecution([foreign], host, runtime);
    deepStrictEqual(probes, [
      "/proc/sys/fs/binfmt_misc/status",
      `/proc/sys/fs/binfmt_misc/qemu-${
        foreign === "arm64" ? "aarch64" : "x86_64"
      }`,
      `arch-test ${foreign}`,
    ]);
    for (
      const registration of ["enabled\nflags: PO\n", "disabled\nflags: F\n"]
    ) {
      await rejects(() =>
        preflightForeignExecution([foreign], host, {
          ...runtime,
          readTextFile: (path) =>
            Promise.resolve(
              path.endsWith("/status") ? "enabled" : registration,
            ),
        }), /F flag/);
    }
    await rejects(() =>
      preflightForeignExecution([foreign], host, {
        ...runtime,
        readTextFile: () => Promise.reject(new Deno.errors.NotFound()),
      }), /Install host QEMU/);
    await rejects(() =>
      preflightForeignExecution([foreign], host, {
        ...runtime,
        capture: () => Promise.reject(new Error("arch-test missing or failed")),
      }), /arch-test missing or failed/);
    await rejects(() =>
      preflightForeignExecution([foreign], host, {
        ...runtime,
        readTextFile: () => Promise.resolve("disabled"),
      }), /F flag/);
  }
});
