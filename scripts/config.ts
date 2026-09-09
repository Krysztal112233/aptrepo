#!/usr/bin/env -S deno run --allow-env=HOME,XDG_CACHE_HOME --allow-read --allow-write --allow-net --allow-run

import { basename, join } from "node:path";
import { parse } from "npm:smol-toml@1.7.0";

export const supportedArchitectures = ["amd64", "arm64", "riscv64"] as const;
export type DebianArchitecture = typeof supportedArchitectures[number];
export const supportedSuites = ["bookworm", "trixie", "forky"] as const;
export type DebianSuite = typeof supportedSuites[number];
export type ToolchainKind = "go" | "rust";

export const defaultSuiteArchitectures: Record<
  DebianSuite,
  readonly DebianArchitecture[]
> = {
  bookworm: ["amd64", "arm64"],
  trixie: ["amd64", "arm64", "riscv64"],
  forky: ["amd64", "arm64", "riscv64"],
};

type Table = Record<string, unknown>;

export interface RepositoryConfig {
  configPath: string;
  origin: string;
  label: string;
  signingKey: string;
  components: string[];
  suites: DebianSuite[];
  /** Union of every suite's architectures, for web/index surfaces. */
  architectures: DebianArchitecture[];
  /** Per-suite architecture matrix used by setup/build/reprepro. */
  suiteArchitectures: Record<DebianSuite, DebianArchitecture[]>;
}

export interface PackageConfig {
  configPath: string;
  name: string;
  version: string;
  debianRevision: string;
  baseVersion: string;
  source: {
    git: string;
    tag: string;
    archive: string;
    archiveRoot: string;
    sha256: string;
  };
  build: {
    toolchain: ToolchainKind;
  };
}

export interface GoToolchainConfig {
  configPath: string;
  fingerprint: string;
  kind: "go";
  version: string;
  packageName: string;
  packageRevision: string;
  packageVersion: string;
  packageDependencies: string[];
  downloadBase: string;
  installPrefix: string;
  architectures: Record<
    DebianArchitecture,
    { target: string; sha256: string }
  >;
}

export interface RustToolchainConfig {
  configPath: string;
  fingerprint: string;
  kind: "rust";
  version: string;
  packageName: string;
  packageRevision: string;
  packageVersion: string;
  packageDependencies: string[];
  downloadBase: string;
  installPrefix: string;
  components: string[];
  architectures: Record<
    DebianArchitecture,
    { target: string; sha256: Record<string, string> }
  >;
}

export type ToolchainConfig = GoToolchainConfig | RustToolchainConfig;

export async function loadRepositoryConfig(
  projectDir: string,
): Promise<RepositoryConfig> {
  const configPath = join(projectDir, "repository.toml");
  const { document } = await loadToml(configPath);
  const components = readUniqueStringArray(
    document,
    "components",
    configPath,
  );
  for (const component of components) {
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(component)) {
      throw new Error(
        `${configPath}: invalid repository component ${component}`,
      );
    }
  }

  const suites = readSupportedStringArray(
    document,
    "suites",
    supportedSuites,
    configPath,
  );
  const suiteArchitectures = readSuiteArchitectures(
    document,
    suites,
    configPath,
  );
  return {
    configPath,
    origin: readSingleLineString(document, "origin", configPath),
    label: readSingleLineString(document, "label", configPath),
    signingKey: readSigningKey(document, "signing_key", configPath),
    components,
    suites,
    architectures: uniqueArchitectures(suites, suiteArchitectures),
    suiteArchitectures,
  };
}

export function suiteArchitectures(
  suite: DebianSuite,
  matrix: Record<DebianSuite, readonly DebianArchitecture[]> =
    defaultSuiteArchitectures,
): DebianArchitecture[] {
  return [...matrix[suite]];
}

export function uniqueArchitectures(
  suites: readonly DebianSuite[],
  matrix: Record<DebianSuite, readonly DebianArchitecture[]> =
    defaultSuiteArchitectures,
): DebianArchitecture[] {
  const seen = new Set<DebianArchitecture>();
  const architectures: DebianArchitecture[] = [];
  for (const suite of suites) {
    for (const architecture of matrix[suite]) {
      if (!seen.has(architecture)) {
        seen.add(architecture);
        architectures.push(architecture);
      }
    }
  }
  return architectures;
}

