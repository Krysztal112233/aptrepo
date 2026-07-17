check-config:
    ./scripts/check-config.ts

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

build-all:
    @just build-lazygit-all
    @just build-himalaya-all

repo:
    ./scripts/repo-build.ts
