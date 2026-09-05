<script setup lang="ts">
defineEmits<{ toggleTheme: [] }>();
</script>

<template>
  <header class="navbar sticky top-0 z-40 bg-base-100 border-b-2 border-[var(--px-ink)] px-4 gap-2">
    <div class="navbar-start gap-3">
      <svg width="22" height="22" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">
        <rect width="16" height="16" class="fill-neutral" />
        <rect x="3" y="3" width="10" height="10" class="fill-accent" />
      </svg>
      <span class="font-ps text-[16.5px]">KRYSZTAL<span class="text-[var(--px-accent-ink)]">.APT</span></span>
    </div>
    <div class="navbar-end gap-2">
      <a class="btn btn-ghost btn-sm font-ps text-[11px]" href="index.json" target="_blank" rel="noopener">
        index.json
      </a>
      <button
        class="btn btn-secondary btn-sm font-ps text-[11px]"
        aria-label="Toggle theme"
        @click="$emit('toggleTheme')"
      >
        PALETTE ▚
      </button>
    </div>
  </header>
</template>
