-- Ajustes de la instalación que el administrador cambia desde la web (hoy: dirección pública de los DeCA).
-- Viaja con los backups: al restaurar en otro servidor el administrador solo confirma o cambia la dirección en Configuración.
CREATE TABLE app_setting (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
