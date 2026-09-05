<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

const SEGS = 10;
const idx = ref(0);
let timer: ReturnType<typeof setInterval>;

onMounted(() => {
  timer = setInterval(() => (idx.value = (idx.value + 1) % (SEGS + 2)), 110);
});
onUnmounted(() => clearInterval(timer));

/* shade-character loading bar: ████████░░ */
const bar = computed(() => "█".repeat(idx.value) + "░".repeat(Math.max(0, SEGS - idx.value)));
</script>

<template>
  <section class="flex flex-col items-center gap-6 py-20">
    <p class="font-ps text-[11px]">░ LOADING INDEX.JSON</p>
    <p class="text-[22px] text-[var(--px-accent-ink)] tracking-widest" aria-hidden="true">{{ bar }}</p>
    <p class="text-[var(--px-muted)]">GET {baseurl}/index.json</p>
  </section>
</template>
