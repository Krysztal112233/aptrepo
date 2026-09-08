# Building Packages

After [setting up the build environment](build-environment.md), build all nine
packages for bookworm, trixie and forky, for **amd64 then arm64** per suite:

```sh
just build-all
```

All package/suite/architecture build steps are serial. To select only one
target:

```sh
just build-all amd64
just d2::build trixie arm64
just just::build trixie arm64
just d2::build-all arm64       # all three suites, only arm64
just d2::build                # trixie, both architectures
```

Each package's direct script has the same `[suite] [all|amd64|arm64]` arguments
and defaults. Just also sets up the appropriate toolchain automatically; direct
scripts expect it already prepared:

```sh
./scripts/setup-go.ts arm64
./packages/d2/build.ts trixie arm64
```

Incremental builds retain the first `since` argument and accept architecture
selection second. They consider both commits and working-tree changes:

```sh
just build-changed "24 hours ago"          # both architectures, all suites
just build-changed "2 days ago" arm64
just build-changed-dry "2 days ago" arm64
./scripts/incremental-build.ts "2 days ago" arm64 --dry-run
```

Dry-run reports the selected commands without requiring chroots, setting up
compilers or building. Non-dry builds validate the full selection and all
required chroots before the first package build. Missing
chroot/foreign-execution errors include setup guidance. Native-only builds do
not need emulation.

Build outputs are written to `build/<suite>/`, with `_<arch>.deb`,
`_<arch>.changes`, and `_<arch>.buildinfo` names. ARM64 builds use native arm64
compilers and execute target programs inside emulated-native sbuild chroots;
host-native tools handle source vendoring. No true cross-target Debian rules are
introduced.

Do not run independent builders simultaneously in the same workdir/cache; shared
`.part` paths are not locked. See the environment guide for cache boundaries and
resource/cost caveats. Dual architecture acceptance in `repository.toml` does
not publish artifacts or change repository indexing/the web architecture
selector; web ARM selection is outside this build slice.

Hermetic development checks (no toolchain/chroot downloads or package builds):

```sh
deno fmt --check scripts/*.ts packages/*/build.ts examples/*/build.ts
deno lint scripts/*.ts packages/*/build.ts
deno check scripts/*.ts packages/*/build.ts
./scripts/check-config.ts
deno test --allow-env --allow-read --allow-write --allow-run scripts/*_test.ts
sh -n scripts/setup-sbuild
just --dry-run d2::build trixie arm64
```
