#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepositoryConfig } from "./config.ts";
import { exists } from "./runtime.ts";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(projectDir, "repo");

interface PackageEntry {
  name: string;
  description: string;
  homepage: string;
  versions: Record<string, string>;
}

async function readPackages(
  suite: string,
  component: string,
  architecture: string,
): Promise<
  Map<string, { version: string; description: string; homepage: string }>
> {
  const entries = new Map<
    string,
    { version: string; description: string; homepage: string }
  >();
  const path = join(
    repoDir,
    "dists",
    suite,
    component,
    `binary-${architecture}`,
    "Packages",
  );
  if (!(await exists(path))) return entries;

  const content = await Deno.readTextFile(path);
  for (const stanza of content.split("\n\n")) {
    const fields = new Map<string, string>();
    for (const line of stanza.split("\n")) {
      if (line.startsWith(" ") || line.startsWith("\t")) continue;
      const colon = line.indexOf(":");
      if (colon > 0 && !fields.has(line.slice(0, colon))) {
        fields.set(line.slice(0, colon), line.slice(colon + 1).trim());
      }
    }
    const name = fields.get("Package");
    const version = fields.get("Version");
    if (name && version) {
      entries.set(name, {
        version,
        description: fields.get("Description") ?? "",
        homepage: fields.get("Homepage") ?? "",
      });
    }
  }
  return entries;
}

const config = await loadRepositoryConfig(projectDir);

const packages = new Map<string, PackageEntry>();
for (const suite of config.suites) {
  for (const component of config.components) {
    for (const architecture of config.suiteArchitectures[suite]) {
      const entries = await readPackages(suite, component, architecture);
      for (const [name, entry] of entries) {
        let pkg = packages.get(name);
        if (!pkg) {
          pkg = {
            name,
            description: entry.description,
            homepage: entry.homepage,
            versions: {},
          };
          packages.set(name, pkg);
        }
        pkg.versions[suite] = entry.version;
        if (entry.description) pkg.description = entry.description;
        if (entry.homepage) pkg.homepage = entry.homepage;
      }
    }
  }
}

const index = {
  origin: config.origin,
  label: config.label,
  suites: config.suites,
  components: config.components,
  architectures: config.architectures,
  generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
};

const path = join(repoDir, "index.json");
await Deno.writeTextFile(path, JSON.stringify(index, null, 2) + "\n");
console.log(`Wrote ${path} (${packages.size} packages)`);
