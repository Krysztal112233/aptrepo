<script setup lang="ts">
import { debNum, debFilename, debUrl, suiteStyle, useCopyFeedback } from "../repo";
import type { RepoIndex } from "../types";

defineProps<{ repo: RepoIndex }>();

const { copiedKey, copy } = useCopyFeedback();
</script>

<template>
  <section class="mb-16">
    <div class="mb-6">
      <h2 class="font-ps text-[22px]">░ DEPARTURES</h2>
      <p class="text-[var(--px-muted)]">
        what this repository ships, and for which debian release.
      </p>
    </div>

    <!-- ========== card grid ========== -->
    <div class="grid gap-8 md:grid-cols-2">
      <article
        v-for="pkg in repo.packages"
        :key="pkg.name"
        class="card px-panel bg-base-100 rounded-none group"
      >
        <div class="card-body p-6 gap-3">
          <div class="flex items-center justify-between gap-2">
            <h3 class="card-title font-ps text-[22px] text-primary">
              <span class="opacity-0 group-hover:opacity-100 text-[var(--px-accent-ink)] transition-none">❯</span
              >{{ pkg.name }}
            </h3>
            <span class="font-ps text-[11px] text-[var(--px-muted)]">
              {{ repo.architectures.join(" ") }}
            </span>
          </div>
          <p class="text-[var(--px-muted)] min-h-6">{{ pkg.description || "no description" }}</p>
          <ul class="divide-y-2 divide-dashed divide-base-300">
            <li
              v-for="(suite, i) in repo.suites"
              :key="suite"
              class="flex items-center justify-between gap-3 py-1"
            >
              <span class="flex items-center gap-2">
                <span class="badge font-ps text-[11px] uppercase rounded-none" :class="suiteStyle(i).badge">
                  {{ suite }}
                </span>
                <span class="text-[var(--px-muted)] text-[11px]">{{ debNum(suite) }}</span>
              </span>
              <a
                v-if="pkg.versions?.[suite]"
                class="kbd ver-kbd bg-base-300 text-base-content border-2 border-[var(--px-ink)] rounded-none"
                :href="debUrl(pkg.name, pkg.versions[suite], repo)"
                :title="`download ${debFilename(pkg.name, pkg.versions[suite], repo)}`"
                download
              >
                {{ pkg.versions[suite] }} ↓
              </a>
              <span v-else class="text-[11px] text-[var(--px-muted)]">N/A</span>
            </li>
          </ul>
          <div class="card-actions justify-end pt-2">
            <a
              v-if="pkg.homepage"
              class="btn btn-secondary btn-sm font-ps text-[11px]"
              :href="pkg.homepage"
              target="_blank"
              rel="noopener noreferrer"
              >HOMEPAGE ↗</a
            >
            <button
              class="btn btn-primary btn-sm font-ps text-[11px]"
              @click="copy(`apt:${pkg.name}`, `sudo apt install ${pkg.name}`)"
            >
              {{ copiedKey === `apt:${pkg.name}` ? "COPIED ★" : "APT INSTALL" }}
            </button>
          </div>
        </div>
      </article>
      <p v-if="!repo.packages.length" class="font-ps text-[11px] text-[var(--px-muted)] py-10">
        ░ NO DEPARTURES SCHEDULED…
      </p>
    </div>
  </section>
</template>
