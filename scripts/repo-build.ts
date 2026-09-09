#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-run

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DebianSuite,
  loadRepositoryConfig,
  type RepositoryConfig,
} from "./config.ts";
import { capture, exists, renderTemplate, run } from "./runtime.ts";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(projectDir, "repo");

const distributionsTemplate = `{{#suites}}
Origin: {{origin}}
Label: {{label}}
Codename: {{name}}
Architectures: {{architectures}}
Components: {{components}}
SignWith: {{signingKey}}

{{/suites}}`;

interface DebInfo {
  path: string;
  name: string;
  version: string;
  architecture: string;
}

async function requireReprepro(): Promise<void> {
  try {
    await capture("reprepro", ["--version"]);
  } catch {
    throw new Error("reprepro is not installed");
  }
}

async function requireSigningKey(signingKey: string): Promise<void> {
  const keyId = signingKey.slice(-16);
  let listing: string;
  try {
    listing = await capture("gpg", [
      "--batch",
      "--list-secret-keys",
      "--with-colons",
      signingKey,
    ]);
  } catch {
    throw new Error(
      `Signing key ${signingKey} is not in the GPG keyring`,
    );
  }
  const key = listing.split("\n").find((line) =>
    (line.startsWith("sec:") || line.startsWith("ssb:")) &&
    line.split(":")[4] === keyId
  );
  if (!key) {
    throw new Error(
      `Signing key ${signingKey} is not in the GPG keyring`,
    );
  }
  if (key.split(":")[14] === "#") {
    throw new Error(
      `Secret key for ${signingKey} is not available (insert the smartcard)`,
    );
  }
}

async function renderDistributions(
  config: RepositoryConfig,
): Promise<boolean> {
  const confDir = join(repoDir, "conf");
  await Deno.mkdir(confDir, { recursive: true });
  const path = join(confDir, "distributions");
  const content = renderTemplate(distributionsTemplate, {
    origin: config.origin,
    label: config.label,
    signingKey: config.signingKey,
    components: config.components.join(" "),
    suites: config.suites.map((suite) => ({
      name: suite,
      architectures: config.suiteArchitectures[suite].join(" "),
    })),
  }, "distributions template");
  if (await exists(path) && await Deno.readTextFile(path) === content) {
    return false;
  }
  await Deno.writeTextFile(path, content);
  return true;
}

async function includedDebs(suite: string): Promise<Set<string>> {
  let listing: string;
  try {
    listing = await capture("reprepro", [
      "-Vb",
      repoDir,
      "list",
      suite,
    ]);
  } catch {
    return new Set();
  }
  return new Set(
    listing.split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const match = line.match(
          /^[^|]+\|[^|]+\|([^:]+): (\S+) (\S+)$/,
        );
        if (!match) {
          throw new Error(
            `Unexpected reprepro list line: ${line}`,
          );
        }
        return `${match[2]} ${match[3]} ${match[1].trim()}`;
      }),
  );
}

async function readDebInfo(path: string): Promise<DebInfo> {
  const fields = await capture("dpkg-deb", [
    "-W",
    "--showformat=${Package}|${Version}|${Architecture}",
    path,
  ]);
  const [name, version, architecture] = fields.split("|");
  return { path, name, version, architecture };
}

async function includeSuite(
  config: RepositoryConfig,
  suite: DebianSuite,
): Promise<void> {
  const buildDir = join(projectDir, "build", suite);
  if (!await exists(buildDir)) {
    console.log(`Skipping ${suite}: no build output`);
    return;
  }
  const existing = await includedDebs(suite);
  const accepted = new Set<string>([
    ...config.suiteArchitectures[suite],
    "all",
  ]);
  const names: string[] = [];
  for await (const entry of Deno.readDir(buildDir)) {
    if (entry.isFile && entry.name.endsWith(".deb")) {
      names.push(entry.name);
    }
  }
  for (const name of names.sort()) {
    const deb = await readDebInfo(join(buildDir, name));
    if (!accepted.has(deb.architecture)) {
      console.log(
        `Skipping ${name}: architecture ${deb.architecture}`,
      );
      continue;
    }
    if (
      existing.has(
        `${deb.name} ${deb.version} ${deb.architecture}`,
      )
    ) {
      console.log(
        `Already included: ${deb.name} ${deb.version} (${suite})`,
      );
      continue;
    }
    console.log(
      `Including ${deb.name} ${deb.version} into ${suite}`,
    );
    await run("reprepro", [
      "-Vb",
      repoDir,
      "includedeb",
      suite,
      deb.path,
    ]);
  }
}

const config = await loadRepositoryConfig(projectDir);
await requireReprepro();
await requireSigningKey(config.signingKey);
const distributionsChanged = await renderDistributions(config);
for (const suite of config.suites) {
  await includeSuite(config, suite);
}
await run("reprepro", ["-Vb", repoDir, "deleteunreferenced"]);
for (const suite of config.suites) {
  if (
    distributionsChanged ||
    !await exists(join(repoDir, "dists", suite))
  ) {
    await run("reprepro", ["-Vb", repoDir, "export", suite]);
  }
}

console.log(`
Repository assembled in ${repoDir}
Serve it with any static file server, then on clients:
  deb [signed-by=/usr/share/keyrings/krysztal-archive-keyring.pgp] <url> <suite> ${
  config.components.join(" ")
}
where <suite> is one of: ${config.suites.join(", ")}
`);
