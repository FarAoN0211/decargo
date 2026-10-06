/**
 * Puente con la app Android de DECARGO (si la web se está viendo dentro de ella). La app expone `window.DecargoAndroid`
 * y avisa con el evento `decargo-native` cuando cambia algo (permisos concedidos, token de avisos recibido, vuelta a la app).
 */
export interface NativeState {
  version: string;
  notifications: 'granted' | 'denied' | 'default';
  fullscreen: boolean;      // puede encender la pantalla y mostrar el aviso a pantalla completa
  overlay: boolean;         // puede mostrar el aviso aunque se esté usando otra app
  battery: boolean;         // sin restricciones de batería
  xiaomi?: boolean;         // Xiaomi / Redmi / POCO: permisos propios de MIUI/HyperOS
  lockscreen?: boolean | null;   // «Mostrar en la pantalla de bloqueo» (null: no se puede saber)
  bgstart?: boolean | null;      // «Abrir nuevas ventanas mientras se ejecuta en segundo plano»
  firebase: 'ok' | 'loading' | 'no_config' | 'error';
  token: string | null;
}
interface Bridge {
  state(): string; requestNotifications(): void; openFullScreenSettings(): void; openOverlaySettings(): void;
  requestBattery(): void; openAppSettings(): void; refresh(): void;
  openXiaomiPermissions?(): void; openXiaomiAutostart?(): void;
  scanActivationQr?(): void;        // app 1.4.0+: escáner de QR de activación (abre el enlace leído)
}
const bridge = (): Bridge | null => ((window as unknown as { DecargoAndroid?: Bridge }).DecargoAndroid ?? null);
export const isNativeApp = (): boolean => bridge() !== null;
export function nativeState(): NativeState | null {
  const b = bridge();
  if (!b) return null;
  try { return JSON.parse(b.state()) as NativeState; } catch { return null; }
}
export const native = {
  requestNotifications: (): void => bridge()?.requestNotifications(),
  openFullScreenSettings: (): void => bridge()?.openFullScreenSettings(),
  openOverlaySettings: (): void => bridge()?.openOverlaySettings(),
  requestBattery: (): void => bridge()?.requestBattery(),
  openAppSettings: (): void => bridge()?.openAppSettings(),
  refresh: (): void => bridge()?.refresh(),
  openXiaomiPermissions: (): void => bridge()?.openXiaomiPermissions?.(),
  openXiaomiAutostart: (): void => bridge()?.openXiaomiAutostart?.(),
  scanActivationQr: (): void => bridge()?.scanActivationQr?.()
};
export const canScanQr = (): boolean => typeof bridge()?.scanActivationQr === 'function';
