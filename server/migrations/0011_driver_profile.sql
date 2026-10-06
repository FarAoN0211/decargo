-- Ficha del conductor (datos personales mínimos para la relación laboral). DNI, nº de la Seguridad Social e IBAN van CIFRADOS (APP_KEY).
CREATE TABLE driver_profile (
  user_id        uuid PRIMARY KEY REFERENCES app_user(id),
  company_id     uuid NOT NULL REFERENCES company(id),
  nif_enc        text,            -- DNI / NIE
  ss_enc         text,            -- nº de afiliación a la Seguridad Social
  iban_enc       text,
  iban_holder    text,            -- titular de la cuenta
  birth_date     date,
  nationality    text,
  phone          text,
  email          text,
  emergency_name  text,
  emergency_phone text,
  street         text,
  postal_code    text,
  city           text,
  province       text,
  country        text,
  hire_date      date,
  contract_type  text CHECK (contract_type IS NULL OR contract_type IN ('INDEFINIDO','TEMPORAL','FIJO_DISCONTINUO','AUTONOMO')),
  job_category   text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text NOT NULL
);
