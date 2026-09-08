set minimum-version := '1.58.0'

# ---- Repo-wide / setup ----

check-config:
    ./scripts/check-config.ts

check-required:
    ./scripts/check-required

fmt:
    deno fmt **/**.ts

setup-go arch="all":
    ./scripts/setup-go.ts {{quote(arch)}}

setup-rust arch="all":
    ./scripts/setup-rust.ts {{quote(arch)}}

setup-toolchains arch="all":
    just setup-go {{quote(arch)}}
    just setup-rust {{quote(arch)}}

setup-sbuild suite="trixie" arch="all":
    ./scripts/setup-sbuild {{quote(suite)}} {{quote(arch)}}

setup-sbuild-all arch="all":
    ./scripts/build-targets.ts --setup-all {{quote(arch)}}
    just setup-sbuild bookworm {{quote(arch)}}
    just setup-sbuild trixie {{quote(arch)}}
    just setup-sbuild forky {{quote(arch)}}

# ---- Package modules ----

mod lazygit  "packages/lazygit/justfile"
mod himalaya "packages/himalaya/justfile"
mod starship "packages/starship/justfile"
mod zellij   "packages/zellij/justfile"
mod mdbook   "packages/mdbook/justfile"
mod uv       "packages/uv/justfile"
mod just     "packages/just/justfile"
mod sccache  "packages/sccache/justfile"
mod d2       "packages/d2/justfile"

# ---- Aggregate ----

build-all arch="all":
    ./scripts/build-targets.ts --build-all {{quote(arch)}}
    @just lazygit::build-all {{quote(arch)}}
    @just himalaya::build-all {{quote(arch)}}
    @just starship::build-all {{quote(arch)}}
    @just zellij::build-all {{quote(arch)}}
    @just mdbook::build-all {{quote(arch)}}
    @just uv::build-all {{quote(arch)}}
    @just just::build-all {{quote(arch)}}
    @just sccache::build-all {{quote(arch)}}
    @just d2::build-all {{quote(arch)}}

# ---- Incremental build ----

# Incremental build: only build packages changed in commits or the working tree since the given time (default: 24h)
build-changed since="24 hours ago" arch="all":
    ./scripts/incremental-build.ts {{quote(since)}} {{quote(arch)}}

# List affected packages only, without building
build-changed-dry since="24 hours ago" arch="all":
    ./scripts/incremental-build.ts {{quote(since)}} {{quote(arch)}} --dry-run

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
