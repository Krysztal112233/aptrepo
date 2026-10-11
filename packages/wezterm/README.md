# WezTerm snapshot maintenance

WezTerm's latest stable release is currently the February 2024 tag. This
package instead builds a reviewed, immutable snapshot of upstream `main`.
It is not an upstream stable release, and neither builds nor update checks
silently advance the pin.

## Build inputs

- `package.toml` pins the complete upstream `source.commit` and source archive
  SHA256. `{commit}` expands in `source.archive` and `source.archive_root`.
- `[updates] branch = "main"` is only for candidate discovery. A differing
  branch head is not proof of a newer commit or a safe release.
- `pre-vendor` pins and verifies all four C-library submodule archives. The
  values must match the selected commit's gitlinks, not a floating branch.
- Keep the upstream `Cargo.lock` unchanged; Cargo vendoring and the chroot
  build use `--locked`, and the chroot build is offline.
- `debian/rules.in` generates `.tag` from the Debian upstream version so builds
  from GitHub's commit archive retain the correct WezTerm version identity.
- Run workspace unit/integration tests with `cargo test --release --locked
  --offline`, followed by the escape parser in isolation (its default is
  `no_std`). The upstream Makefile uses `cargo-nextest`, which is not part of
  this repository's Rust toolchain; tests are not disabled to bypass it.

Do not use the `nightly` Git tag as the source pin: upstream explicitly says
that the Git sources associated with that release are just its README. The
attached `wezterm-nightly-src.tar.gz` is a separate, replaceable artifact, so
its URL alone is not an immutable build input either.

## Advancing the snapshot

1. Run `just check-updates wezterm`. It compares the pinned SHA with the exact
   `refs/heads/main` head without downloading source or changing configuration.
2. Review candidate changes and upstream CI, especially known Wayland release
   blockers. Pick a full commit SHA; do not automatically follow HEAD.
3. Generate a version from the commit's **UTC committer time** and short SHA,
   using WezTerm's date-time-hash shape. In a checkout, for example:

   ```sh
   TZ=UTC git -c core.abbrev=8 show -s --format=%cd-%h \
     --date=format-local:%Y%m%d-%H%M%S "$commit"
   ```

   Check with `dpkg --compare-versions` that the complete new Debian version
   sorts after the published version. Reset `debian_revision` to `1` for a new
   snapshot; increment it for packaging-only changes to the same snapshot.
4. Update `source.commit`, the source archive SHA256, and the submodule SHAs and
   hashes in `pre-vendor`. Download archives using the fixed SHAs, not `main`.
   If an upstream archive's bytes change, fail checksum verification rather
   than silently accepting the replacement.
5. Add an entry to `debian/changelog`; run the repository's hermetic checks
   listed in [Building Packages](../../docs/building-packages.md).
6. Build the local `forky/amd64` package first, then exercise:
   - DECSLRM scrolling with a left margin greater than the terminal height;
     only the requested horizontal region may move or clear.
   - Neovim vertical splits and terminal buffers; scrolling one split must
     not blank its neighbor.
   - Normal glyph rendering with OpenGL, resizing, and the intended desktop's
     Wayland/X11 backend. A software/Xvfb check alone cannot certify Wayland.
   - Startup without configuration and with the regular configuration.
7. Only after review and smoke tests, build the other supported suites
   serially. Keep the previous package for explicit rollback. Installation
   and repository publication are separate operator decisions.

## Isolated scrolling regression

After building, extract the package instead of installing it, then run the
read-only CLI/file-acknowledgement probe:

```sh
scratch=$(mktemp -d /var/tmp/wezterm-smoke.XXXXXX)
dpkg-deb -x build/forky/wezterm_20261010-073911-e2a98e1b-1~deb14u1_amd64.deb "$scratch/package"
uv run --no-project --python /usr/bin/python3 packages/wezterm/test-scroll-margins.py \
  "$scratch/package/usr/bin/wezterm" --front-end OpenGL \
  --artifacts "$scratch/opengl"
```

Requires `Xvfb` and ImageMagick's `import`; no Python packages are needed. Repeat
with `--front-end Software` and a new artifact directory. The script allocates
its own X display and private runtime directory, removes inherited WezTerm
connection hints, checks the socket/pane/size/cwd before reading, and never
uses `send-text`. It checks both scroll directions and preserves rows outside
the scroll region. Inspect `glyphs.png` as well as the text assertions.

A 2024 package without the DECSLRM backport must fail this probe; otherwise it
is not exercising the reported regression. Xvfb/OpenGL uses Mesa software rendering, not the
physical GPU or the user's desktop session. Perform the separate Neovim and
Wayland/desktop checks before publishing.

## Current snapshot

`20261010-073911-e2a98e1b` already contains upstream PR #5871, which bounds the
DECSLRM left margin using the column count rather than the row count. It also
uses glium 0.35.0 and time 0.3.55; the old 2024 dependency overrides are removed.

Sources: [maintainer notes](https://github.com/wezterm/wezterm/blob/main/README-DISTRO-MAINTAINER.md),
[release checklist](https://github.com/wezterm/wezterm/issues/6341),
[nightly caveat](https://github.com/wezterm/wezterm/releases/tag/nightly),
[scrolling fix](https://github.com/wezterm/wezterm/pull/5871).
