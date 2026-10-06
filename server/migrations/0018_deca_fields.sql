-- Datos opcionales para el «Modelo DECARGO» (fichas, una página):
--  · nº de autorización de transporte (MDP / Registro de Empresas y Actividades de Transporte) de la empresa, de la agenda y del transportista de cada transporte;
--  · referencia corta y legible de cada transporte (DEC-AAAA-NNNNNN);
--  · número de unidades y tipo de embalaje; mercancía peligrosa (ADR) con su detalle.
-- La hora de carga/descarga va dentro de cada lugar (JSON de origen/destino): no necesita columnas.
ALTER TABLE company ADD COLUMN transport_authorization text;
ALTER TABLE party   ADD COLUMN transport_authorization text;
ALTER TABLE transport
  ADD COLUMN reference text,
  ADD COLUMN carrier_authorization text,
  ADD COLUMN units integer CHECK (units IS NULL OR units BETWEEN 0 AND 999999),
  ADD COLUMN packaging text,
  ADD COLUMN adr boolean,
  ADD COLUMN adr_detail text;

CREATE SEQUENCE transport_reference_seq;
-- Los transportes ya existentes reciben su referencia por orden de creación (no cambia nada de sus DeCA emitidos).
WITH o AS (SELECT id, created_at, row_number() OVER (ORDER BY created_at, id) AS n FROM transport)
UPDATE transport t SET reference = 'DEC-' || to_char(o.created_at AT TIME ZONE 'Europe/Madrid', 'YYYY') || '-' || lpad(o.n::text, 6, '0') FROM o WHERE o.id = t.id;
SELECT setval('transport_reference_seq', GREATEST((SELECT count(*) FROM transport), 1), (SELECT count(*) > 0 FROM transport));
CREATE UNIQUE INDEX transport_reference_unique ON transport (company_id, reference) WHERE reference IS NOT NULL;
