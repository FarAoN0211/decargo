-- Avisos al conductor de cualquier cambio en su transporte (no solo la asignación).
ALTER TABLE push_event DROP CONSTRAINT push_event_type_check;
ALTER TABLE push_event ADD CONSTRAINT push_event_type_check
  CHECK (type IN ('TRANSPORT_ASSIGNED', 'TRANSPORT_UPDATED', 'TRANSPORT_CANCELLED', 'TRANSPORT_UNASSIGNED'));
