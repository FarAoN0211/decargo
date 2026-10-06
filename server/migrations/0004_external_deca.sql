-- DECARGO · migración 0004: DeCA externo (documento aportado por un tercero, p. ej. el cargador).
-- Solo almacena el PDF recibido y sus datos técnicos. NO afirma que sea un DeCA válido ni que sustituya obligaciones propias.

-- Registro de TODOS los intentos de descarga (también los fallidos: un intento de sondeo SSRF falla). Sirve para las cuotas.
CREATE TABLE external_fetch_log (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES app_user(id),
  device_id    uuid REFERENCES device(id),
  transport_id uuid REFERENCES transport(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  url_host     text,                                  -- solo el host: la URL completa puede ser una capacidad de acceso del cargador
  outcome      text NOT NULL DEFAULT 'STARTED',
  http_status  integer,
  bytes        integer
);
CREATE INDEX external_fetch_log_user_time ON external_fetch_log (user_id, requested_at);

CREATE TABLE external_deca (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES company(id),
  transport_id     uuid NOT NULL REFERENCES transport(id),
  source_url       text NOT NULL,                     -- URL de origen (se conserva: el cargador puede desactivarla a los 7 días)
  final_url        text,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  file_key         char(64) NOT NULL,                 -- mismo almacén por hash que los DeCA propios
  sha256           char(64) NOT NULL,
  size_bytes       integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5000000),
  http_status      integer,
  content_type     text,
  redirects        integer,
  remote_ip        text,
  pdf_header_ok    boolean NOT NULL,                  -- cabecera %PDF y marcador %%EOF: SOLO indica que parece un PDF completo
  review_status    text NOT NULL DEFAULT 'PENDIENTE_DE_REVISION' CHECK (review_status IN ('PENDIENTE_DE_REVISION','REVISADO')),
  reviewed_by      uuid REFERENCES app_user(id),
  reviewed_at      timestamptz,
  notes            text,
  added_by_user    uuid NOT NULL REFERENCES app_user(id),
  added_by_device  uuid REFERENCES device(id),
  device_status    text NOT NULL,                     -- estado del dispositivo en el momento de añadirlo (PENDIENTE o AUTORIZADO)
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transport_id, sha256)
);
CREATE INDEX external_deca_transport ON external_deca (transport_id);
