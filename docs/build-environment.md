# Build Environment Setup

Use a Debian `amd64` or `arm64` host with Deno 2, Just (at least 1.58), `curl`,
`sbuild`, `mmdebstrap`, `uidmap`, and standard Debian packaging tools
(`build-essential`, `devscripts`, `debhelper`, `dpkg-dev`, `xz-utils`, `zstd`).
Unprivileged user namespaces and subordinate UID/GID ranges must be configured
for the build user. No privileged package installation is performed by the setup
scripts.

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

On amd64, check `arch-test arm64` and `/proc/sys/fs/binfmt_misc/qemu-aarch64`:
binfmt must be enabled and the registration must be enabled with the **F** flag,
which keeps the interpreter available inside chroots. On arm64, the analogous
foreign target is amd64 (`qemu-x86_64`). Preflight checks registration plus
`arch-test`; it cannot guarantee all dynamic libraries or package-specific
behavior. A native-only selection does not require QEMU or `arch-test`.

## Select suites and architectures

The default architecture selection is **all**, meaning **amd64 then arm64,
serially**, regardless of host architecture. Existing suite positions are
unchanged; append `all`, `amd64`, or `arm64` to select architectures explicitly.

```sh
just setup-sbuild trixie          # both architectures for trixie
just setup-sbuild trixie arm64    # only the missing foreign chroot, for example
just setup-sbuild-all             # both architectures for all three suites
just setup-sbuild-all amd64       # native-only on an amd64 host
just setup-toolchains             # both Go and Rust, both architectures
just setup-go arm64               # arm64 package AND host-native vendoring Go
just setup-rust arm64             # arm64 package AND host-native vendoring Cargo
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
arm64 build uses an arm64 chroot and compiler package with
`sbuild --arch=arm64`. Source preparation/vendoring uses the host-native
Go/Cargo executable. Foreign compiler archives are packaged/extracted without
executing them on the host. The existing Debian rules can execute built target
programs for completions, manpages and tests through binfmt.

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
compatibility is claimed here. Default dual-architecture builds add substantial
work, disk usage and temporary-space demand. Check available RAM, cache disk and
`/tmp` space before starting; select one target/suite for bounded evaluation.
