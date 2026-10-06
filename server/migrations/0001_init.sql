-- DECARGO · migración 0001: modelo mínimo del primer bloque (esqueleto vertical).
-- Solo las tablas necesarias para: datos de prueba → DeCA → PDF → token → hash → servicio docs.
-- Los nombres y campos siguen docs/03_arquitectura_y_diseno.md §8. Nada destructivo.

CREATE TABLE company (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  nif         text NOT NULL,
  address     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicle (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES company(id),
  plate_norm    text NOT NULL,
  plate_display text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('TRACTORA','SEMIRREMOLQUE','REMOLQUE','RIGIDO')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, plate_norm)
);

-- Datos del art. 6 de la Orden FOM/2861/2012 (a..h). La matrícula (g) vive en transport_vehicle_assignment.
CREATE TABLE transport (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES company(id),
  status            text NOT NULL DEFAULT 'PENDIENTE' CHECK (status IN ('PENDIENTE','EN_CURSO','FINALIZADO','CANCELADO')),
  category          text NOT NULL DEFAULT 'PUBLICO_INTERIOR',
  shipper_name      text NOT NULL,   -- a) cargador contractual
  shipper_nif       text NOT NULL,
  shipper_address   text NOT NULL,
  carrier_name      text NOT NULL,   -- b) transportista efectivo
  carrier_nif       text NOT NULL,
  origin            jsonb NOT NULL,  -- c)
  destination       jsonb NOT NULL,
  cargo_description text NOT NULL,   -- d) naturaleza
  weight_kg         numeric(12,2),   -- d) peso
  alt_magnitude     jsonb,           -- d) otra magnitud si el peso exacto es de difícil determinación
  provisional       boolean NOT NULL DEFAULT false,
  aec_ref           text,            -- e) autorización especial de circulación
  transport_date    date NOT NULL,   -- f)
  remarks           text,            -- h)
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (weight_kg IS NOT NULL OR alt_magnitude IS NOT NULL)
);

CREATE TABLE transport_vehicle_assignment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transport_id uuid NOT NULL REFERENCES transport(id),
  tractor_id  uuid NOT NULL REFERENCES vehicle(id),
  trailer_id  uuid REFERENCES vehicle(id),
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deca (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES company(id),
  kind             text NOT NULL DEFAULT 'OWN' CHECK (kind IN ('OWN','EXTERNAL')),
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPERSEDED','VOID')),
  current_version  integer NOT NULL,
  token_hash       char(64) NOT NULL UNIQUE,   -- SHA-256 del token; es lo único que consulta `docs`
  token_enc        text NOT NULL,              -- token cifrado con APP_KEY (para volver a mostrar el QR)
  public_active    boolean NOT NULL DEFAULT true,
  public_until     timestamptz,                -- NULL = sin desactivación programada (nunca antes de finalizar el servicio)
  retain_not_before date,                      -- «al menos un año»: se fija al finalizar el servicio (año de calendario)
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Modelo preparado para agrupar envíos (RES sexto). En la v1 la aplicación impone 1 transporte = 1 DeCA.
CREATE TABLE deca_transport (
  deca_id      uuid NOT NULL REFERENCES deca(id),
  transport_id uuid NOT NULL REFERENCES transport(id),
  PRIMARY KEY (deca_id, transport_id)
);

CREATE TABLE deca_version (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deca_id         uuid NOT NULL REFERENCES deca(id),
  version_no      integer NOT NULL,
  method          text NOT NULL CHECK (method IN ('NEW','MODIFIED_SAME_PDF','NEW_PDF')),
  reason          text,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  snapshot        jsonb NOT NULL,              -- datos del art. 6 en esta versión
  diff            jsonb,
  file_key        char(64) NOT NULL,           -- clave del almacén = SHA-256 del PDF
  sha256          char(64) NOT NULL,
  size_bytes      integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5000000),
  pdf_created     timestamptz NOT NULL,        -- metadato CreationDate del PDF
  pdf_modified    timestamptz NOT NULL,        -- metadato ModDate del PDF
  prev_version_id uuid REFERENCES deca_version(id),
  UNIQUE (deca_id, version_no)
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  company_id uuid,
  at         timestamptz NOT NULL,
  actor      text NOT NULL,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text NOT NULL,
  before     jsonb,
  after      jsonb,
  reason     text,
  prev_hash  char(64) NOT NULL,
  hash       char(64) NOT NULL
);

-- Inmutabilidad: el registro de auditoría y las versiones de DeCA solo admiten inserciones.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% está protegida: solo admite inserciones', TG_TABLE_NAME;
END $$;

CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER deca_version_immutable BEFORE UPDATE OR DELETE ON deca_version
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Única superficie que lee el servicio `docs`: lo mínimo para resolver un token.
CREATE VIEW docs_resolve AS
  SELECT d.token_hash, v.file_key, v.sha256,
         (d.public_active AND (d.public_until IS NULL OR now() < d.public_until)) AS servable
  FROM deca d
  JOIN deca_version v ON v.deca_id = d.id AND v.version_no = d.current_version;
