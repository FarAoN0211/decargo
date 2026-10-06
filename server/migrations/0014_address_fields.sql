-- Domicilio completo: además de la dirección (calle y número), código postal, localidad, provincia y país.
ALTER TABLE company    ADD COLUMN postal_code text, ADD COLUMN city text, ADD COLUMN province text, ADD COLUMN country text;
ALTER TABLE party      ADD COLUMN postal_code text, ADD COLUMN city text, ADD COLUMN province text, ADD COLUMN country text;
ALTER TABLE party_site ADD COLUMN postal_code text, ADD COLUMN city text, ADD COLUMN province text, ADD COLUMN country text;
