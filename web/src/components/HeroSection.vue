<script setup lang="ts">
import { computed } from "vue";
import { BASE_URL, fmtDate } from "../repo";
import type { RepoIndex } from "../types";

const props = defineProps<{ repo: RepoIndex | null }>();

const pad = (n?: number) => (n === undefined ? "──" : String(n).padStart(2, "0"));

const stats = computed(() => ({
  pkgs: pad(props.repo?.packages.length),
  suites: pad(props.repo?.suites.length),
  arch: pad(props.repo?.architectures.length),
  built: props.repo ? fmtDate(props.repo.generated_at) : "──",
}));
</script>

<template>
  <section class="py-12 flex w-full flex-col items-start gap-8">
    <div class="w-full px-panel bg-base-100 p-6 sm:p-10">
      <p class="font-ps text-[11px] text-secondary mb-4">░ ░ APT REPOSITORY ONLINE ░ ░</p>
      <h1 class="font-ps text-[33px] sm:text-[44px] lg:text-[55px] uppercase">
        {{ repo?.label || "NOW LOADING" }}<span class="blink text-[var(--px-accent-ink)]">_</span>
      </h1>
      <p class="mt-6 text-[var(--px-muted)]">
        <template v-if="repo">origin: {{ repo.origin }} · baseurl: {{ BASE_URL }}/</template>
        <template v-else>reading index.json from baseurl…</template>
      </p>
    </div>

    <!-- stats strip -->
    <div class="grid w-full grid-cols-2 lg:grid-cols-4 gap-6">
      <div class="px-panel bg-base-100 p-4 text-center">
        <div class="font-ps text-[11px] text-[var(--px-muted)]">PACKAGES</div>
        <div class="font-ps text-[33px] text-primary my-2">{{ stats.pkgs }}</div>
        <div class="text-[11px] text-[var(--px-muted)]">published in pool/</div>
      </div>
      <div class="px-panel bg-base-100 p-4 text-center">
        <div class="font-ps text-[11px] text-[var(--px-muted)]">SUITES</div>
        <div class="font-ps text-[33px] text-secondary my-2">{{ stats.suites }}</div>
        <div class="text-[11px] text-[var(--px-muted)]">debian releases</div>
      </div>
      <div class="px-panel bg-base-100 p-4 text-center">
        <div class="font-ps text-[11px] text-[var(--px-muted)]">ARCH</div>
        <div class="font-ps text-[33px] text-[var(--px-accent-ink)] my-2">{{ stats.arch }}</div>
        <div class="text-[11px] text-[var(--px-muted)]">cpu architectures</div>
      </div>
      <div class="px-panel bg-base-100 p-4 text-center">
        <div class="font-ps text-[11px] text-[var(--px-muted)]">LAST BUILD</div>
        <div class="font-ps text-[11px] text-success my-2 leading-relaxed">{{ stats.built }}</div>
        <div class="text-[11px] text-[var(--px-muted)]">index generated at</div>
      </div>
    </div>
  </section>
</template>
