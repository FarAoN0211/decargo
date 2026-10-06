<img src="../imagenes/decargo.png" alt="DECARGO" width="200">

# Primeras pruebas en la red local

DECARGO corre en la **<IP-DEL-SERVIDOR>**. Todo es por la API (aún no hay pantallas). **Sin HTTPS**: úsalo solo en tu red.

```
API  = http://<IP-DEL-SERVIDOR>:18080
DOCS = http://<IP-DEL-SERVIDOR>:18081
```

## 0. Estado
```bash
curl -s http://<IP-DEL-SERVIDOR>:18080/healthz          # {"status":"ok"}
```

## 1. Crear tu administrador (en la .130, **antes de nada**)
Pon aquí los datos de tu empresa: la primera empresa que se crea es la que usará todo el sistema.
```bash
cd <carpeta-de-decargo>
./deca create-user --username admin --name "Tu nombre" --role admin \
  --company-name "Tu empresa S.L." --company-nif B12345678 --company-address "Tu dirección"
```
Imprime **una sola vez** un `activation_code` (caduca a las 72 h). No se vuelve a mostrar: guárdalo.

> No uses `POST /api/v1/dev/test-deca` antes de este paso: crearía una empresa «de prueba» y sería la única.

## 2. Activar la cuenta y configurar el TOTP
```bash
API=http://<IP-DEL-SERVIDOR>:18080
curl -s -X POST $API/api/v1/auth/activate -H 'content-type: application/json' \
  -d '{"username":"admin","code":"XXXX-XXXX-XXXX-XXXX","password":"UNA-CONTRASEÑA-LARGA","device_label":"mi-pc"}'
```
La respuesta trae `access_token` y `device` (`id` y `secret`: **guárdalos**, identifican este equipo) con `scope: MFA_PENDING`: falta el segundo factor.
```bash
TOKEN=<access_token>
curl -s -X POST $API/api/v1/auth/totp/setup -H "authorization: Bearer $TOKEN" > totp.json
python3 -c "import json;d=json.load(open('totp.json'));print(d['secret']);open('totp.svg','w').write(d['qr_svg'])"
```
Abre `totp.svg` y escanéalo con tu aplicación autenticadora (o escribe el `secret`: tipo «basado en tiempo», SHA-1, 6 dígitos, 30 s).
```bash
curl -s -X POST $API/api/v1/auth/totp/enable -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"code":"123456"}'      # el código actual de la app → "scope":"FULL"
```

## 3. Iniciar sesión (cada vez)
```bash
curl -s -X POST $API/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"UNA-CONTRASEÑA-LARGA","totp_code":"123456","device":{"id":"<device.id>","secret":"<device.secret>"}}'
```
El access token dura 10 minutos: renuévalo con `POST /api/v1/auth/refresh {"refresh_token":"..."}` (cada refresh entrega uno nuevo y el anterior deja de valer).

## 4. Un DeCA de prueba y su QR
La clave de los endpoints de prueba está en el `.env` de la .130 (`DEV_API_KEY`). **No la pegues en chats ni documentos.**
```bash
KEY=$(ssh <usuario>@<IP-DEL-SERVIDOR> "grep ^DEV_API_KEY= <carpeta-de-decargo>/.env | cut -d= -f2-")
curl -s -X POST $API/api/v1/dev/test-deca -H "authorization: Bearer $KEY"
```
Devuelve `url`, `deca_id`, `transport_id`. Abre `url` en el navegador del móvil: descarga el PDF **directamente**, sin login. Abre el PDF en el PC y **escanea su QR con el móvil**: te lleva al mismo documento.

## 5. Un conductor y un teléfono nuevo (D-05)
```bash
AUTH="authorization: Bearer $TOKEN"; J='content-type: application/json'
curl -s -X POST $API/api/v1/users -H "$AUTH" -H "$J" -d '{"username":"juan","full_name":"Juan Pérez","role":"conductor"}'   # devuelve su activation_code
curl -s -X POST $API/api/v1/transports/<transport_id>/assign-driver -H "$AUTH" -H "$J" -d '{"driver_id":"<id de juan>"}'
curl -s -X POST $API/api/v1/auth/activate -H "$J" -d '{"username":"juan","code":"...","password":"OTRA-CONTRASEÑA-LARGA"}'  # primer dispositivo AUTORIZADO
curl -s $API/api/v1/driver/transports -H "authorization: Bearer <access de juan>"
```
Para simular **el teléfono nuevo**, inicia sesión como `juan` **sin** el campo `device`: queda `PENDIENTE_DE_CONFIRMACION`, con solo lectura y los transportes que ya tenía. La oficina lo ve y decide:
```bash
curl -s "$API/api/v1/devices?status=PENDIENTE_DE_CONFIRMACION" -H "$AUTH"
curl -s -X POST $API/api/v1/devices/<id>/authorize -H "$AUTH"      # o /revoke
```

## 6. DeCA externo
```bash
curl -s -X POST $API/api/v1/driver/external-deca -H "authorization: Bearer <access de juan>" -H "$J" \
  -d '{"transport_id":"<id>","url":"https://servidor-del-cargador.es/ruta/documento.pdf"}'
```
Funciona también desde el teléfono nuevo. Solo se descargan PDF por **https** (puerto 443) de direcciones **públicas**; máx. 5 MB. Cuota: 5 intentos por hora y 15 al día por usuario (cuentan también los fallidos). El documento queda **pendiente de revisión**: nunca se marca como «válido».
La oficina: `GET /api/v1/external-decas`, `GET /api/v1/external-decas/<id>/pdf`, `POST /api/v1/external-decas/<id>/review`.

## 7. Si algo se atasca
- **Perdiste el autenticador:** en la .130, `./deca reset-totp --username admin`.
- **Sesión caducada o bloqueo por intentos:** espera el `Retry-After` de la respuesta.
- **Comprobar la publicación:** en la .130, `./scripts/lan-test.sh`.
- **Ver errores:** `docker compose logs api` (en la .130; los logs no contienen tokens ni contraseñas).
