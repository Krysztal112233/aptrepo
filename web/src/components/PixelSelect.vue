<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/**
 * Pixel-styled listbox — the native <select> popup is OS-rendered and
 * cannot be styled, so this replaces it entirely.
 * ARIA pattern: button aria-haspopup=listbox + ul[role=listbox].
 */
const props = defineProps<{ options: string[]; modelValue: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const open = ref(false);
const active = ref(0); // highlighted option while open
const root = ref<HTMLElement | null>(null);

function toggle() {
  open.value = !open.value;
  if (open.value) active.value = Math.max(0, props.options.indexOf(props.modelValue));
}
function pick(i: number) {
  emit("update:modelValue", props.options[i]);
  open.value = false;
}
function onKey(e: KeyboardEvent) {
  if (!open.value) {
    if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      toggle();
    }
    return;
  }
  if (e.key === "Escape" || e.key === "Tab") open.value = false;
  else if (e.key === "ArrowDown") {
    e.preventDefault();
    active.value = (active.value + 1) % props.options.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    active.value = (active.value - 1 + props.options.length) % props.options.length;
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    pick(active.value);
  }
}
function onDocPointer(e: PointerEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener("pointerdown", onDocPointer));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocPointer));
</script>

<template>
  <div ref="root" class="relative inline-block font-ps text-[16.5px]" @keydown="onKey">
    <button
      type="button"
      class="px-panel-flat bg-base-300 text-base-content px-4 py-1 min-w-60 flex items-center justify-between gap-4 uppercase cursor-pointer"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggle"
    >
      <span>{{ modelValue }}</span>
      <span aria-hidden="true" class="inline-block" :class="open ? '-rotate-90' : 'rotate-90'">❯</span>
    </button>
    <ul
      v-if="open"
      role="listbox"
      class="absolute left-0 top-full mt-2 z-20 min-w-full w-max px-panel bg-base-100 py-1"
      :aria-activedescendant="`px-opt-${active}`"
    >
      <li
        v-for="(opt, i) in options"
        :key="opt"
        :id="`px-opt-${i}`"
        role="option"
        :aria-selected="opt === modelValue"
        class="px-3 py-1 uppercase cursor-pointer flex items-center gap-2"
        :class="i === active ? 'bg-base-content text-base-100' : ''"
        @click="pick(i)"
        @pointerenter="active = i"
      >
        <span aria-hidden="true" class="w-4">{{ opt === modelValue ? "❯" : "" }}</span
        >{{ opt }}
      </li>
    </ul>
  </div>
</template>
