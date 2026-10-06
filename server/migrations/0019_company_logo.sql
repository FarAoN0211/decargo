-- Logo de la empresa para la cabecera del «Modelo DECARGO».
-- Cada logo subido se guarda una sola vez (por su SHA-256) y nunca se modifica ni se borra: cada DeCA anota en su snapshot el logo con el
-- que se emitió y sus versiones posteriores lo conservan aunque la empresa cambie de logo. El vigente es app_setting 'company_logo' (vacío = sin logo).
CREATE TABLE company_logo (
  sha256     text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime       text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  data       bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 262144),
  width      integer NOT NULL CHECK (width BETWEEN 1 AND 4000),
  height     integer NOT NULL CHECK (height BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL
);
