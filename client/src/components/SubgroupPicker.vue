<template>
  <div class="sg-picker">
    <button
      v-for="sg in subgroups"
      :key="sg.id"
      class="sg-tag"
      :class="{ active: activeSg === sg.id }"
      @click="$emit('select', sg)"
    >{{ sg.name }}</button>
  </div>
</template>

<script setup>
defineProps({
  subgroups: { type: Array, default: () => [] },
  activeSg: { type: [String, Number], default: null },
})
defineEmits(['select'])
</script>

<style scoped>
.sg-picker {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: 8px; margin-bottom: 20px;
}
.sg-tag {
  padding: 6px 8px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg-input);
  color: var(--text-secondary); font-size: 0.8rem; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  text-align: center; user-select: none; font-weight: 500;
  transition: all 0.15s ease;
}
.sg-tag:hover {
  border-color: var(--accent); color: var(--accent);
  background: var(--bg-hover);
  transform: translateY(-1px);
}
.sg-tag:active { transform: scale(0.96); }
.sg-tag.active {
  background: var(--accent); color: #fff; border-color: var(--accent);
  font-weight: 600; transform: none;
}
</style>