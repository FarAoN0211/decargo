-- Suscripciones Web Push por dispositivo y resultado de los envíos.
CREATE TABLE push_subscription (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    uuid NOT NULL UNIQUE REFERENCES device(id),
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  last_success timestamptz,
  last_error   text
);

CREATE TABLE push_event (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES app_user(id),
  device_id    uuid NOT NULL REFERENCES device(id),
  transport_id uuid NOT NULL REFERENCES transport(id),
  type         text NOT NULL CHECK (type IN ('TRANSPORT_ASSIGNED')),
  status       text NOT NULL CHECK (status IN ('SENT','FAILED','EXPIRED')),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_event_user_created ON push_event (user_id, created_at DESC);
