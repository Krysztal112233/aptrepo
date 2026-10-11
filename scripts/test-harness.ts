import { join } from "node:path";

export const projectRoot = new URL("../", import.meta.url).pathname;

/** DENO_DIR of the current Deno installation, for cached-only subprocesses. */
export async function denoDir(): Promise<string> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output();
  return JSON.parse(new TextDecoder().decode(result.stdout)).denoDir;
}

export interface Sandbox {
  root: string;
  bin: string;
  /** Install an executable fixture with exact content. */
  install(name: string, content: string): Promise<void>;
  /** Install a strict POSIX-shell executable fixture. */
  installSh(name: string, body: string): Promise<void>;
}

/** Temp dir holding copies of the given project directories plus a stub bin/. */
export async function makeSandbox(
  prefix: string,
  directories: string[],
): Promise<Sandbox> {
  const root = await Deno.makeTempDir({ prefix });
  for (const directory of directories) {
    const result = await new Deno.Command("cp", {
      args: ["-R", join(projectRoot, directory), root],
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(
        `cp -R ${directory}: ${new TextDecoder().decode(result.stderr)}`,
      );
    }
  }
  const bin = join(root, "bin");
  await Deno.mkdir(bin);
  const install = async (name: string, content: string): Promise<void> => {
    const path = join(bin, name);
    await Deno.writeTextFile(path, content);
    await Deno.chmod(path, 0o755);
  };
  return {
    root,
    bin,
    install,
    installSh: (name, body) => install(name, `#!/bin/sh\nset -eu\n${body}\n`),
  };
}
