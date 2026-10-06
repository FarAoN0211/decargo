-- DECARGO · migración 0005: lo mínimo que necesita la primera interfaz web. Solo cambios aditivos.

-- URL con la que se emitió el PDF (la misma que contiene su QR). Los QR que muestre la interfaz salen de AQUÍ,
-- no de la configuración actual: así el QR mostrado es siempre idéntico al del PDF aunque cambie la URL base.
ALTER TABLE deca ADD COLUMN public_url text;

-- Un transporte tiene como máximo UNA asignación de vehículos vigente (como ya ocurre con el conductor).
CREATE UNIQUE INDEX transport_one_current_vehicles ON transport_vehicle_assignment (transport_id) WHERE valid_to IS NULL;
