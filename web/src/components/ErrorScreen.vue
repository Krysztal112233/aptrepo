<script setup lang="ts">
defineProps<{ message: string }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <section class="py-16">
    <div class="px-panel bg-base-100 p-8 flex flex-col sm:flex-row gap-4 items-center">
      <span class="font-ps text-[22px] text-error">! DEPARTURE CANCELLED</span>
      <span class="text-[var(--px-muted)]">{{ message }}</span>
      <button class="btn btn-accent font-ps text-[11px] sm:ml-auto" @click="$emit('retry')">
        → RETRY
      </button>
    </div>
  </section>
</template>
