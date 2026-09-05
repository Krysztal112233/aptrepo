import { computed, ref } from "vue";
import type { RepoIndex } from "./types";

/** {baseurl}/index.json — resolved relative to wherever the page is served. */
export const DATA_URL = new URL("index.json", location.href);

/** {baseurl} — the repository root the page is hosted from. */
export const BASE_URL = location.protocol.startsWith("http")
  ? new URL(".", location.href).href.replace(/\/$/, "")
  : "https://your-repo-host.example";

const DEBIAN_NUM: Record<string, string> = {
  bookworm: "12",
  trixie: "13",
  forky: "14",
};

export const debNum = (suite: string): string =>
  DEBIAN_NUM[suite] ? `DEBIAN ${DEBIAN_NUM[suite]}` : "DEBIAN ?";

/**
 * Full literal class names so Tailwind's static scan picks them up.
 * NEVER build these by string interpolation — they would vanish from the build.
 */
export interface SuiteStyle {
  text: string;
  bg: string;
  badge: string;
}
export const SUITE_STYLES: SuiteStyle[] = [
  { text: "text-primary", bg: "bg-primary", badge: "badge-primary" },
  { text: "text-secondary", bg: "bg-secondary", badge: "badge-secondary" },
  { text: "text-[var(--px-accent-ink)]", bg: "bg-accent", badge: "badge-accent" },
  { text: "text-info", bg: "bg-info", badge: "badge-info" },
  { text: "text-success", bg: "bg-success", badge: "badge-success" },
  { text: "text-warning", bg: "bg-warning", badge: "badge-warning" },
];
export const suiteStyle = (i: number): SuiteStyle => SUITE_STYLES[i % SUITE_STYLES.length];

export function debFilename(name: string, version: string, repo: RepoIndex): string {
  const arch = repo.architectures.includes("amd64") ? "amd64" : (repo.architectures[0] ?? "amd64");
  return `${name}_${version.replace(/^\d+:/, "")}_${arch}.deb`;
}

/**
 * reprepro pool layout:
 * pool/<component>/<initial>/<name>/<name>_<version>_<arch>.deb
 */
export function debUrl(name: string, version: string, repo: RepoIndex): string {
  const comp = repo.components[0] ?? "main";
  return `${BASE_URL}/pool/${comp}/${name[0]}/${name}/${debFilename(name, version, repo)}`;
}

export function fmtDate(iso?: string): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for non-secure contexts (http on LAN, older browsers)
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** Copy-to-clipboard with a transient "COPIED ✔" UI feedback keyed per element. */
export function useCopyFeedback(ms = 1200) {
  const copiedKey = ref<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function copy(key: string, text: string) {
    await copyText(text);
    copiedKey.value = key;
    clearTimeout(timer);
    timer = setTimeout(() => (copiedKey.value = null), ms);
  }
  return { copiedKey, copy };
}

/** Fetch + normalize {baseurl}/index.json. */
export function useRepoData() {
  const data = ref<RepoIndex | null>(null);
  const loading = ref(true);
  const error = ref<string | null>(null);

  async function load() {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch(DATA_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      data.value = (await res.json()) as RepoIndex;
    } catch (err) {
      data.value = null;
      error.value = `failed to fetch ${DATA_URL.href} — ${
        err instanceof Error ? err.message : String(err)
      }`;
    } finally {
      loading.value = false;
    }
  }

  const repo = computed<RepoIndex | null>(() => {
    const d = data.value;
    if (!d) return null;
    return {
      ...d,
      suites: d.suites ?? [],
      components: d.components ?? [],
      architectures: d.architectures ?? [],
      packages: [...(d.packages ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  return { repo, loading, error, load };
}
