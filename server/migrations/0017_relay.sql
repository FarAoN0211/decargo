-- Estados del transporte según el conductor: PENDIENTE = sin conductor, EN_CURSO = con conductor, FINALIZADO, CANCELADO (anulado).
-- Relevo: el conductor que CONTINUARÁ cuando el actual termine su parte (uno por transporte).
CREATE TABLE transport_relay (
  transport_id   uuid PRIMARY KEY REFERENCES transport(id),
  driver_user_id uuid NOT NULL REFERENCES app_user(id),
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- Los transportes abiertos se ajustan a la nueva regla.
UPDATE transport t SET status = 'EN_CURSO' WHERE t.status = 'PENDIENTE'
  AND EXISTS (SELECT 1 FROM transport_driver_assignment a WHERE a.transport_id = t.id AND a.valid_to IS NULL);
UPDATE transport t SET status = 'PENDIENTE' WHERE t.status = 'EN_CURSO'
  AND NOT EXISTS (SELECT 1 FROM transport_driver_assignment a WHERE a.transport_id = t.id AND a.valid_to IS NULL);
