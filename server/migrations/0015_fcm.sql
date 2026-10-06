-- Avisos a la app Android (Firebase Cloud Messaging): la suscripción de un dispositivo puede ser Web Push o un token FCM.
-- En las de FCM, `endpoint` guarda el token del teléfono y no hay claves p256dh/auth.
ALTER TABLE push_subscription ADD COLUMN kind text NOT NULL DEFAULT 'WEBPUSH' CHECK (kind IN ('WEBPUSH', 'FCM'));
ALTER TABLE push_subscription ALTER COLUMN p256dh DROP NOT NULL, ALTER COLUMN auth DROP NOT NULL;
ALTER TABLE push_subscription ADD CONSTRAINT push_subscription_keys CHECK (kind = 'FCM' OR (p256dh IS NOT NULL AND auth IS NOT NULL));
