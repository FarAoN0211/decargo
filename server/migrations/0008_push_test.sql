-- Prueba de aviso lanzada por la oficina hacia un dispositivo, con el seguimiento de hasta dónde llega:
-- enviado al servicio de avisos → recibido por el teléfono → mostrado → pulsado.
CREATE TABLE push_test (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),    -- viaja en el aviso y lo devuelve el teléfono (no adivinable)
  device_id    uuid NOT NULL REFERENCES device(id),
  requested_by uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  send_error   text,
  received_at  timestamptz,
  shown_at     timestamptz,
  clicked_at   timestamptz
);
CREATE INDEX push_test_device ON push_test (device_id, created_at DESC);
