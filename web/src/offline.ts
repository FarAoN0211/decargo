/**
 * Copia SIN CONEXIÓN del conductor: la lista de sus transportes y el PDF y el QR del DeCA vigente de cada uno, para poder
 * enseñarlos sin cobertura. Se guarda en este teléfono (IndexedDB) con límites estrictos:
 *  - solo los transportes que el servidor le muestra ahora (al sincronizar se borra lo finalizado, anulado o reasignado);
 *  - caduca a los OFFLINE_DAYS días de la última sincronización aunque no vuelva la cobertura;
 *  - se borra entera al salir, al entrar otro usuario o si el servidor rechaza la sesión (dispositivo revocado…).
 */
import { DEMO } from './base';
const DB = 'decargo-offline', FILES = 'files', META = 'meta';
export const OFFLINE_DAYS = 7;
const MAX_TRANSPORTS = 5;
const TTL = OFFLINE_DAYS * 86_400_000;

export interface OfflineUser { id: string; username: string; full_name: string; role: 'conductor' }
interface Meta { user: OfflineUser; savedAt: number; transports: any[] }
interface FileRow { key: string; decaId: string; version: number; kind: 'pdf' | 'qr'; blob: Blob; savedAt: number }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(FILES, { keyPath: 'key' }); r.result.createObjectStore(META); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = f(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}
const fileKey = (decaId: string, version: number, kind: 'pdf' | 'qr'): string => `${decaId}:${version}:${kind}`;
const safe = async <T>(p: Promise<T>): Promise<T | undefined> => { try { return await p; } catch { return undefined; } };

/** Borra todo (salir, otro usuario, sesión rechazada). */
export async function clearOffline(): Promise<void> {
  if (DEMO) return;
  await safe(tx(FILES, 'readwrite', (s) => { s.clear(); }));
  await safe(tx(META, 'readwrite', (s) => { s.delete('driver'); }));
}

async function meta(): Promise<Meta | null> {
  if (DEMO) return null;
  const m = await safe(tx<Meta>(META, 'readonly', (s) => s.get('driver')));
  if (!m) return null;
  if (Date.now() - m.savedAt > TTL) { await clearOffline(); return null; }   // caducada: no se enseña ni se conserva
  return m;
}

/** Usuario de la última sincronización (para abrir la app sin cobertura). */
export async function offlineUser(): Promise<OfflineUser | null> { return (await meta())?.user ?? null; }

/** Lista guardada y hora de la sincronización. */
export async function offlineTransports(userId: string): Promise<{ transports: any[]; savedAt: number } | null> {
  const m = await meta();
  return m && m.user.id === userId ? { transports: m.transports, savedAt: m.savedAt } : null;
}

/** PDF o QR guardado del DeCA de un transporte (el de su versión vigente en la última sincronización). */
export async function offlineFile(transportId: string, kind: 'pdf' | 'qr'): Promise<{ blob: Blob; savedAt: number } | null> {
  const m = await meta();
  const t = m?.transports.find((x) => x.id === transportId);
  if (!t?.deca) return null;
  const row = await safe(tx<FileRow>(FILES, 'readonly', (s) => s.get(fileKey(t.deca.id, t.deca.version, kind))));
  return row ? { blob: row.blob, savedAt: row.savedAt } : null;
}

/**
 * Tras cargar la lista con cobertura: guarda la lista, descarga lo que falte (solo versiones nuevas) y borra lo que ya no corresponde.
 * `fetchBlob` es la descarga con sesión de la API (se pasa como parámetro para no depender de api.ts).
 */
export async function syncOffline(user: OfflineUser, transports: any[], fetchBlob: (path: string) => Promise<Blob>): Promise<void> {
  if (DEMO || typeof indexedDB === 'undefined') return;   // la demo no guarda nada en el teléfono
  const prev = await meta();
  if (prev && prev.user.id !== user.id) await clearOffline();          // otro conductor en este teléfono: nada del anterior
  const list = transports.slice(0, MAX_TRANSPORTS);
  const now = Date.now();
  const wanted = new Set<string>();
  for (const t of list) {
    if (!t.deca) continue;
    for (const kind of ['pdf', 'qr'] as const) {
      const key = fileKey(t.deca.id, t.deca.version, kind);
      wanted.add(key);
      const have = await safe(tx<FileRow>(FILES, 'readonly', (s) => s.get(key)));
      if (have) { await safe(tx(FILES, 'readwrite', (s) => { s.put({ ...have, savedAt: now }); })); continue; }
      try {
        const blob = await fetchBlob(`/driver/decas/${t.deca.id}/${kind === 'pdf' ? 'current.pdf' : 'qr.svg'}`);
        await safe(tx(FILES, 'readwrite', (s) => { s.put({ key, decaId: t.deca.id, version: t.deca.version, kind, blob, savedAt: now } satisfies FileRow); }));
      } catch { /* se reintentará en la próxima sincronización */ }
    }
  }
  // Lo que ya no está en la lista (finalizado, anulado, reasignado) o versiones antiguas: fuera.
  const keys = (await safe(tx<IDBValidKey[]>(FILES, 'readonly', (s) => s.getAllKeys()))) ?? [];
  for (const k of keys) if (!wanted.has(String(k))) await safe(tx(FILES, 'readwrite', (s) => { s.delete(k); }));
  await safe(tx(META, 'readwrite', (s) => { s.put({ user, savedAt: now, transports: list } satisfies Meta, 'driver'); }));
}

/** Al abrir la app: si la copia caducó, se borra (aunque no haya cobertura). */
export async function pruneOffline(): Promise<void> { await meta(); }

/** ¿El error es por falta de red? (sin cobertura, servidor inalcanzable) */
export const isNetworkError = (e: unknown): boolean => e instanceof TypeError || (e instanceof Error && e.message === 'network');
