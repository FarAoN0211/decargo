<script setup lang="ts">
import { computed } from 'vue';
import { STATUS } from '../format';
const props = defineProps<{ status: string }>();
const cls = computed(() => ({ PENDIENTE: 'b-pend', EN_CURSO: 'b-curso', FINALIZADO: 'b-fin', CANCELADO: 'b-off' }[props.status] ?? 'b-off'));
</script>
<template><span :class="['badge', cls]">{{ STATUS[status] ?? status }}</span></template>
