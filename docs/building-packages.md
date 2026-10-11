# Building Packages

After [setting up the build environment](build-environment.md), build all
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
foreign architecture names still parse but are rejected by the amd64-only build
matrix. Just also sets up the appropriate toolchain automatically; direct
scripts expect it already prepared:

```sh
./scripts/setup-go.ts amd64
./packages/d2/build.ts trixie amd64
```

Go and Rust packages build with a downloaded compiler that is injected into the
sbuild chroot as an extra package. The `system` toolchain (currently neovim)
instead takes its compiler and build tools from the target chroot's own Debian
mirror via ordinary `Build-Depends`, so there is no setup step. Packages with
build-time downloads (neovim's bundled `cmake.deps`) have them pre-fetched and
vendored into the orig tarball at package time, keeping the chroot build
offline.

Rust packages that need source-tree fixes before vendoring can ship an
executable `packages/<name>/pre-vendor`: it runs on the host after extraction
and before `cargo vendor`, with the toolchain's cargo as `$1` and the source
tree as the working directory. The script's checksum is part of the vendored
tarball identity, so edits invalidate the cache. WezTerm uses this to populate
checksum-verified C-library submodules omitted from GitHub's source archive,
without modifying the snapshot's upstream Cargo.lock.

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

To check for newer stable tags or candidate commit snapshots:

```sh
just check-updates        # every package
just check-updates d2     # one package
```

For tag-based packages, the recipe lists each `source.git` remote's tags with
`git ls-remote` (version-sorted, no downloads) and reports packages whose pinned
`source.tag` is not the newest stable match or no longer exists upstream.

Snapshot packages specify `source.commit` (a full 40-character Git SHA) instead
of `source.tag`, plus `[updates] branch = "main"` for discovery. `{commit}` may
be used in their archive URL and root templates; builds still use only the
fixed commit and archive checksum. The update checker queries the exact tracked
branch and reports `branch head differs`, not a new stable release. This is a
candidate for manual review, including possible branch rewinds. Neither mode
changes configuration. Missing tags/branches and lookup failures exit non-zero;
updates and snapshot candidates are informational. See
[WezTerm snapshot maintenance](../packages/wezterm/README.md) for its update and
regression-test checklist.

Build outputs are written to `build/<suite>/`, with `_<arch>.deb`,
`_<arch>.changes`, and `_<arch>.buildinfo` names. The emulated-native foreign
machinery (matching compiler packages, emulated target execution inside sbuild
chroots, host-native source vendoring) remains in place and is documented in the
environment guide; it is simply not reachable while the build matrix is
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