export async function loadPackageConfig(
  packageDir: string,
): Promise<PackageConfig> {
  const configPath = join(packageDir, "package.toml");
  const { document } = await loadToml(configPath);
  const packageTable = readTable(document, "package", configPath);
  const sourceTable = readTable(document, "source", configPath);
  const buildTable = readTable(document, "build", configPath);

  const name = readString(packageTable, "name", configPath);
  if (name !== basename(packageDir)) {
    throw new Error(
      `${configPath}: package.name must match directory ${
        basename(packageDir)
      }`,
    );
  }
  if (!/^[a-z0-9][a-z0-9+.-]+$/.test(name)) {
    throw new Error(
      `${configPath}: invalid Debian package name ${name}`,
    );
  }

  const version = readString(packageTable, "version", configPath);
  const debianRevision = readString(
    packageTable,
    "debian_revision",
    configPath,
  );
  const git = readUrl(sourceTable, "git", configPath);
  const tag = interpolate(
    readString(sourceTable, "tag", configPath),
    { version },
    configPath,
  );
  const variables = { git, tag, version };
  const archive = readResolvedUrl(
    sourceTable,
    "archive",
    variables,
    configPath,
  );
  const archiveRoot = interpolate(
    readString(sourceTable, "archive_root", configPath),
    variables,
    configPath,
  );
  const sha256 = readSha256(sourceTable, "sha256", configPath);
  const toolchain = readToolchainKind(
    buildTable,
    "toolchain",
    configPath,
  );

  return {
    configPath,
    name,
    version,
    debianRevision,
    baseVersion: `${version}-${debianRevision}`,
    source: { git, tag, archive, archiveRoot, sha256 },
    build: { toolchain },
  };
}

export async function loadToolchainConfig(
  projectDir: string,
  kind: ToolchainKind,
): Promise<ToolchainConfig> {
  return kind === "go"
    ? await loadGoToolchainConfig(projectDir)
    : await loadRustToolchainConfig(projectDir);
}

export async function loadGoToolchainConfig(
  projectDir: string,
): Promise<GoToolchainConfig> {
  const configPath = join(projectDir, "toolchains/go.toml");
  const { document, fingerprint } = await loadToml(configPath);
  expectValue(document, "kind", "go", configPath);

  const version = readString(document, "version", configPath);
  const packageRevision = readString(
    document,
    "package_revision",
    configPath,
  );

  const architectures = readTable(document, "architectures", configPath);
  const architectureConfigs = Object.fromEntries(
    supportedArchitectures.map((architecture) => {
      const table = readTable(
        architectures,
        architecture,
        configPath,
      );
      return [
        architecture,
        {
          target: readString(
            table,
            "target",
            configPath,
          ),
          sha256: readSha256(
            table,
            "sha256",
            configPath,
          ),
        },
      ];
    }),
  ) as GoToolchainConfig["architectures"];

  return {
    configPath,
    fingerprint,
    kind: "go",
    version,
    packageName: readString(document, "package_name", configPath),
    packageRevision,
    packageVersion: `${version}-${packageRevision}`,
    packageDependencies: readStringArray(
      document,
      "package_dependencies",
      configPath,
    ),
    downloadBase: readUrl(document, "download_base", configPath),
    installPrefix: readAbsolutePath(
      document,
      "install_prefix",
      configPath,
    ),
    architectures: architectureConfigs,
  };
}

export async function loadRustToolchainConfig(
  projectDir: string,
): Promise<RustToolchainConfig> {
  const configPath = join(projectDir, "toolchains/rust.toml");
  const { document, fingerprint } = await loadToml(configPath);
  expectValue(document, "kind", "rust", configPath);

  const version = readString(document, "version", configPath);
  const packageRevision = readString(
    document,
    "package_revision",
    configPath,
  );
  const components = readStringArray(document, "components", configPath);
  if (new Set(components).size !== components.length) {
    throw new Error(`${configPath}: components must be unique`);
  }

  const architectures = readTable(document, "architectures", configPath);
  const architectureConfigs = Object.fromEntries(
    supportedArchitectures.map((architecture) => {
      const table = readTable(
        architectures,
        architecture,
        configPath,
      );
      const checksums = readTable(
        table,
        "sha256",
        configPath,
      );
      return [
        architecture,
        {
          target: readString(
            table,
            "target",
            configPath,
          ),
          sha256: Object.fromEntries(
            components.map((component) => [
              component,
              readSha256(
                checksums,
                component,
                configPath,
              ),
            ]),
          ),
        },
      ];
    }),
  ) as RustToolchainConfig["architectures"];

  return {
    configPath,
    fingerprint,
    kind: "rust",
    version,
    packageName: readString(document, "package_name", configPath),
    packageRevision,
    packageVersion: `${version}-${packageRevision}`,
    packageDependencies: readStringArray(
      document,
      "package_dependencies",
      configPath,
    ),
    downloadBase: readUrl(document, "download_base", configPath),
    installPrefix: readAbsolutePath(
      document,
      "install_prefix",
      configPath,
    ),
    components,
    architectures: architectureConfigs,
  };
}

export function parseArchitecture(value: string): DebianArchitecture {
  if ((supportedArchitectures as readonly string[]).includes(value)) {
    return value as DebianArchitecture;
  }
  throw new Error(`Unsupported architecture: ${value}`);
}

async function loadToml(
  configPath: string,
): Promise<{ document: Table; fingerprint: string }> {
  const text = await Deno.readTextFile(configPath);
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new Error(`${configPath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return {
    document: asTable(parsed, "document", configPath),
    fingerprint: await sha256Text(text),
  };
}

function asTable(value: unknown, field: string, configPath: string): Table {
  if (
    typeof value !== "object" || value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${configPath}: ${field} must be a table`);
  }
  return value as Table;
}

