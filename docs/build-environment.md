# Build Environment Setup

Use a Debian `amd64` or `arm64` host with Deno 2, Just (at least 1.58), `curl`,
`sbuild`, `mmdebstrap`, `uidmap`, and standard Debian packaging tools
(`build-essential`, `devscripts`, `debhelper`, `dpkg-dev`, `xz-utils`, `zstd`).
Unprivileged user namespaces and subordinate UID/GID ranges must be configured
for the build user. No privileged package installation is performed by the setup
scripts. riscv64 is a **build target** only; it is not a supported build host.

```sh
just check-required
just check-config
```

`check-required` checks the common commands; foreign execution is checked
separately by build/chroot setup preflight. On a current Debian forky/sid host,
foreign builds additionally require these host packages (administrator action):

```sh
sudo apt install qemu-user qemu-user-binfmt arch-test
```

Here `qemu-user` supplies static emulators and `qemu-user-binfmt` registers
them. Older **host** releases may instead package these as `qemu-user-static`;
use that release's packaging, not both current and legacy packages. The selected
build suite is not the host release. `binfmt-support`/`update-binfmts` is not
required when systemd manages the registrations. GNU `time` is optional for
measurements.

Foreign targets need matching binfmt registrations with the **F** flag, which
keeps the interpreter available inside chroots:

- amd64 host: `arch-test arm64` / `qemu-aarch64`, and for riscv64 builds
  `arch-test riscv64` / `qemu-riscv64`
- arm64 host: `arch-test amd64` / `qemu-x86_64`, plus the same riscv64 pair when
  building riscv64

Preflight checks registration plus `arch-test`; it cannot guarantee all dynamic
libraries or package-specific behavior. A native-only selection does not require
QEMU or `arch-test`.

## Select suites and architectures

Architecture support is **suite-specific** (`repository.toml` →
`suite_architectures`):

| Suite | Architectures |
| --- | --- |
| bookworm | amd64, arm64 |
| trixie | amd64, arm64, riscv64 |
| forky | amd64, arm64, riscv64 |

The default architecture selection is **all**, meaning every architecture in
that suite's matrix, serially (`amd64` then `arm64`, then `riscv64` when the
suite supports it). Explicit `all`, `amd64`, `arm64`, or `riscv64` still works.
Multi-suite commands (`setup-sbuild-all`, `build-all`, incremental builds) skip
suites that do not support the selected architecture, so
`just setup-sbuild-all riscv64` only touches trixie and forky. A single-suite
request for an unsupported pair (for example `just setup-sbuild bookworm
riscv64`) fails explicitly.

```sh
just setup-sbuild trixie          # amd64, arm64, and riscv64 for trixie
just setup-sbuild trixie arm64    # only the missing foreign chroot, for example
just setup-sbuild trixie riscv64  # riscv64-only for trixie
just setup-sbuild-all             # each suite's full matrix
just setup-sbuild-all amd64       # native-only on an amd64 host
just setup-sbuild-all riscv64     # trixie + forky only
just setup-toolchains             # Go and Rust for the architecture union
just setup-go arm64               # arm64 package AND host-native vendoring Go
just setup-rust riscv64           # riscv64 package AND host-native vendoring Cargo
```

The same defaults apply directly:

```sh
./scripts/setup-sbuild trixie arm64
./scripts/setup-go.ts arm64
./scripts/setup-rust.ts arm64
```

Chroot setup validates the entire selection and foreign execution **before**
creating anything; it does not require the chroots it is about to create. It
replaces the selected archives on success. To avoid recreating existing chroots,
select only the missing suite/architecture. The mirror remains configurable:

```sh
DEBIAN_MIRROR=https://deb.debian.org/debian just setup-sbuild trixie arm64
```

## Design and caches

Builds are **emulated native**, using sbuild-managed unshare chroots and QEMU
user-mode/binfmt for foreign execution, not true cross compilation or a VM. An
arm64 or riscv64 build uses a matching chroot and compiler package with
`sbuild --arch=<arch>`. Source preparation/vendoring uses the host-native
Go/Cargo executable. Foreign compiler archives are packaged/extracted without
executing them on the host. The existing Debian rules can execute built target
programs for completions, manpages and tests through binfmt.

Rust packages build with the upstream release profile, which enables fat LTO
(`uv`, `zellij`, `starship` and `sccache`) and gives the final link of the main
binaries a multi-GiB peak. Under emulation that peak can exhaust the host's
memory and the link is killed by the OOM killer, so the shared rules tuning
switches foreign builds (`DEB_HOST_ARCH` ≠ `DEB_BUILD_ARCH`) to thin LTO and a
bounded `CARGO_BUILD_JOBS`, while native builds keep fat LTO. Foreign artifacts
are therefore not byte-identical to native ones, and sizing a host still needs
headroom for the emulated compile phase, not just for the link.

- Chroots: `${XDG_CACHE_HOME:-$HOME/.cache}/sbuild/<suite>-<arch>.tar.zst`.
- Toolchain packages: `build/toolchains/*_<arch>.deb`, with config fingerprints.
- Toolchain downloads/extracted tools:
  `${XDG_CACHE_HOME:-$HOME/.cache}/aptrepo/toolchains/`; extracted tools are
  architecture- and fingerprint-qualified.
- Source downloads and vendored orig archives: `build/downloads/`. Orig
  identities use source checksum and toolchain fingerprint, allowing reuse
  across serial targets on the same host. Cross-host reproducibility is not
  established.
- Temporary source/chroot compiler caches are not retained as a warm compiler
  cache between package builds. Output artifacts go to `build/<suite>/` with
  architecture-qualified names.

**Independent simultaneous builders sharing the same workdir/cache are
unsupported.** Commands run architectures and packages serially, but there is no
cross-process locking: `downloadVerified` shares `${path}.part`, and toolchain
`.deb` temporary destinations may collide. Do not run overlapping setup/build
commands against shared caches. Distinct immutable Rust component downloads may
run in parallel within a single setup.

Emulation adds workload-dependent cost; no measured slowdown or all-package
compatibility is claimed here. Default multi-architecture builds add substantial
work, disk usage and temporary-space demand. Check available RAM, cache disk and
`/tmp` space before starting; select one target/suite for bounded evaluation.
