# Building Packages

After [setting up the build environment](build-environment.md), build all nine
packages for every suite. The build matrix is **amd64-only**
(`scripts/config.ts`); `repository.toml` still publishes the wider per-suite
architecture matrix for previously built foreign artifacts:

```sh
just build-all
```

All package/suite build steps are serial. To select only one target:

```sh
just build-all amd64              # same as plain `just build-all`
just d2::build trixie             # trixie, amd64
just d2::build-all                # every suite, amd64
```

Each package's direct script has the same `[suite] [all|amd64]` selection;
foreign architecture names still parse but are rejected by the amd64-only
build matrix. Just also sets up the appropriate toolchain automatically;
direct scripts expect it already prepared:

```sh
./scripts/setup-go.ts amd64
./packages/d2/build.ts trixie amd64
```

Incremental builds retain the first `since` argument and accept architecture
selection second. They consider both commits and working-tree changes:

```sh
just build-changed "24 hours ago"          # all suites, amd64
just build-changed-dry "2 days ago"
./scripts/incremental-build.ts "2 days ago" --dry-run
```

Dry-run reports the selected commands without requiring chroots, setting up
compilers or building. Non-dry builds validate the full selection and all
required chroots before the first package build. Missing
chroot/foreign-execution errors include setup guidance. Native-only builds do
not need emulation. Selections outside the amd64 build matrix (for example
`bookworm` + `riscv64`, or any foreign architecture) fail before toolchain
setup.

Build outputs are written to `build/<suite>/`, with `_<arch>.deb`,
`_<arch>.changes`, and `_<arch>.buildinfo` names. The emulated-native foreign
machinery (matching compiler packages, emulated target execution inside sbuild
chroots, host-native source vendoring) remains in place and is documented in
the environment guide; it is simply not reachable while the build matrix is
amd64-only. No true cross-target Debian rules are introduced.

Do not run independent builders simultaneously in the same workdir/cache; shared
`.part` paths are not locked. See the environment guide for cache boundaries and
resource/cost caveats. The **build** matrix lives in `scripts/config.ts`
(amd64-only); `repository.toml` declares the wider **published**
suite×architecture matrix used by reprepro, and the web UI reads the
architecture union from `index.json`.

Hermetic development checks (no toolchain/chroot downloads or package builds):

```sh
deno fmt --check scripts/*.ts packages/*/build.ts examples/*/build.ts
deno lint scripts/*.ts packages/*/build.ts
deno check scripts/*.ts packages/*/build.ts
./scripts/check-config.ts
deno test --allow-env --allow-read --allow-write --allow-run scripts/*_test.ts
sh -n scripts/setup-sbuild
just --dry-run d2::build trixie
just --dry-run d2::build-all amd64
```
