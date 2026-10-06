-- Control INTERNO de documentos con caducidad (conductores, vehículos y empresa) y de dispositivos/tarjetas de cada vehículo.
-- No son documentos del DeCA: sirven para saber cuándo hay que renovar algo. Las fechas las anota la oficina tal como figuran en el documento.
CREATE TABLE control_document (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES company(id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('DRIVER','VEHICLE','COMPANY')),
  user_id      uuid REFERENCES app_user(id),
  vehicle_id   uuid REFERENCES vehicle(id),
  doc_type     text NOT NULL,                 -- código del catálogo (ITV, CAP, ATP…) o OTRO
  label        text,                          -- nombre libre (obligatorio si OTRO)
  number       text,                          -- número o identificador (opcional)
  detail       text,                          -- p. ej. clases del permiso, clase ATP
  issued_on    date,
  expires_on   date,                          -- NULL = no caduca
  notes        text,
  active       boolean NOT NULL DEFAULT true, -- se archiva, no se borra
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text NOT NULL,
  CHECK ((subject_kind = 'DRIVER' AND user_id IS NOT NULL AND vehicle_id IS NULL)
      OR (subject_kind = 'VEHICLE' AND vehicle_id IS NOT NULL AND user_id IS NULL)
      OR (subject_kind = 'COMPANY' AND user_id IS NULL AND vehicle_id IS NULL)),
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX control_document_expiry ON control_document (expires_on) WHERE active AND expires_on IS NOT NULL;
CREATE INDEX control_document_user ON control_document (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX control_document_vehicle ON control_document (vehicle_id) WHERE vehicle_id IS NOT NULL;

CREATE TABLE vehicle_asset (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES company(id),
  vehicle_id  uuid NOT NULL REFERENCES vehicle(id),
  kind        text NOT NULL CHECK (kind IN ('FUEL_CARD','VIA_T','OTRO')),
  provider    text,                           -- emisor (Solred, DKV, UTA…; VIA-T: concesionaria)
  identifier  text NOT NULL,                  -- número de tarjeta / número de serie
  pin_enc     text,                           -- PIN cifrado con APP_KEY (AES-256-GCM); nunca se devuelve en los listados
  expires_on  date,
  notes       text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL
);
CREATE INDEX vehicle_asset_vehicle ON vehicle_asset (vehicle_id);
CREATE INDEX vehicle_asset_expiry ON vehicle_asset (expires_on) WHERE active AND expires_on IS NOT NULL;
