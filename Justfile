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

build-lazygit suite="trixie": setup-go
    ./packages/lazygit/build.ts "{{ suite }}"

build-lazygit-all:
    just build-lazygit bookworm
    just build-lazygit trixie
    just build-lazygit forky

build-himalaya suite="trixie": setup-rust
    ./packages/himalaya/build.ts "{{ suite }}"

build-himalaya-all:
    just build-himalaya bookworm
    just build-himalaya trixie
    just build-himalaya forky

build-starship suite="trixie": setup-rust
    ./packages/starship/build.ts "{{ suite }}"

build-starship-all:
    just build-starship bookworm
    just build-starship trixie
    just build-starship forky

build-zellij suite="trixie": setup-rust
    ./packages/zellij/build.ts "{{ suite }}"

build-zellij-all:
    just build-zellij bookworm
    just build-zellij trixie
    just build-zellij forky

build-mdbook suite="trixie": setup-rust
    ./packages/mdbook/build.ts "{{ suite }}"

build-mdbook-all:
    just build-mdbook bookworm
    just build-mdbook trixie
    just build-mdbook forky

build-all:
    @just build-lazygit-all
    @just build-himalaya-all
    @just build-starship-all
    @just build-zellij-all
    @just build-mdbook-all

# 增量构建：只构建过去 since 时间内（默认 24h）commit/工作区中发生变化的包
build-changed since="24 hours ago":
    ./scripts/incremental-build.ts "{{ since }}"

# 只列出受影响的包，不执行构建
build-changed-dry since="24 hours ago":
    ./scripts/incremental-build.ts "{{ since }}" --dry-run

repo:
    ./scripts/repo-build.ts
    ./scripts/repo-index.ts
