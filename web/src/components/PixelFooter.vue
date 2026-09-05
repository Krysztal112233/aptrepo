<script setup lang="ts">
import { fmtDate } from "../repo";

defineProps<{ builtAt?: string }>();
</script>

<template>
  <footer class="border-t-2 border-[var(--px-ink)] bg-base-100 py-8 mt-8 text-center">
    <p class="font-ps text-[11px] mb-4">
      ░ END OF DEPARTURES — THANK YOU FOR FLYING <span class="text-[var(--px-accent-ink)] blink">■</span>
    </p>
    <p class="text-[var(--px-muted)]">
      built with reprepro · rendered from
      <a class="px-link" href="index.json">index.json</a>
      <span v-if="builtAt"> · built {{ fmtDate(builtAt) }}</span>
    </p>
    <p class="text-[11px] text-[var(--px-muted)] mt-2">
      font:
      <a
        class="px-link"
        href="https://departuremono.com"
        target="_blank"
        rel="noopener noreferrer"
        >DEPARTURE MONO</a
      >
      BY HELENA ZHANG · SIL OFL
    </p>
  </footer>
</template>
