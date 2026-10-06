import { DEMO } from './base';
import { api } from './api';

export type PushState = 'unsupported' | 'blocked' | 'off' | 'active' | 'working';

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - value.length % 4) % 4);
  const raw = atob((value + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function supported(): boolean {
  if (DEMO) return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function sendSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('Suscripción Push incompleta');
  await api('/driver/push/subscribe', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } });
}

export async function pushStateAndSync(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.getSubscription();
  if (!sub) return 'off';
  await sendSubscription(sub); // recupera la suscripción en el servidor tras una restauración o pérdida de datos.
  return 'active';
}

/** Debe llamarse directamente desde un botón: iOS y Android exigen un gesto del usuario. */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off';
  const config = await api<{ public_key: string }>('/driver/push/config');
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const sub = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(config.public_key)
  });
  await sendSubscription(sub);
  return 'active';
}
