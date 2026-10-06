import { reactive } from 'vue';

/** Aviso dentro de la aplicación (llega del service worker cuando se recibe un push con la aplicación abierta). */
export const notice = reactive({ kind: '' as '' | 'TEST' | 'TRANSPORT', id: '' });
