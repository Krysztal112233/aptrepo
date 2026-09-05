<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { BASE_URL, useCopyFeedback } from "../repo";
import type { RepoIndex } from "../types";

const props = defineProps<{ repo: RepoIndex }>();

const suite = ref(props.repo.suites[0] ?? "bookworm");
watch(
  () => props.repo.suites,
  (suites) => {
    if (suites.length && !suites.includes(suite.value)) suite.value = suites[0];
  },
);

const snippet = computed(() => {
  const comp = props.repo.components.join(" ") || "main";
  const arch = props.repo.architectures.join(",") || "amd64";
  const firstPkg = props.repo.packages[0]?.name ?? "<package>";
  return `# 1. trust the archive key
curl -fsSL ${BASE_URL}/krysztal-archive-keyring.pgp \\
  | sudo gpg --dearmor -o /usr/share/keyrings/krysztal-archive.gpg

# 2. register the repository (${suite.value})
echo "deb [arch=${arch} signed-by=/usr/share/keyrings/krysztal-archive.gpg] ${BASE_URL}/ ${suite.value} ${comp}" \\
  | sudo tee /etc/apt/sources.list.d/krysztal.list

# 3. update & install
sudo apt update
sudo apt install ${firstPkg}`;
});

const { copiedKey, copy } = useCopyFeedback();
</script>

<template>
  <section class="mb-16">
    <h2 class="font-ps text-[22px] mb-2">░ BOARDING</h2>
    <p class="text-[var(--px-muted)] mb-6">point apt at this baseurl and install away.</p>

    <!-- box-drawing terminal frame -->
    <div class="px-panel bg-base-100">
      <div
        class="flex items-center gap-2 bg-neutral text-neutral-content font-ps text-[11px] px-4 py-2"
      >
        <span aria-hidden="true">░</span>
        <span>APT · SOURCES</span>
        <span aria-hidden="true" class="ml-auto">─────────────</span>
      </div>
      <div class="px-6 py-6">
        <div class="flex flex-wrap items-center gap-3 mb-4">
          <span class="font-ps text-[11px] text-secondary">DESTINATION:</span>
          <select
            v-model="suite"
            class="select select-sm bg-base-300 text-[16.5px] border-2 border-[var(--px-ink)] rounded-none"
          >
            <option v-for="s in repo.suites" :key="s" :value="s">{{ s.toUpperCase() }}</option>
          </select>
          <button
            class="btn btn-accent btn-sm font-ps text-[11px] ml-auto"
            @click="copy('install', snippet)"
          >
            {{ copiedKey === "install" ? "COPIED ★" : "□ COPY ALL" }}
          </button>
        </div>
        <pre class="px-inset bg-base-300 text-base-content p-4 overflow-x-auto whitespace-pre">{{ snippet }}</pre>
      </div>
    </div>
  </section>
</template>
