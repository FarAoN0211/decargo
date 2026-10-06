-- Permisos mínimos por rol. Se reaplica de forma idempotente en cada ejecución de `migrate`
-- (también tras una restauración). Las tablas pertenecen al superusuario; nadie más tiene DDL.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, deca_api, deca_docs, deca_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, deca_api, deca_docs, deca_backup;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO deca_api, deca_docs, deca_backup;

-- api: solo lo que el primer bloque necesita (insertar y leer). Sin UPDATE/DELETE.
GRANT SELECT, INSERT ON company, vehicle, transport, transport_vehicle_assignment,
                        deca, deca_transport, deca_version, audit_log TO deca_api;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO deca_api;

-- docs: únicamente la vista que resuelve el token. Ninguna tabla.
GRANT SELECT ON docs_resolve TO deca_docs;

-- backup: lectura de todo para pg_dump (rol integrado pg_read_all_data).
GRANT pg_read_all_data TO deca_backup;

-- ===== Identidad, sesiones y dispositivos (migración 0002) =====
-- Nada de DELETE: los usuarios con histórico no se borran. UPDATE solo en las columnas imprescindibles.
GRANT SELECT, INSERT ON app_user, activation_token, device, session, refresh_token,
                        login_throttle, transport_driver_assignment TO deca_api;
GRANT UPDATE (password_hash, activated_at, active, deactivated_at) ON app_user TO deca_api;
GRANT UPDATE (attempts, used_at, superseded_at) ON activation_token TO deca_api;
GRANT UPDATE (status, last_seen, decided_by, decided_at) ON device TO deca_api;
GRANT UPDATE (expires_at, revoked_at, revoked_reason, last_refresh_at) ON session TO deca_api;
GRANT UPDATE (used_at) ON refresh_token TO deca_api;
GRANT UPDATE (fails, locked_until, updated_at) ON login_throttle TO deca_api;
GRANT UPDATE (valid_to) ON transport_driver_assignment TO deca_api;

-- ===== Segundo factor TOTP (migración 0003) =====
GRANT UPDATE (totp_secret_enc, totp_enabled_at, totp_last_step) ON app_user TO deca_api;
GRANT UPDATE (mfa_at) ON session TO deca_api;

-- ===== DeCA externo (migración 0004) =====
GRANT SELECT, INSERT ON external_fetch_log, external_deca TO deca_api;
GRANT USAGE ON SEQUENCE external_fetch_log_id_seq TO deca_api;
GRANT UPDATE (finished_at, outcome, http_status, bytes) ON external_fetch_log TO deca_api;
GRANT UPDATE (review_status, reviewed_by, reviewed_at, notes) ON external_deca TO deca_api;

-- ===== Primera interfaz web (migración 0005) =====
GRANT UPDATE (plate_norm, plate_display, kind, active) ON vehicle TO deca_api;
GRANT UPDATE (valid_to) ON transport_vehicle_assignment TO deca_api;

-- ===== Web Push (migración 0006) =====
GRANT SELECT, INSERT, DELETE ON push_subscription TO deca_api;
GRANT UPDATE (device_id, p256dh, auth, updated_at, last_success, last_error) ON push_subscription TO deca_api;
GRANT SELECT, INSERT ON push_event TO deca_api;
GRANT USAGE ON SEQUENCE push_event_id_seq TO deca_api;

-- ===== Ajustes (migración 0007) =====
GRANT SELECT, INSERT ON app_setting TO deca_api;
GRANT UPDATE (value, updated_by, updated_at) ON app_setting TO deca_api;
GRANT SELECT, INSERT ON company_logo TO deca_api;           -- solo se añaden logos: nunca se modifican ni se borran

-- ===== Reemisión de DeCA (el anterior queda SUPERSEDED) =====
GRANT UPDATE (status) ON deca TO deca_api;

-- ===== Datos de la empresa editables desde Configuración =====
GRANT UPDATE (name, nif, address) ON company TO deca_api;

-- ===== Prueba de aviso desde la oficina (migración 0008) =====
GRANT SELECT, INSERT ON push_test TO deca_api;
GRANT UPDATE (sent_at, send_error, received_at, shown_at, clicked_at) ON push_test TO deca_api;
GRANT UPDATE (device_info) ON push_test TO deca_api;

-- ===== Documentos con caducidad y tarjetas/dispositivos de vehículo (migración 0010) =====
GRANT SELECT, INSERT ON control_document, vehicle_asset TO deca_api;
GRANT UPDATE (label, number, detail, issued_on, expires_on, notes, active, updated_at, updated_by) ON control_document TO deca_api;
GRANT UPDATE (provider, identifier, pin_enc, expires_on, notes, active, updated_at, updated_by) ON vehicle_asset TO deca_api;

-- ===== Ficha del conductor (migración 0011) =====
GRANT SELECT, INSERT ON driver_profile TO deca_api;
GRANT UPDATE (nif_enc, ss_enc, iban_enc, iban_holder, birth_date, nationality, phone, email, emergency_name, emergency_phone, street, postal_code, city, province, country,
              hire_date, contract_type, job_category, notes, updated_at, updated_by) ON driver_profile TO deca_api;
GRANT UPDATE (full_name) ON app_user TO deca_api;

-- ===== Agenda de empresas y lugares (migración 0013) =====
GRANT SELECT, INSERT ON party, party_site TO deca_api;
GRANT UPDATE (name, name_norm, nif, address, notes, active, use_count, last_used_at, updated_at, updated_by) ON party TO deca_api;
GRANT UPDATE (label, kind, address, address_norm, lat, lon, map_url, notes, active, updated_at, updated_by) ON party_site TO deca_api;

-- ===== Domicilio completo (migración 0014) =====
GRANT UPDATE (postal_code, city, province, country) ON company, party, party_site TO deca_api;
-- Nueva versión del DeCA (mismo QR y URL) al añadir datos como el conductor: solo se avanza la versión vigente.
GRANT UPDATE (current_version) ON deca TO deca_api;

-- ===== Ciclo de vida del transporte y nuevas versiones del DeCA (migración 0014) =====
GRANT UPDATE (status, started_at, finished_at) ON transport TO deca_api;     -- finalizar y anular (el resto del transporte sigue siendo inmutable)
GRANT UPDATE (retain_not_before) ON deca TO deca_api;                         -- plazo mínimo de conservación al finalizar

-- ===== Relevo de conductores (migración 0017) =====
GRANT SELECT, INSERT, DELETE ON transport_relay TO deca_api;

-- ===== Modelo DECARGO: autorización de transporte y referencia (migración 0018) =====
GRANT UPDATE (transport_authorization) ON company, party TO deca_api;
GRANT USAGE, SELECT ON SEQUENCE transport_reference_seq TO deca_api;
