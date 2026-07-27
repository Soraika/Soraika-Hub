<template>
  <div class="app-layout">
    <SideNav />
    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<script setup>
import SideNav from './components/SideNav.vue'
</script>

<style scoped>
.app-layout { display: flex; min-height: 100vh; }
.main-content { flex: 1; overflow-y: auto; }
</style>