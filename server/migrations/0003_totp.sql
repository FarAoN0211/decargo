-- DECARGO · migración 0003: segundo factor TOTP (RFC 6238) para oficina, admin y solo_lectura. Solo cambios aditivos.
ALTER TABLE app_user
  ADD COLUMN totp_secret_enc  text,          -- secreto cifrado con una clave derivada de APP_KEY (AES-256-GCM)
  ADD COLUMN totp_enabled_at  timestamptz,   -- NULL = pendiente de configurar (o secreto aún no confirmado)
  ADD COLUMN totp_last_step   bigint;        -- último paso de 30 s aceptado: impide reutilizar un código (anti-repetición)

-- Momento en que la sesión superó el segundo factor. NULL en un rol que lo exige = alcance MFA_PENDING.
ALTER TABLE session ADD COLUMN mfa_at timestamptz;
