import { optional } from '../common/config';

const num = (name: string, def: number): number => Number(optional(name, String(def)));

/**
 * Duraciones. Valores aprobados por el propietario: sesión provisional 72 h, máximo 3 dispositivos pendientes.
 * El resto son valores iniciales PROVISIONALES (configurables por entorno) a confirmar.
 */
export const POLICY = {
  accessTtlSeconds: num('ACCESS_TTL_SECONDS', 600),                  // access token: 10 min
  pendingSessionHours: num('PENDING_SESSION_HOURS', 72),             // dispositivo pendiente: máx. 72 h (aprobado)
  driverRefreshDays: num('DRIVER_REFRESH_DAYS', 30),                 // conductor con dispositivo autorizado
  driverSessionMaxDays: num('DRIVER_SESSION_MAX_DAYS', 90),
  // Un conductor que pierde la red justo al renovar reintenta con el token anterior: dentro de esta ventana NO se trata como robo (oficina no tiene gracia).
  refreshReuseGraceSeconds: num('REFRESH_REUSE_GRACE_SECONDS', 60),
  officeRefreshHours: num('OFFICE_REFRESH_HOURS', 8),                // oficina / admin / solo lectura
  officeSessionMaxHours: num('OFFICE_SESSION_MAX_HOURS', 24),
  activationTtlHours: num('ACTIVATION_TTL_HOURS', 72),               // credencial temporal de activación
  activationMaxAttempts: num('ACTIVATION_MAX_ATTEMPTS', 5),
  maxPendingDevices: num('MAX_PENDING_DEVICES', 3)                   // aprobado
};

export type Role = 'admin' | 'oficina' | 'conductor' | 'solo_lectura';
export const ROLES: Role[] = ['admin', 'oficina', 'conductor', 'solo_lectura'];
export type DeviceStatus = 'PENDIENTE_DE_CONFIRMACION' | 'AUTORIZADO' | 'REVOCADO';

/** Vigencia absoluta de una sesión y TTL de su refresh según rol y estado del dispositivo. */
export function sessionPolicy(role: Role, status: DeviceStatus): { absoluteMs: number; refreshMs: number } {
  const H = 3600_000;
  if (role !== 'conductor') return { absoluteMs: POLICY.officeSessionMaxHours * H, refreshMs: POLICY.officeRefreshHours * H };
  if (status === 'AUTORIZADO') return { absoluteMs: POLICY.driverSessionMaxDays * 24 * H, refreshMs: POLICY.driverRefreshDays * 24 * H };
  return { absoluteMs: POLICY.pendingSessionHours * H, refreshMs: POLICY.pendingSessionHours * H };
}
