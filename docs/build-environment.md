# Build Environment Setup

The build environment is intended to run on a Debian host using either the
`amd64` or `arm64` architecture. It requires Deno 2, Just, `curl`, `sbuild`,
`mmdebstrap`, `uidmap`, and the standard Debian packaging tools.

From the repository root, validate the configuration first:

```sh
just check-config
```

Create the `sbuild` environment for one Debian release:

```sh
just setup-sbuild trixie
```

To create environments for every configured release instead:

```sh
just setup-sbuild-all
```

The Debian mirror can be overridden when creating an environment:

```sh
DEBIAN_MIRROR=https://deb.debian.org/debian just setup-sbuild trixie
```

Finally, prepare the pinned compiler toolchains used by the build environments:

```sh
just setup-toolchains
```

Generated `sbuild` environments are stored under
`${XDG_CACHE_HOME:-$HOME/.cache}/sbuild/`. Prepared toolchain packages are
written to `build/toolchains/`, while reusable toolchain downloads are cached
under `${XDG_CACHE_HOME:-$HOME/.cache}/aptrepo/toolchains/`.
