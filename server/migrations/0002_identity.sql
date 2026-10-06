-- DECARGO · migración 0002: identidad, sesiones y dispositivos (segundo bloque).
-- Usuarios y roles, activación con credencial temporal, dispositivos (D-05), sesiones con refresh rotatorio,
-- protección contra fuerza bruta y asignación de conductor a transporte. Solo cambios aditivos.

CREATE TABLE app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES company(id),
  username       text NOT NULL,                       -- siempre en minúsculas (la aplicación lo normaliza)
  full_name      text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin','oficina','conductor','solo_lectura')),
  active         boolean NOT NULL DEFAULT true,
  password_hash  text,                                -- Argon2id; NULL hasta que se activa la cuenta
  activated_at   timestamptz,
  deactivated_at timestamptz,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_username_uq ON app_user (lower(username));

-- Credencial temporal de activación: un solo uso, con caducidad, guardada solo como hash Argon2id.
CREATE TABLE activation_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id),
  secret_hash   text NOT NULL,
  expires_at    timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  used_at       timestamptz,
  superseded_at timestamptz,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activation_token_user ON activation_token (user_id);

-- Dispositivo: identidad aleatoria generada por DECARGO (sin IMEI ni datos del aparato).
-- La confianza la da la posesión del secreto del dispositivo, no el conocimiento de su id.
CREATE TABLE device (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- device_id
  company_id    uuid NOT NULL REFERENCES company(id),
  user_id       uuid NOT NULL REFERENCES app_user(id),
  secret_hash   char(64) NOT NULL,                            -- SHA-256 de un secreto de 256 bits
  label         text,
  status        text NOT NULL CHECK (status IN ('PENDIENTE_DE_CONFIRMACION','AUTORIZADO','REVOCADO')),
  registered_at timestamptz NOT NULL DEFAULT now(),           -- límite de los transportes visibles en modo pendiente
  last_seen     timestamptz,
  decided_by    uuid REFERENCES app_user(id),
  decided_at    timestamptz
);
CREATE INDEX device_user_status ON device (user_id, status);

-- Una sesión es la «familia» de refresh tokens de un dispositivo.
CREATE TABLE session (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES app_user(id),
  device_id       uuid NOT NULL REFERENCES device(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text,
  last_refresh_at timestamptz
);
CREATE INDEX session_by_user ON session (user_id);
CREATE INDEX session_by_device ON session (device_id);

CREATE TABLE refresh_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES session(id),
  token_hash  char(64) NOT NULL UNIQUE,                       -- SHA-256; el token solo existe en el cliente
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz                                     -- si se presenta un token ya usado: reutilización
);
CREATE INDEX refresh_token_session ON refresh_token (session_id);

-- Fuerza bruta: contadores por (usuario, IP), por usuario y por IP. También para usuarios inexistentes.
CREATE TABLE login_throttle (
  key          text PRIMARY KEY,
  fails        integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Qué conductor tiene asignado cada transporte (con histórico; nunca se borra).
CREATE TABLE transport_driver_assignment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transport_id   uuid NOT NULL REFERENCES transport(id),
  driver_user_id uuid NOT NULL REFERENCES app_user(id),
  valid_from     timestamptz NOT NULL DEFAULT now(),
  valid_to       timestamptz,
  reason         text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX transport_one_current_driver ON transport_driver_assignment (transport_id) WHERE valid_to IS NULL;
CREATE INDEX transport_driver_by_driver ON transport_driver_assignment (driver_user_id) WHERE valid_to IS NULL;
