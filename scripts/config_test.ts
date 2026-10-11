import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { loadPackageConfig } from "./config.ts";

const commit = "abcdef0123456789abcdef0123456789abcdef01";

function fixture(
  pin: string,
  updates = "",
  archive = "{git}/archive/{tag}.tar.gz",
  archiveRoot = "fixture-{version}",
): string {
  return `
[package]
name = "fixture"
version = "1.0"
debian_revision = "2"
[source]
git = "https://example.invalid/fixture"
${pin}
archive = "${archive}"
archive_root = "${archiveRoot}"
sha256 = "${"a".repeat(64)}"
${updates}
[build]
toolchain = "rust"
`;
}

async function loadFixture(document: string) {
  const root = await Deno.makeTempDir({ prefix: "aptrepo-config-test-" });
  try {
    const directory = join(root, "fixture");
    await Deno.mkdir(directory);
    await Deno.writeTextFile(join(directory, "package.toml"), document);
    return await loadPackageConfig(directory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("config: existing tag templates retain their build inputs", async () => {
  const config = await loadFixture(fixture('tag = "v{version}"'));
  strictEqual(config.baseVersion, "1.0-2");
  deepStrictEqual(config.source, {
    git: "https://example.invalid/fixture",
    kind: "tag",
    ref: "v1.0",
    tagTemplate: "v{version}",
    archive: "https://example.invalid/fixture/archive/v1.0.tar.gz",
    archiveRoot: "fixture-1.0",
    sha256: "a".repeat(64),
  });
});

Deno.test("config: commit archives are independent of the tracked branch", async () => {
  const config = await loadFixture(fixture(
    `commit = "${commit.toUpperCase()}"`,
    '[updates]\nbranch = "topic/next"',
    "{git}/archive/{commit}.tar.gz",
    "fixture-{commit}",
  ));
  deepStrictEqual(config.source, {
    git: "https://example.invalid/fixture",
    kind: "commit",
    ref: commit,
    updateBranch: "topic/next",
    archive: `https://example.invalid/fixture/archive/${commit}.tar.gz`,
    archiveRoot: `fixture-${commit}`,
    sha256: "a".repeat(64),
  });
});

Deno.test("config: source requires exactly one immutable reference", async () => {
  for (const pin of ["", `tag = "v1.0"\ncommit = "${commit}"`]) {
    await rejects(
      () => loadFixture(fixture(pin)),
      /exactly one of tag or commit/,
    );
  }
  for (const ref of ["main", "nightly", "abcdef01", "g".repeat(40)]) {
    await rejects(
      () => loadFixture(fixture(`commit = "${ref}"`)),
      /full Git SHA-1/,
    );
  }
});

Deno.test("config: snapshots require an explicit discovery branch", async () => {
  await rejects(
    () => loadFixture(fixture(`commit = "${commit}"`)),
    /updates must be a table/,
  );
  await rejects(
    () => loadFixture(fixture(`commit = "${commit}"`, "[updates]")),
    /branch must be a non-empty string/,
  );
  await rejects(
    () =>
      loadFixture(fixture('tag = "v{version}"', '[updates]\nbranch = "main"')),
    /updates.branch requires source.commit/,
  );
});

Deno.test("config: discovery branch rejects options, globs and invalid refs", async () => {
  for (
    const branch of [
      "--all",
      "*",
      "main?",
      "topic[ab]",
      "topic\\\\next",
      "topic next",
      ".hidden",
      "topic/.hidden",
      "topic/a.lock",
      "topic..next",
      "topic//next",
      "topic/",
      "/topic",
      "topic.",
      "@",
      "topic@{next}",
      "topic~1",
      "topic:next",
    ]
  ) {
    await rejects(
      () =>
        loadFixture(fixture(
          `commit = "${commit}"`,
          `[updates]\nbranch = "${branch}"`,
        )),
      /invalid updates.branch/,
    );
  }
});

Deno.test("config: tag and commit placeholders cannot be mixed", async () => {
  await rejects(
    () =>
      loadFixture(fixture(
        `commit = "${commit}"`,
        '[updates]\nbranch = "main"',
      )),
    /unresolved template variable \{tag\}/,
  );
  await rejects(
    () =>
      loadFixture(fixture(
        'tag = "v{version}"',
        "",
        "{git}/archive/{commit}.tar.gz",
      )),
    /unresolved template variable \{commit\}/,
  );
});
