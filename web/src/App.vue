<script setup lang="ts">
import { ref } from "vue";
import ErrorScreen from "./components/ErrorScreen.vue";
import HeroSection from "./components/HeroSection.vue";
import InstallGuide from "./components/InstallGuide.vue";
import LoadingScreen from "./components/LoadingScreen.vue";
import PackageCollection from "./components/PackageCollection.vue";
import PixelFooter from "./components/PixelFooter.vue";
import PixelNavbar from "./components/PixelNavbar.vue";
import SuiteStages from "./components/SuiteStages.vue";
import { useRepoData } from "./repo";

/* Theme state mirrors <html data-theme>; initial value applied in index.html. */
const THEMES = ["departure", "departure-dark"] as const;
type Theme = (typeof THEMES)[number];

const stored = localStorage.getItem("px-theme");
const theme = ref<Theme>(THEMES.includes(stored as Theme) ? (stored as Theme) : "departure");

function toggleTheme() {
  theme.value = theme.value === "departure" ? "departure-dark" : "departure";
  document.documentElement.dataset.theme = theme.value;
  localStorage.setItem("px-theme", theme.value);
}

const { repo, loading, error, load } = useRepoData();
load();
</script>

<template>
  <PixelNavbar @toggle-theme="toggleTheme" />

  <main class="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-8">
    <HeroSection :repo="repo" />

    <LoadingScreen v-if="loading" />
    <ErrorScreen v-else-if="error" :message="error" @retry="load" />
    <template v-else-if="repo">
      <InstallGuide :repo="repo" />
      <SuiteStages :repo="repo" />
      <PackageCollection :repo="repo" />
    </template>
  </main>

  <PixelFooter :built-at="repo?.generated_at" />
</template>
