set minimum-version := '1.58.0'

# ---- Repo-wide / setup ----

check-config:
    ./scripts/check-config.ts

check-required:
    ./scripts/check-required

fmt:
    deno fmt **/**.ts

setup-go:
    ./scripts/setup-go.ts

setup-rust:
    ./scripts/setup-rust.ts

setup-toolchains:
    just setup-go
    just setup-rust

setup-sbuild suite="trixie":
    ./scripts/setup-sbuild "{{ suite }}"

setup-sbuild-all:
    just setup-sbuild bookworm
    just setup-sbuild trixie
    just setup-sbuild forky

# ---- Package modules ----

mod lazygit  "packages/lazygit/justfile"
mod himalaya "packages/himalaya/justfile"
mod starship "packages/starship/justfile"
mod zellij   "packages/zellij/justfile"
mod mdbook   "packages/mdbook/justfile"
mod uv       "packages/uv/justfile"
mod just     "packages/just/justfile"
mod sccache  "packages/sccache/justfile"

# ---- Aggregate ----

build-all:
    @just lazygit::build-all
    @just himalaya::build-all
    @just starship::build-all
    @just zellij::build-all
    @just mdbook::build-all
    @just uv::build-all
    @just just::build-all
    @just sccache::build-all

# ---- Incremental build ----

# Incremental build: only build packages changed in commits or the working tree since the given time (default: 24h)
build-changed since="24 hours ago":
    ./scripts/incremental-build.ts "{{ since }}"

# List affected packages only, without building
build-changed-dry since="24 hours ago":
    ./scripts/incremental-build.ts "{{ since }}" --dry-run

# ---- Web UI ----

# Install web UI dependencies
web-install:
    pnpm --prefix web install

# Build the pixel web UI into repo/ (index.html + assets/)
web:
    pnpm --prefix web run build

# Dev server; proxies /index.json etc. to VITE_REPO_ORIGIN (default http://127.0.0.1:8137)
web-dev:
    pnpm --prefix web run dev

repo:
    ./scripts/repo-build.ts
    ./scripts/repo-index.ts
