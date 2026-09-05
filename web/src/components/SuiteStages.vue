<script setup lang="ts">
import { computed } from "vue";
import { debNum, suiteStyle } from "../repo";
import type { RepoIndex } from "../types";

const props = defineProps<{ repo: RepoIndex }>();

const stages = computed(() =>
  props.repo.suites.map((suite, i) => {
    const total = props.repo.packages.length;
    const avail = props.repo.packages.filter((p) => p.versions?.[suite]).length;
    const filled = Math.round((avail / (total || 1)) * 10);
    return {
      suite,
      style: suiteStyle(i),
      avail,
      total,
      /* shade-character capacity bar: ████████░░ */
      barFill: "█".repeat(filled),
      barRest: "░".repeat(10 - filled),
    };
  }),
);
</script>

<template>
  <section class="mb-16">
    <h2 class="font-ps text-[22px] mb-2">░ DESTINATIONS</h2>
    <p class="text-[var(--px-muted)] mb-6">
      every package below is built once per debian suite — pick your codename.
    </p>
    <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      <div v-for="s in stages" :key="s.suite" class="card px-panel bg-base-100 rounded-none">
        <div class="card-body gap-3 p-6">
          <div class="flex items-center justify-between gap-2">
            <h3 class="card-title font-ps text-[22px] uppercase" :class="s.style.text">
              {{ s.suite }}
            </h3>
            <span class="badge font-ps text-[11px] rounded-none" :class="s.style.badge">
              {{ debNum(s.suite) }}
            </span>
          </div>
          <p class="text-[var(--px-muted)]">{{ s.avail }}/{{ s.total }} packages departing</p>
          <p class="text-[22px] leading-none tracking-widest" aria-hidden="true">
            <span :class="s.style.text">{{ s.barFill }}</span><span class="text-base-content/30">{{ s.barRest }}</span>
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
