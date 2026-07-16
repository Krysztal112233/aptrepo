# Package Examples

These directories are templates for adding packages to this repository. Copy the
relevant example into `packages/<package-name>/`, then replace the example name,
source URL, version, checksum, package descriptions, dependencies, and build or
installation commands.

The Go example expects the upstream source archive to contain vendored module
dependencies. The Rust example expects a committed `Cargo.lock`; its
dependencies are vendored automatically before the source package is built.

Neither example is included in `just check-config` or `just build-all` while it
remains under `examples/`.