function readTable(table: Table, field: string, configPath: string): Table {
  return asTable(table[field], field, configPath);
}

function readString(table: Table, field: string, configPath: string): string {
  const value = table[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${configPath}: ${field} must be a non-empty string`,
    );
  }
  return value;
}

function readStringArray(
  table: Table,
  field: string,
  configPath: string,
): string[] {
  const value = table[field];
  if (
    !Array.isArray(value) || value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(
      `${configPath}: ${field} must be non-empty strings`,
    );
  }
  return value as string[];
}

function readUniqueStringArray(
  table: Table,
  field: string,
  configPath: string,
): string[] {
  const values = readStringArray(table, field, configPath);
  if (new Set(values).size !== values.length) {
    throw new Error(`${configPath}: ${field} must be unique`);
  }
  return values;
}

function readSupportedStringArray<const Value extends string>(
  table: Table,
  field: string,
  supported: readonly Value[],
  configPath: string,
): Value[] {
  const values = readUniqueStringArray(table, field, configPath);
  for (const value of values) {
    if (!(supported as readonly string[]).includes(value)) {
      throw new Error(`${configPath}: unsupported ${field} value ${value}`);
    }
  }
  return values as Value[];
}

function readSuiteArchitectures(
  document: Table,
  suites: DebianSuite[],
  configPath: string,
): Record<DebianSuite, DebianArchitecture[]> {
  if ("architectures" in document) {
    throw new Error(
      `${configPath}: use suite_architectures instead of architectures`,
    );
  }
  const table = readTable(document, "suite_architectures", configPath);
  const unexpected = Object.keys(table).filter(
    (suite) => !(suites as readonly string[]).includes(suite),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `${configPath}: suite_architectures has suites not listed in suites: ${
        unexpected.join(", ")
      }`,
    );
  }
  const suiteArchitectures = {} as Record<DebianSuite, DebianArchitecture[]>;
  for (const suite of suites) {
    suiteArchitectures[suite] = readSupportedStringArray(
      table,
      suite,
      supportedArchitectures,
      configPath,
    );
  }
  return suiteArchitectures;
}

function readSingleLineString(
  table: Table,
  field: string,
  configPath: string,
): string {
  const value = readString(table, field, configPath);
  if (value.trim() !== value || /[\r\n]/.test(value)) {
    throw new Error(
      `${configPath}: ${field} must be a single trimmed line`,
    );
  }
  return value;
}

function readUrl(table: Table, field: string, configPath: string): string {
  const value = readString(table, field, configPath);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new Error("HTTPS is required");
    }
  } catch (error) {
    throw new Error(
      `${configPath}: invalid ${field}: ${errorMessage(error)}`,
    );
  }
  return value.replace(/\/$/, "");
}

function readResolvedUrl(
  table: Table,
  field: string,
  variables: Record<string, string>,
  configPath: string,
): string {
  const resolved = interpolate(
    readString(table, field, configPath),
    variables,
    configPath,
  );
  try {
    const url = new URL(resolved);
    if (url.protocol !== "https:") {
      throw new Error("HTTPS is required");
    }
  } catch (error) {
    throw new Error(
      `${configPath}: invalid ${field}: ${errorMessage(error)}`,
    );
  }
  return resolved;
}

function readAbsolutePath(
  table: Table,
  field: string,
  configPath: string,
): string {
  const value = readString(table, field, configPath);
  if (!value.startsWith("/")) {
    throw new Error(
      `${configPath}: ${field} must be an absolute path`,
    );
  }
  return value.replace(/\/$/, "");
}

function readSha256(table: Table, field: string, configPath: string): string {
  const value = readString(table, field, configPath).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      `${configPath}: ${field} must be a SHA-256 digest`,
    );
  }
  return value;
}

function readSigningKey(
  table: Table,
  field: string,
  configPath: string,
): string {
  const value = readString(table, field, configPath).toUpperCase();
  if (!/^([0-9A-F]{16}|[0-9A-F]{40})$/.test(value)) {
    throw new Error(
      `${configPath}: ${field} must be a key ID or fingerprint`,
    );
  }
  return value;
}

function readToolchainKind(
  table: Table,
  field: string,
  configPath: string,
): ToolchainKind {
  const value = readString(table, field, configPath);
  if (value !== "go" && value !== "rust") {
    throw new Error(
      `${configPath}: unsupported toolchain ${value}`,
    );
  }
  return value;
}

function expectValue(
  table: Table,
  field: string,
  expected: string,
  configPath: string,
): void {
  const value = readString(table, field, configPath);
  if (value !== expected) {
    throw new Error(`${configPath}: ${field} must be ${expected}`);
  }
}

function interpolate(
  template: string,
  variables: Record<string, string>,
  configPath: string,
): string {
  let result = template;
  for (const [name, value] of Object.entries(variables)) {
    result = result.replaceAll(`{${name}}`, value);
  }
  const unresolved = result.match(/\{[^{}]+\}/)?.[0];
  if (unresolved) {
    throw new Error(
      `${configPath}: unresolved template variable ${unresolved}`,
    );
  }
  return result;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
