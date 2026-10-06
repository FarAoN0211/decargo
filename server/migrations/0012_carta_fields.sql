-- Datos que aparecen en la carta de porte con casillas numeradas (Orden FOM/2861/2012) y que el modelo estándar no imprime. Todos opcionales.
ALTER TABLE transport
  ADD COLUMN price_eur        numeric(12,2),   -- casilla 6: precio del transporte (dato no obligatorio)
  ADD COLUMN carrier_address  text,            -- casilla 7: domicilio del transportista efectivo (si no es la propia empresa)
  ADD COLUMN packages         text,            -- casilla 12: número y clase de bultos (p. ej. «21 palés»)
  ADD COLUMN load_reference   text,            -- casilla 12: referencia de carga
  ADD COLUMN temperature      text;            -- casilla 12: régimen de temperatura («sin temperatura», «+2/+5 ºC»…)
