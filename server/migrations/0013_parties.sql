-- Agenda propia de empresas (cargadores, destinatarios, transportistas…) y de sus lugares de carga/descarga, con ubicación para compartir con los conductores.
CREATE TABLE party (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES company(id),
  name         text NOT NULL,                 -- razón social
  name_norm    text NOT NULL,                 -- en minúsculas y sin acentos, para buscar
  nif          text,                          -- NIF / CIF / NIE normalizado (mayúsculas, sin espacios ni guiones)
  address      text,                          -- domicilio fiscal
  notes        text,
  active       boolean NOT NULL DEFAULT true,
  use_count    integer NOT NULL DEFAULT 0,    -- veces usada en transportes (para ordenar las recientes primero)
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text NOT NULL
);
CREATE UNIQUE INDEX party_nif ON party (company_id, nif) WHERE nif IS NOT NULL;
CREATE INDEX party_name ON party (company_id, name_norm);

CREATE TABLE party_site (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id    uuid NOT NULL REFERENCES party(id),
  label       text,                           -- «Almacén central», «Muelle 4»…
  kind        text NOT NULL DEFAULT 'AMBOS' CHECK (kind IN ('CARGA','DESCARGA','AMBOS','SEDE')),
  address     text NOT NULL,
  address_norm text NOT NULL,
  lat         numeric(9,6),
  lon         numeric(9,6),
  map_url     text,                           -- enlace de mapa (Google Maps, Apple, Waze, OpenStreetMap…)
  notes       text,                           -- horario, muelle, contacto de la nave…
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL,
  CHECK ((lat IS NULL) = (lon IS NULL)),
  CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180))
);
CREATE INDEX party_site_party ON party_site (party_id);
