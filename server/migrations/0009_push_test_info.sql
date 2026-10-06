-- Datos del teléfono que devuelve el service worker en la prueba de aviso (navegador, sistema, permiso, si el aviso sigue activo): para diagnosticar.
ALTER TABLE push_test ADD COLUMN device_info jsonb;
