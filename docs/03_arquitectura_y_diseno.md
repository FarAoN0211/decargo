<img src="../imagenes/decargo.png" alt="DECARGO" width="220">

# DECARGO · Fases 6 a 19: Arquitectura y diseño

> **Revisión 3 (2026-10-03).** **Cloudflare queda descartado**; Nginx Proxy Manager es infraestructura **externa futura**, sin publicación a Internet ahora (§22). D-05 definitivo (§21). P-11 bloquea el cierre de la v1 (§23). Se autoriza la implementación por un **esqueleto mínimo vertical**; el primer bloque está descrito en `ESTADO_PROYECTO.md`.

---

## 6. Arquitectura general (Fase 6)

### Principio
Lo más simple que cumpla la RES. Un solo código base, una base de datos, un almacén de ficheros en disco. Dos procesos del backend (privado y documental) **por seguridad**, no por modularidad.

```
 Oficina (navegador) ─┐   ┌────────────── servidor de la empresa (red local) ───────────────┐
 Conductor (PWA) ─────┼──►│ api  (Fastify, privado, rw)           ─► postgres (rol de api)   │
 Agente (escanea QR) ─┘   │ docs (Fastify, solo lectura)          ─► postgres (rol RO mínimo)│
        ▲ (futuro)        │ web  (estáticos admin/driver, más adelante)                      │
        │                 │ api/docs ──► volumen documents     backup ──► restic ──► disco 2 │
 Nginx Proxy Manager      └───────────────────────────────────────────────────────────────────┘
 (infraestructura EXTERNA, fuera de este Compose)
```

**Publicación:** NPM es infraestructura externa ya existente, fuera del Compose. DECARGO solo expone internamente `docs` y `api`/`web` para que NPM pueda publicarlos en el futuro. **Hoy no hay publicación a Internet.** Caddy no es necesario en el primer bloque; podrá usarse dentro de la arquitectura local si resulta útil.

### Stack aprobado (D-01, D-11)

| Pieza | Elección | Por qué | Alternativa descartada |
|---|---|---|---|
| Backend | **TypeScript + Fastify** | Un solo lenguaje con las dos webs. Ecosistema maduro para PDF, QR, push | Java/Spring (más pesado), Python (válido; se descarta por compartir tipos con el front) |
| Base de datos | **PostgreSQL 16** | Transacciones, `jsonb` para diffs, robustez, backup consistente (`pg_dump`) | SQLite (más simple, pero peor para concurrencia y crecimiento a cientos de miles de filas con varios procesos) |
| Cola/tareas | **`pg-boss`** (sobre PostgreSQL) | Sin Redis. Una dependencia menos | Redis + BullMQ |
| PDF | **`pdf-lib` o `pdfkit`** (generación programática, fuentes embebidas) | PDF nativo, texto real, pequeño (<100 KB), metadatos controlables (R18, R20, R38, R39) | Chromium headless: pesado (>400 MB de imagen), PDFs mayores, más superficie |
| QR | `qrcode` (vectorial, corrección de errores M o Q) | Incrustado en el PDF (R21) | |
| Web admin | **SPA Vue 3 + Vite + TypeScript** (D-11) | Mantenible, sencilla y rápida. Sin librerías de estado ni de UI pesadas salvo necesidad real | |
| PWA conductor | Mismo monorepo, build aparte, **Workbox** | Service worker con versionado | |
| Proxy local | **Caddy** (opcional, solo si resulta útil en la red local; no se usa en el primer bloque) | Enrutado y cabeceras internas | nginx + certbot (más piezas) |
| Publicación futura | **Nginx Proxy Manager** (externo, no integrado en este Compose) | Ya existe en la infraestructura del propietario | — |
| Backups | **restic** + `pg_dump` | Cifrado, deduplicación, versiones, backends S3/rclone | Scripts con `tar` |

**Monorepo:** `server/` (api + docs + comunes), `web-admin/`, `web-driver/`, `packages/shared` (tipos, validaciones), `deploy/` (scripts de operación).

---

## 7. Arquitectura Docker Compose (Fase 7)

### Servicios

| Servicio | Imagen | Exposición | Volúmenes | Healthcheck |
|---|---|---|---|---|
| `api` | imagen propia `deca-server` (cmd `api`) | solo red interna | `documents` (rw), `config` | `GET /healthz` (BD + escritura en almacén) |
| `docs` | misma imagen (cmd `docs`) | solo red interna | `documents` (**ro**) | `GET /healthz` (BD RO + lectura de almacén) |
| `web` *(más adelante, fuera del primer bloque)* | `nginx` o `caddy` con estáticos | solo red interna | ninguno | `GET /` |
| `db` | `postgres:16` | solo red interna | `pgdata` | `pg_isready` + `SELECT 1` |
| `backup` | imagen propia (restic + cron + pg_dump) | ninguna | `documents` (ro), `backup_local` | último backup < N horas |

- Sin microservicios innecesarios: `api` y `docs` son **la misma imagen** con distinto comando.
- Red `internal` (sin salida a Internet salvo `api` para push y `backup`). Los servicios que NPM publicará en el futuro (`docs`, `api`, `web`) publican hoy únicamente en `127.0.0.1`, con puertos configurables en `.env`.
- Todas las imágenes con versión fija. Usuario no root. `restart: unless-stopped`. `depends_on` con `condition: service_healthy`.

### Persistencia
Volúmenes **con nombre de Docker**. El directorio del proyecto reside en un montaje remoto, por lo que PostgreSQL no usa *bind mounts* hacia él:

```
/srv/deca/
 ├─ pgdata/        → postgres
 ├─ documents/     → PDFs (por prefijo de hash)
 ├─ config/        → .env y secretos
 └─ backups/       → backup LOCAL (otro disco)
```
`docker compose down` + recrear + `up -d` **no** pierde nada porque los datos no están en el contenedor (requisito §5).

### Entregables de despliegue
`docker-compose.yml`, `.env.example`, `README.md` de instalación, `docs/ACTUALIZAR.md`, `docs/BACKUP.md`, `docs/RESTAURAR.md`, y un script `./deca` (`install`, `update`, `backup`, `restore`, `verify`, `status`).

### Pasos de instalación
1. Linux. 2. Docker. 3. Docker Compose. 4. Copiar el paquete y configurar `.env`. 5. `docker compose up -d` (acceso local). 6. Asistente inicial. La publicación a Internet (NPM, externo) es una fase posterior y no forma parte de la instalación inicial. Los datos viven en volúmenes externos al ciclo de vida de los contenedores: `docker compose down` seguido de `docker compose up -d` **no** pierde información.

### Asistente inicial
Primera ejecución: la API detecta que no hay empresa y sirve `/setup` (solo hasta crear el primer administrador, protegido por un código de un solo uso impreso en los logs del contenedor). Después el endpoint se deshabilita.

### Hardware
Referencia: 2 vCPU, 4 GB RAM, SSD de 120 GB (para decenas o cientos de miles de PDFs de ~100 KB hacen falta unos 10 a 50 GB al año). Funciona en un mini PC.

---

## 8. Modelo de datos (Fase 8)

Convenciones: `id uuid` (v7), `company_id` en toda tabla de negocio, `created_at/updated_at timestamptz` en UTC, borrado lógico (`deleted_at`) solo donde proceda. Nada de datos legales se sobrescribe sin historial.

```
company(id, name, nif, address, settings jsonb)
user(id, company_id, email/username, password_hash, role, active, totp_secret?, created_at)
driver(id, company_id, user_id, full_name, nif?, phone?, active)        -- nif opcional: no va en el PDF
device(id, company_id, user_id, device_id_random, label, status[PENDING_CONFIRMATION|AUTHORIZED|REVOKED],
       first_seen, last_seen, decided_by, decided_at, push_subscription?)  -- sin IMEI. Ver §21
session(id, user_id, device_id, scope[FULL|LIMITED], refresh_hash, created_at, expires_at, revoked_at, ip_trunc?)
vehicle(id, company_id, plate_norm, plate_display, kind[TRACTORA|SEMIRREMOLQUE|REMOLQUE|RIGIDO], active)

route_day(id, company_id, date, driver_id, notes)                     -- la jornada
transport(id, company_id, route_day_id, seq, status[PENDIENTE|EN_CURSO|FINALIZADO|CANCELADO],
          category, shipper_name, shipper_nif, shipper_address,         -- cargador contractual (a)
          carrier_name, carrier_nif,                                    -- transportista efectivo (b)
          origin jsonb, destination jsonb,                              -- (c)
          cargo_description, weight_kg, alt_magnitude jsonb, provisional boolean, -- (d), P-03
          aec_ref,                                                       -- (e)
          transport_date, remarks,                                       -- (f), (h)
          started_at, finished_at, finished_by, finished_device_time)
transport_vehicle_assignment(id, transport_id, tractor_id, trailer_id, valid_from, valid_to, reason, by_user)
transport_driver_assignment(id, transport_id, driver_id, valid_from, valid_to, reason, by_user)

deca(id, company_id, kind[OWN|EXTERNAL], status[ACTIVE|SUPERSEDED|VOID], current_version,
     token_hash, token_enc, public_active boolean, public_until timestamptz,
     retain_not_before date,          -- «al menos un año»: fin del servicio + 1 año de calendario (R12)
     created_at)
deca_transport(deca_id, transport_id)                                    -- modelo preparado para N:M (RES sexto); v1: 1 transporte = 1 DeCA, sin opción en la UI (D-04)
deca_version(id, deca_id, version_no, method[NEW|MODIFIED_SAME_PDF|NEW_PDF], reason, created_by,
             created_at, snapshot jsonb,        -- foto de los datos art. 6 en esa versión
             diff jsonb,                        -- campos cambiados {campo, antes, despues}
             file_key, sha256, size_bytes, pdf_created, pdf_modified, prev_version_id)
deca_ack(id, deca_version_id, device_id, user_id, downloaded_at)         -- conductor confirma recepción
external_deca(id, deca_id, transport_id, source_url, fetched_at, sha256, size_bytes,
              fetch_result jsonb,            -- código HTTP, Content-Type, cabecera %PDF, tamaño. NADA de contenido interpretado
              review_status[PENDIENTE|REVISADO], reviewed_by, reviewed_at, notes,
              added_by_user, added_by_device)

audit_log(id bigserial, company_id, at, actor_user, actor_device, action, entity, entity_id,
          before jsonb, after jsonb, reason, ip_trunc, prev_hash, hash)   -- append-only, hash encadenado
public_access_log(id, deca_id, at, result, ip_trunc?)                    -- retención corta (p. ej. 90 días)
push_event(id, user_id, device_id, type, payload, sent_at, status)
config(key, value)                                                        -- ajustes de empresa
```

**Decisiones de modelado**
- El `snapshot` por versión es lo que alimenta el PDF. Regenerar el PDF desde un snapshot es **determinista** (misma entrada ⇒ mismo contenido).
- `weight_kg` y `alt_magnitude`: R43. `provisional`: P-03.
- `token_hash` para búsqueda y `token_enc` (cifrado con la clave de aplicación) para poder volver a mostrar el QR en la oficina. `docs` solo necesita `token_hash`.
- Conductor **no** es columna de `deca` (R34).
- `retain_not_before` no es una cuenta de 365 días: se calcula con aritmética de calendario (`fecha_fin + interval '1 year'`) y significa «no borrar antes de». No existe job de purga de documentación legal en la v1.
- La **política de modificación** (§10) no vive en la base de datos de negocio sino en un fichero de configuración versionado, para que sea revisable.
- `audit_log` es solo inserción: en PostgreSQL se revoca `UPDATE/DELETE` al rol de la aplicación y se añade un *trigger* que lo impide.

---

## 9. Almacenamiento documental (Fase 9)

- PDFs en **sistema de ficheros**, no en BLOB: `/data/documents/ab/cd/<sha256>.pdf` (direccionado por contenido, inmutable). La BD guarda `file_key`, hash y tamaño.
- Interfaz `Storage { put, get, exists, verify }` con implementación `LocalFs`. Una implementación S3 (MinIO u otro) se puede añadir **si algún día hace falta**, sin tocar el resto. No se despliega MinIO desde el principio (simplicidad).
- Escritura atómica (fichero temporal + `rename` + `fsync`). La fila de BD se confirma **después** de que el fichero esté en disco. Un trabajo de limpieza elimina huérfanos.
- Tamaño: <5 MB (R20) con objetivo ≈100 KB. 200 000 documentos × 100 KB = 20 GB.
- `verify`: recorre todos los ficheros, recalcula SHA-256 y compara con la BD (se ejecuta semanalmente y tras restaurar).
- Cifrado en reposo del almacén: **no** en la aplicación (se delega en cifrado de disco/LUKS, recomendado en el README). Los backups sí van cifrados.

---

## 10. Versionado y auditoría (Fase 10)

### Regla de elección del método (D-03)
El usuario **no elige** entre método 1 y 2. La regla es fija y predecible:
- Toda modificación permitida usa el **método 1**: mismo QR y URL, nueva versión del PDF, versiones anteriores conservadas, datos anteriores representados como no válidos.
- El **método 2** (nuevo PDF, nuevo QR/URL, original conservado) existe técnicamente solo en dos casos: (a) respaldo automático si el PDF del método 1 no pudiera respetar el límite de 5 MB; (b) acción avanzada de administrador «reemitir con nuevo QR», fuera del flujo normal de edición.

### Política de modificación (capacidad técnica ≠ autorización legal)
Versionar cualquier campo es **posible técnicamente**, pero **no** se permite modificar por el mero hecho de que sea posible. Ninguna fuente leída enumera qué campos pueden modificarse, quién puede hacerlo y cuándo (**P-13**). Hasta validarlo, el servidor aplica una política **restrictiva, explícita y configurable**, que depende de:

| Dimensión | Valores |
|---|---|
| Responsable del dato (ORD art. 7) | cargador contractual: a, b, c, d · transportista efectivo: e, f, g · h: quien la solicita |
| Momento | BORRADOR (sin emitir) · EMITIDO (transporte PENDIENTE) · EN_CURSO · FINALIZADO |
| Rol | `oficina`/`admin` pueden proponer modificaciones; `conductor` no edita datos legales (decisión de diseño, no prohibición jurídica) |

Política **provisional** de la v1 (hipótesis de trabajo, no criterio jurídico):

| Campo (art. 6) | BORRADOR | EMITIDO | EN_CURSO | FINALIZADO |
|---|---|---|---|---|
| a) Cargador (nombre, NIF, domicilio) | libre | con motivo | con motivo | bloqueado |
| b) Transportista efectivo | fijo (la empresa) | no | no | bloqueado |
| c) Origen y destino | libre | con motivo | con motivo | bloqueado |
| d) Naturaleza y peso / magnitud | libre | con motivo | con motivo (caso típico: datos definitivos en la carga, P-03) | bloqueado |
| e) Autorización especial de circulación | libre | con motivo | con motivo | bloqueado |
| f) Fecha de realización | libre | con motivo | con motivo | bloqueado |
| g) Matrícula (tractora, semirremolque) | libre | con motivo | **«Cambiar vehículo»** (base legal expresa, ORD 6.g) | bloqueado |
| h) Observaciones | libre | con motivo | con motivo | bloqueado |

Reglas: «con motivo» exige texto de motivo y genera versión (método 1) y auditoría. Lo bloqueado se rechaza en el servidor con explicación. Tras FINALIZADO la v1 no modifica nada (cómo corregir un error posterior queda en P-13). La política se muestra a la oficina campo por campo.

### Reglas
1. Una **versión** se crea siempre que cambia un dato legalmente relevante **después** de que el DeCA haya sido emitido, y **solo si la política lo permite**. Antes de emitir, los cambios son edición de borrador.
2. Toda versión conserva: snapshot, diff, motivo, usuario, hora, PDF, hash y PDF anterior enlazado.
3. **Método 1 (mismo PDF/URL):** el PDF nuevo sustituye al servido por esa URL, pero el PDF anterior **sigue guardado** (la fila `deca_version` anterior apunta a su fichero) y el PDF nuevo muestra también los datos antiguos tachados («ya no son válidos») y el motivo, como exige la RES quinto.1.
4. **Método 2 (nuevo PDF):** se crea nuevo `token`/URL/QR. El `deca` anterior queda `SUPERSEDED` pero conservado y descargable por la oficina.
5. La URL antigua del método 2 **no se desactiva** al emitirse el nuevo PDF mientras dure el servicio (el conductor puede portar aún el QR antiguo), y la respuesta puede incluir una indicación de sustitución solo en el panel, **nunca** una página intermedia (R25).

### Auditoría
- `audit_log` registra: creación, modificación, cambios de conductor/vehículo/matrícula, estado, accesos administrativos a DeCA, cambios de usuarios, dispositivos, sesiones y configuración.
- **Qué cambió / quién / cuándo / antes / después / por qué**, exactamente lo pedido (§19).
- Hash encadenado: `hash = SHA256(prev_hash || canonical_json(fila))`. El comando `deca verify` detecta manipulación. Es evidencia de integridad interna, **no** sellado de tiempo legal (R47).

### Qué NO se audita
Contenido de contraseñas, tokens completos (solo prefijo), ni accesos de lectura rutinarios de listas.

---

## 11. API privada (Fase 11)

Prefijo `/api/v1`. JSON. Autenticación por cookie de sesión (web) o `Authorization` (PWA instalada, ver D-08). Autorización RBAC + pertenencia a empresa en cada endpoint.

```
Auth
  POST /auth/login                 {user, pass}  → sesión (+ estado de dispositivo)
  POST /auth/refresh   POST /auth/logout   POST /auth/totp/*
  GET  /me

Dispositivos y sesiones (admin)
  GET  /devices?status=PENDING_CONFIRMATION     POST /devices/:id/{authorize|revoke}
  GET  /sessions                   DELETE /sessions/:id

Maestros (oficina)
  CRUD /drivers  /vehicles  /users    (desactivar, nunca borrar físicamente si hay histórico)

Jornadas y transportes
  CRUD /route-days   POST /route-days/:id/reorder
  CRUD /transports   POST /transports/:id/{assign-driver|change-driver|change-vehicle|reorder|cancel}
  GET  /transports?status=PENDIENTE|EN_CURSO|FINALIZADO&date=&driver=

DeCA
  POST /transports/:id/deca                 genera v1 (valida art. 6; devuelve avisos)
  GET  /decas/:id                           metadatos + versiones
  POST /decas/:id/modify  {changes, reason}   el servidor aplica la política (§10) y el método 1
  POST /decas/:id/reissue {reason}            solo admin: método 2 (acción avanzada)
  GET  /decas/:id/versions/:n/pdf           descarga autenticada (solo oficina en la v1; acceso de las partes: futuro, §23)
  GET  /decas/:id/qr.{png|svg}
  POST /decas/:id/public/{disable|enable|rotate}
  GET  /decas/external                      DeCA externos
  POST /decas/external/:id/review {status, notes}   revisión posterior por la oficina
  GET  /audit?entity=&from=&to=             auditoría (admin)

Conductor (PWA)  /driver/*
  GET  /driver/today                        jornada y transportes asignados
  GET  /driver/transports/:id               datos esenciales + versión DeCA vigente + hash
  GET  /driver/decas/:id/current.pdf        PDF vigente (descarga offline)
  POST /driver/decas/:id/ack                {version, hash}
  POST /driver/transports/:id/finish        {device_time}
  POST /driver/external-deca                {url, transport_id}   (cola offline admitida)
  POST /driver/push/subscribe

Sistema
  GET  /healthz  /readyz   GET /version (versión de servidor y mínimo de clientes)
```
**Alcance LIMITADO (sesiones de dispositivos pendientes, D-05):** solo `GET /driver/today`, `GET /driver/transports/:id`, `GET /driver/decas/:id/current.pdf`, `POST …/ack`, `POST …/finish`, `POST /driver/external-deca` y `POST /driver/push/subscribe`, siempre y exclusivamente sobre transportes **del propio conductor asignados antes de registrar el dispositivo**. Todo lo demás devuelve 403. El alcance lo aplica el servidor, nunca el cliente.

Reglas: idempotencia en `finish`, `ack` y `external-deca` (el cliente puede reenviar tras perder la red). Validación estricta de entrada (JSON Schema). Errores sin detalles internos. Límites de tasa.

---

## 12. Endpoint documental / QR (Fase 12)

**Servicio `docs` separado, hostname propio**, p. ej. `https://deca.empresa.es`.

```
GET /d/<token>      → 200 application/pdf  (descarga directa, sin login, sin HTML, sin botones)
GET /healthz        → solo red interna / localhost
(cualquier otra ruta o método) → 404 genérico
```
- **Formato del token:** 32 bytes aleatorios (CSPRNG) en base64url (43 caracteres). La URL final tiene el aspecto `https://deca.empresa.es/d/Qm9…`. Cumple R23 y R25.
- **Sin redirecciones** (una invocación = un PDF, R24). Sin cookies ni CORS.
- Cabeceras: `Content-Type: application/pdf`, `Content-Disposition: inline; filename="DeCA.pdf"`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`.
- **Respuesta uniforme:** token desconocido, desactivado o mal formado ⇒ 404 idéntico y en tiempo similar.
- **Ciclo de vida de la URL (D-07):** activa desde la emisión. **Nunca** se desactiva antes de la finalización del servicio (R23.2); un transporte sin finalizar no caduca y genera una alerta a la oficina. La URL **podrá desactivarse automáticamente a los 7 días naturales** desde la finalización (`public_until`), ajuste configurable por empresa. Desactivar la URL pública **no elimina el documento**.
- **Conservación y acceso posterior son cuestiones distintas:** el documento se conserva al menos un año de calendario (`retain_not_before`) con independencia de la URL pública. La URL del QR sirve durante el transporte; el acceso posterior será otro mecanismo (autenticado) que no se implementa en la v1 (§22 y P-11).
- **QR dentro del PDF** (R21): vectorial, ≥25 mm por lado en impresión, corrección de errores nivel M como mínimo, zona silenciosa de 4 módulos. Contiene **solo** la URL.
- **Registro:** `public_access_log` con resultado y hora. La IP se guarda truncada o no se guarda (minimización), con retención corta.
- Un QR escaneado **no** da acceso a nada más que ese PDF (T05).
- El servicio es de solo lectura sobre un volumen `ro` y un rol de BD con acceso a una vista (`token_hash`, `file_key`, `public_active`, `public_until`, `finished_at`).

---

## 13. Aplicación web de administración (Fase 13)

Principios: rápida, sin sobrecarga, tablas con filtros útiles y atajos. Escritorio primero.

**Pantallas**
1. **Panel (Hoy):** tres columnas Pendientes / En curso / Finalizados, con alertas (DeCA sin generar, conductor sin confirmar descarga, dispositivo pendiente).
2. **Jornadas:** por fecha y conductor. Arrastrar para ordenar transportes. Añadir transporte.
3. **Transporte (detalle):** formulario con los campos del art. 6, indicando para cada uno **quién responde** (cargador o transportista, R08, R09). Botones: *Generar DeCA*, *Cambiar conductor*, *Cambiar vehículo*, *Modificar*. Los campos que la política (§10) no permite modificar aparecen bloqueados con el motivo. **No hay selector de método 1/2.**
4. **DeCA:** visor PDF, versiones (con diff), QR, estado de la URL pública, ACK del conductor, DeCA externos, historial.
5. **Maestros:** conductores, vehículos (tractoras y semirremolques), usuarios.
6. **Dispositivos y sesiones:** «NUEVO DISPOSITIVO PENDIENTE» con **autorizar** o **revocar** (revocar invalida sus sesiones). Sesiones activas con cierre remoto.
7. **Auditoría:** búsqueda y exportación.
8. **Sistema:** salud (BD, almacén, reloj, último backup, espacio libre), versión, ajustes.

**Validaciones asistidas:** avisos de campos del art. 6 vacíos, peso vs magnitud alternativa, matrícula con formato dudoso, `provisional` visible. No bloquean la generación salvo los obligatorios.

**Fuera de alcance (no ERP):** facturación, nóminas, GPS, combustible, mantenimiento, comercial.

---

## 14. Aplicación web/PWA del conductor (Fase 14)

Extremadamente simple. Móvil primero, texto grande, un solo flujo.

```
┌──────────────────────────┐
│ Hola, Juan               │
│ ● Sin conexión · v2      │  ← estado de red y de copia
├──────────────────────────┤
│ TRANSPORTE ACTUAL        │
│ Carrefour Almería →      │
│ Campo de Almería         │
│ DeCA disponible sin cone.│
│                          │
│  [   VER DeCA        ]   │
│  [   MOSTRAR QR      ]   │
│  [ FINALIZAR TRANSPORTE ]│
├──────────────────────────┤
│ SIGUIENTES (2)           │
│  2. Carrefour Roquetas   │
│  + Añadir DeCA externo   │ ← discreto
└──────────────────────────┘
```
- Identidad = usuario (R34 y §11 del enunciado). `device_id` aleatorio generado en el primer uso y guardado en IndexedDB. **No** IMEI.
- Si cambia, pierde o rompe el teléfono (D-05): inicia sesión con sus credenciales en el nuevo y **sigue trabajando** al instante, con acceso limitado a los transportes que ya tenía asignados y a sus DeCA. La oficina lo confirma después. Ver §21.
- Sin mapas, sin chat, sin menú complejo.

---

## 15. Funcionamiento offline (Fase 15)

| Elemento | Dónde se guarda | Cuándo |
|---|---|---|
| App (HTML/JS/CSS) | Cache Storage (precache de Workbox, versionado por *hash*) | Al instalar / actualizar |
| Jornada y transportes | IndexedDB | Cada sincronización |
| PDF de la **versión vigente** del DeCA | IndexedDB como `Blob` (+ hash y versión) | **Automáticamente** al asignarse (push o apertura) |
| URL del QR | IndexedDB; el QR se **genera en local** (no depende de red) | Con el DeCA |
| Cola de acciones (finalizar, ACK, DeCA externo) | IndexedDB (outbox) | Se envía al recuperar red, idempotente |

**Reglas**
- Se descarga el **PDF completo**, no solo el QR (§13 del enunciado). Se verifica contra el hash del servidor.
- Se solicita `navigator.storage.persist()` para evitar expulsión del almacenamiento.
- **Indicadores:** «DeCA disponible sin conexión · vN · descargado hh:mm» o «Versión nueva pendiente: conecte para actualizar».
- **Purga local con holgura (propuesta, a confirmar):** el PDF **no** se borra al pulsar *Finalizar*. Se purga **24 h después de que el servidor confirme la finalización**, solo si no quedan acciones pendientes de sincronizar. Configurable entre 0 y 168 h. Al cerrar sesión se purga con aviso si hay acciones pendientes. Si el dispositivo se revoca, se purga al contactar con el servidor. Al llegar una versión nueva del DeCA se sustituye la anterior. Un transporte no finalizado **nunca** se purga.
- La sincronización usa `Background Sync` donde exista (Android/Chrome). En iOS no existe, así que se sincroniza al abrir la app y con el evento `online`.
- **Limitaciones de iOS (documentadas, a verificar con pruebas reales):** el almacenamiento puede ser expulsado si la app no se usa durante semanas y no está instalada en pantalla de inicio. La PWA **debe** pedir instalación y mostrar aviso si no está instalada.
- **Jurídico:** **P-01** (ver `REQUISITOS_LEGALES_DECA.md`). La copia offline es una mitigación técnica, no una garantía de cumplimiento. Se ofrece **copia impresa** (RES séptimo.2) como respaldo en la oficina.

---

## 16. Notificaciones (Fase 16)

**Web Push (VAPID)** con la librería `web-push`, enviado desde `api` (única salida a Internet autorizada, aparte de backup).

| Plataforma | Situación | Fuente |
|---|---|---|
| **Android (Chrome, Edge, Firefox)** | Funciona en PWA instalada **y** en pestaña normal. Notificaciones con la app cerrada | Estándar W3C |
| **iOS/iPadOS ≥16.4** | **Solo** si la web está **añadida a la pantalla de inicio**. El permiso debe pedirse **tras un gesto del usuario** (toque en un botón). Sin permiso silencioso. `setAppBadge` disponible. Hay que permitir `*.push.apple.com` | https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ |
| **iOS en la UE** | Apple retiró las web apps independientes en la UE con iOS 17.4 y después **indicó que mantendrá** las existentes. Esto se ha leído en fuentes privadas y **no se ha verificado** en fuente oficial de Apple | PENDIENTE DE VERIFICAR con un iPhone real |

**Diseño**
- Botón explícito «Activar avisos» en la PWA (cumple el requisito de gesto en iOS).
- Los avisos **no llevan datos sensibles**: «Nuevo transporte asignado» / «DeCA actualizado».
- **La notificación nunca es el único canal.** Al abrir la PWA, esta sincroniza y muestra el estado real. Si el conductor no confirmó la descarga (ACK), la oficina lo ve y puede avisar por otro medio.
- Las suscripciones caducadas (410) se eliminan. Desactivar usuario elimina sus suscripciones.

---

## 17. Backups (Fase 17)

**Capas** (RAID no es backup):

| Capa | Qué protege | Qué NO protege |
|---|---|---|
| RAID 1 (opcional, hardware del cliente) | Fallo físico de un disco | Borrado, corrupción, ransomware, errores del software |
| **Backup local versionado** (disco independiente) | Borrado accidental, corrupción, errores | Fuego/robo del equipo |
| **Backup remoto cifrado** (opcional: S3 compatible, Google Drive/Workspace vía rclone) | Pérdida del local | Pérdida de las claves |

**Mecanismo**
1. `pg_dump` consistente (formato *custom*) a un directorio temporal.
2. `restic backup` de: dump, `documents/`, `config/` (sin `pgdata`; el dump basta).
3. Repositorio **cifrado** (AES-256, clave en `RESTIC_PASSWORD`). Deduplicado e **incremental**.
4. Política de retención de backups: p. ej. 7 diarias, 4 semanales, 12 mensuales, 3 anuales. La conservación legal de los documentos («al menos un año», R12) se cumple en el almacén documental y no depende de la rotación de backups.
5. `restic check` semanal. Alerta en el panel si el último backup tiene más de 26 h o falla.
6. Remoto: segundo repositorio restic con otro backend. Credenciales por *secrets*, cuenta de servicio con permisos mínimos (si es posible, solo escritura / *append-only*, para resistir ransomware).
7. **Las claves son parte del plan:** `RESTIC_PASSWORD`, claves de aplicación (`APP_KEY`, VAPID, HMAC) y `.env` se **entregan una vez al administrador** (impresión/gestor de contraseñas) y se guardan **fuera del servidor**. Sin ellas el backup no se puede descifrar y los QR existentes pueden perder validez.

### Backup de desarrollo y backup operativo (aclaración de 2026-10-03)

| | **Backup de desarrollo** (hoy) | **Backup operativo / producción** (pendiente) |
|---|---|---|
| Ubicación | Volumen Docker `decargo_backups`, **en el mismo equipo y disco** | **Copia independiente del almacenamiento principal** (otro disco/equipo) |
| Sirve para | Validar el mecanismo de backup y la restauración | Proteger de verdad frente a pérdida del servidor, borrado o ransomware |
| Es suficiente en producción | **No** | Destino por decidir; opcionalmente además copia remota cifrada |

No se configuran todavía servicios externos de backup ni se decide el almacenamiento definitivo.

---

## 18. Restauración completa (Fase 18)

Objetivo: **RTO** de unas horas, **RPO** ≤ 24 h (configurable más corto con backups más frecuentes).

```
0. Material necesario: equipo con Linux + Docker; paquete de la plataforma; claves (restic + .env)
1. docker compose pull / carga de imágenes de la versión indicada
2. ./deca restore --repo <ruta|s3|rclone> --snapshot latest
      a) restaura documents/ y config/
      b) levanta solo `db`, importa el dump (pg_restore)
      c) aplica migraciones SOLO si la versión del paquete es posterior
3. docker compose up -d
4. ./deca verify
      - hash de todos los PDFs contra BD
      - audit_log: hash encadenado íntegro
      - comprobación de extremo a extremo: GET /d/<token de prueba> sin credenciales
      - login oficina y conductor; carga de la PWA y de la copia offline
5. Reconectar la publicación externa (NPM, cuando exista) y repetir las pruebas con un QR real
6. Informe de restauración (fecha del snapshot, documentos, discrepancias)
```
**Un backup no se considera validado porque el proceso de copia termine sin errores.** Antes de dar el sistema por terminado es **obligatoria** una prueba de aceptación en entorno limpio, con un conjunto de datos grande (p. ej. 100 000 PDFs) y midiendo el tiempo:

```
SERVIDOR VACÍO → RESTAURAR BACKUP → LEVANTAR DOCKER COMPOSE → VERIFICAR BASE DE DATOS
→ VERIFICAR HASHES DE DOCUMENTOS → VERIFICAR LOGIN (oficina y conductor)
→ VERIFICAR PWA (carga, service worker, copia offline) → VERIFICAR UN QR/URL REAL DE PRUEBA
```
La URL de prueba debe responder a un `GET` público sin credenciales con el PDF directo, y se prueba con la URL local; la prueba externa mediante Nginx Proxy Manager se hará más adelante. Se documentará el resultado en `ESTADO_PROYECTO.md`. Este procedimiento **no está probado todavía** (no hay código).

---

## 19. Actualización mediante Docker Compose (Fase 19)

`./deca update <versión>`:
1. Comprueba espacio, salud actual y que no hay backups en curso.
2. **Backup obligatorio** (etiquetado `pre-update-<versión>`).
3. `docker compose pull` de imágenes con tag fijo (nunca `latest`).
4. Migraciones **aditivas** (patrón *expand/contract*): primero añadir, desplegar y solo en una versión posterior retirar. Nunca `DROP` ni `UPDATE` masivo silencioso. Las migraciones que lo requieran piden confirmación explícita y se ejecutan tras backup verificado.
5. `docker compose up -d`, esperar a `healthy`.
6. `./deca verify` (rápido).
7. **Rollback:** si falla, `./deca rollback` vuelve a las imágenes anteriores y, **solo si la migración no era compatible hacia atrás**, restaura el backup `pre-update`. Se documenta qué migraciones son reversibles.

**Clientes web (§32 del enunciado)**
- Los estáticos llevan *hash* en el nombre. `index.html` y `sw.js` con `Cache-Control: no-cache`. Workbox detecta el nuevo service worker.
- `/api/v1/version` devuelve `server_version` y `min_client_version`. Si el cliente es inferior, la API responde `426` y la PWA muestra **«Actualizar ahora»** (recarga controlada).
- El service worker no hace `skipWaiting` en mitad de una acción. Pregunta al terminar o al abrir la app, de modo que ningún dispositivo queda indefinidamente en una versión antigua.
- Compatibilidad: el servidor admite la versión de cliente actual y la anterior (las acciones en cola offline siguen siendo válidas).

---

## 20. Estado de las decisiones D-01 a D-12 (revisión 3)

| ID | Decisión | Estado |
|---|---|---|
| **D-01** | TypeScript, Fastify, PostgreSQL, Caddy cuando sea útil dentro de la arquitectura local, restic. No se cambia el stack salvo impedimento técnico real, informándote antes | **Aprobada** |
| **D-02** | `api` y `docs` separados, misma imagen. `docs`: solo lectura, rol PostgreSQL con permisos mínimos (solo lo necesario para resolver el token), volumen documental `read-only`, sin funciones administrativas ni capacidad de modificar DeCA | **Aprobada** |
| **D-03** | Método 1 como comportamiento normal; método 2 disponible solo cuando sea realmente necesario; la interfaz no pide elegir. Es una decisión técnica, no una afirmación jurídica | **Aprobada con matiz** |
| **D-04** | v1: 1 transporte = 1 DeCA; modelo preparado para agrupar; sin opción en la UI | **Aprobada** |
| **D-05** | Identidad ≠ confianza del dispositivo. Pendiente con sesión limitada de 72 h, máx. 3 pendientes, PIN opcional, primer dispositivo por contraseña temporal | **Aprobada con el diseño de §21** |
| **D-06** | Sin firma, certificados, sellos, sellado de tiempo, firma biométrica ni OTP de firma | **Aprobada** |
| **D-07** | URL pública desactivable a los 7 días naturales tras finalizar; nunca antes; alerta si un transporte queda abierto anormalmente; documentos no se eliminan; sin segundo token improvisado | **Aprobada con modificaciones** |
| **D-08** | **Cloudflare descartado.** Nginx Proxy Manager (externo, futuro) cuando se publique. Nada de publicación ahora | **Corregida** (§22) |
| **D-09** | Backup local versionado, restic, remoto opcional, S3/rclone, RAID no es backup | **Aprobada** |
| **D-10** | «Al menos un año» como periodo de calendario (`retain_not_before`); sin purga automática de documentos legales; logs públicos 90 días; sin borrado automático de otros datos personales | **Aprobada con corrección** |
| **D-11** | Vue | **Elegida** |
| **D-12** | Solo español en la v1 | **Aprobada** |

**Valores aprobados:** purga local 24 h desde el `finished_at` confirmado por el servidor · sesión limitada 72 h · 3 dispositivos pendientes máximo.
**Valor que fijo provisionalmente (no lo indicaste):** caducidad de la contraseña temporal de activación = **72 h**, configurable.

Las cuestiones jurídicas **P-01 a P-13** siguen abiertas. **P-11 bloquea el cierre de la v1** (§23).

---

## 21. Diseño de confianza del dispositivo (D-05, definitivo)

### Principio
**Identidad** (credenciales) y **confianza del dispositivo** son cosas separadas. Credenciales correctas **nunca** dejan al conductor sin acceso documental. Lo único que varía con la confianza es el **alcance**.

### Estados
```
(desconocido) --login correcto--> PENDIENTE_DE_CONFIRMACION --oficina autoriza------------> AUTORIZADO
                                         |  \--PIN de alta correcto (opcional)---------------^
                                         +--oficina revoca--> REVOCADO <-- oficina revoca (desde AUTORIZADO)
```
- `device_id`: valor aleatorio generado en el primer uso, guardado en IndexedDB. No es IMEI.
- Máximo **3** dispositivos `PENDIENTE_DE_CONFIRMACION` simultáneos por usuario. Al llegar al máximo no se crea un cuarto, se informa al usuario, los anteriores se mantienen y la oficina puede autorizar o revocar. Los `REVOCADO` no cuentan.

### Alcance de la sesión provisional (dispositivo pendiente), aplicado en el servidor
**Decisión vigente: SOLO LECTURA** hasta que el propietario decida (análisis en `docs/02_amenazas.md` «3 bis»).

| Puede (solo lectura) | No puede |
|---|---|
| Ver **sus** transportes ya asignados (los anteriores al registro del dispositivo) | Ver transportes de otros conductores |
| Obtener el DeCA vigente de esos transportes (PDF) | Acceder al panel administrativo ni a la auditoría |
| Obtener el QR correspondiente | Modificar usuarios, vehículos, configuración o datos legales del DeCA |
| **Añadir DeCA externo** a un transporte propio (cuota + anti-SSRF, §27) | |
| | **Finalizar transporte** (pendiente de decisión) |
| | Confirmar recepción (ACK) ni suscribirse a avisos (no implementados) |

- Los transportes asignados **después** del registro del dispositivo pendiente no se muestran hasta que se autorice.
- **Máximo 72 h.** Pasado ese tiempo debe volver a autenticarse; si el dispositivo sigue pendiente, obtiene otra sesión provisional. La expiración no elimina transportes, no modifica DeCA, no borra datos del servidor y no altera asignaciones.
- El alcance lo aplica el servidor, calculándolo desde la base de datos en cada petición (autorizar o revocar surte efecto de inmediato).

### PIN de alta (opcional)
- **No es necesario** para el acceso documental desde un teléfono nuevo.
- Si el conductor dispone de él y lo introduce correctamente, el dispositivo pasa **de inmediato** a `AUTORIZADO`.
- Se guarda con hash (argon2id) y con límite de intentos (al agotarlos, el PIN queda inutilizable para ese usuario hasta que la oficina lo restablezca; **esto nunca afecta al acceso provisional**).
- Sin SMS de pago ni servicios externos.

### Oficina
- Alerta **NUEVO DISPOSITIVO PENDIENTE**. Acciones: **AUTORIZAR** y **REVOCAR**.
- **REVOCAR:** invalida sus sesiones, invalida sus *refresh tokens*, elimina o revoca las suscripciones push asociadas y no admite nuevos accesos con esa sesión.
- **Riesgo residual:** un dispositivo revocado que siga totalmente desconectado puede conservar temporalmente la información ya guardada en local hasta que contacte con el servidor.
- Desactivar un usuario invalida todas sus sesiones.

### Primer dispositivo y contraseña temporal
La oficina crea al conductor con una **contraseña temporal** que debe ser:
- de **un solo uso**;
- con **caducidad** (provisional 72 h, configurable);
- obligar a fijar una **contraseña definitiva** al activarse;
- **invalidada inmediatamente** tras su uso correcto;
- **nunca almacenada en texto plano** (hash argon2id).

El primer dispositivo activado así queda `AUTORIZADO`. Los siguientes siguen el flujo anterior.

### Usuarios de oficina
No usan el modo pendiente: su control es el **TOTP obligatorio** (implementado; ver §26).

---

## 22. Publicación futura: Nginx Proxy Manager, infraestructura externa (D-08)

**Cloudflare, Cloudflare Tunnel y `cloudflared` están descartados.** No hay perfiles, variables, servicios ni lógica específicos de Cloudflare en DECARGO.

### Estado actual
- **No se configura publicación a Internet**: ni dominio, ni DNS, ni certificados públicos, ni NPM, ni puertos del router, ni NAT.
- En desarrollo y pruebas solo hay **acceso local**: los servicios publican en `127.0.0.1` (puertos configurables en `.env`).
- No se presupone la configuración de tu red.

### Futuro (no implementado)
**NPM es infraestructura externa ya existente y no se integra en el Compose de DECARGO** salvo que lo pidas.
```
Internet → dominio/subdominio HTTPS → Nginx Proxy Manager → servicio `docs` → PDF directo
                                                         └→ `api` / `web` (cuando se decida)
```
DECARGO solo debe exponer internamente `docs` y `api`/`web` para que NPM los publique. Cuando llegue la fase de publicación aportarás los datos de tu NPM y decidiremos cómo conectarlo.

### Requisitos para esa fase (sin implementar ahora)
En la ruta documental del QR no puede haber: login, CAPTCHA, página intermedia, botón de descarga, autenticación, *challenge* anti-bot, redirecciones innecesarias ni ninguna interacción manual. Debe poder comprobarse desde un dispositivo externo: **escanear QR → URL HTTPS → NPM → `docs` → PDF directo**, con TLS mínimo 1.2 (R23).

### Independencia de la lógica
- La aplicación solo conoce una URL base pública para construir las URL del QR (`PUBLIC_DOCS_BASE_URL`). En desarrollo es local, p. ej. `http://127.0.0.1:8081`.
- **Aviso:** las URL de QR de pruebas locales usan `http`, **no cumplen R23** (HTTPS). Son solo de prueba; el generador debe exigir `https` en producción.
- Caddy no se usa en el primer bloque. Podrá añadirse más adelante dentro de la red local si resulta útil (p. ej. servir estáticos), sin ser parte de la publicación.
- La gestión de cabeceras de proxy (IP de cliente) se diseñará al publicar (T30).

---

## 23. Acceso posterior de las partes y P-11 (pendiente, bloquea el cierre de la v1)

- La URL pública del QR sirve durante el transporte y puede desactivarse a los 7 días. **No** es el mecanismo de acceso posterior. No son contradictorias.
- Los documentos y sus versiones se conservan sin purga automática al menos un año de calendario (`retain_not_before`).
- **Entregar manualmente el PDF desde la oficina durante un año NO se acepta como solución definitiva de la v1.**
- **Antes de dar por terminada la v1** debe **definirse y documentarse** un mecanismo sencillo y seguro para que la contraparte pueda disponer del documento durante el periodo exigido, **una vez confirmado el alcance legal** (qué significa «poder descargar», para quién, desde cuándo). No se confunde con la URL pública y **no** se crea un segundo token público de larga duración improvisado.
- Estado hoy: la arquitectura está preparada (almacén por hash, endpoint autenticado para la oficina, `docs` intacto), pero **no se implementa ningún acceso de contraparte**. Seguirá como **P-11** hasta cerrarlo.

---

## 24. Primer bloque implementado: diferencias con el diseño

Implementado el 2026-10-03. Detalle y resultados en `ESTADO_PROYECTO.md` e `informes/`.

| Diseño | Lo implementado | Motivo |
|---|---|---|
| `public_access_log` en la base de datos | El servicio `docs` escribe el registro de accesos en la **salida estándar** (hora, resultado, 8 primeros caracteres del hash del token). Sin IP y sin el token | D-02 exige que `docs` sea de solo lectura. Escribir en PostgreSQL contradice eso. La retención de 90 días queda pendiente (rotación de logs) |
| Errores de `docs` → 404 genérico | 404 genérico para token desconocido, mal formado o desactivado; **503** para fallos internos; **429** al superar el límite | Un fallo de base de datos no debe parecer «documento inexistente» |
| `/healthz` en `docs` | Salud en un **puerto interno distinto** (9001, no publicado). El puerto público solo tiene `GET /d/:token` | La ruta pública no debe exponer nada más |
| UUID v7 | **UUID v4 por decisión del propietario** (`gen_random_uuid`, `randomUUID`) | v4 satisface las necesidades actuales; no se migra a v7 solo para coincidir con el diseño |
| `audit_log` con `before/after` libres | Solo cadenas, booleanos y enteros (para que el hash canónico sea reproducible) | Hash encadenado estable |
| Servicios `caddy`, `web` | **No existen** en el primer bloque | Sin interfaz ni publicación. Ver §22 |
| Backup programado | `./deca backup` **manual**; sin planificador ni política de retención de snapshots | Fuera del primer bloque |
| `restore` | Además recupera `APP_KEY` del backup y guarda `.env.from-backup`; `verify` comprueba que los tokens se pueden descifrar | Necesario para que los QR sigan mostrándose tras un desastre |
| Rate limit de `docs` | 600 peticiones/min por IP de conexión, en memoria | Detrás de un proxy habrá que configurar la IP de cliente (T30) |
| Roles `deca_api` | Solo `SELECT` e `INSERT` sobre 8 tablas (sin `UPDATE`/`DELETE`) | Mínimo privilegio. Se ampliará con cada función que lo requiera |
| Red | `back` (internal, sin salida), `front` (solo `api`) y **`edge` (solo `docs`)**: bridge sin enmascaramiento NAT, más `dns: [127.0.0.1]`. **`docs` no tiene salida a Internet ni resuelve nombres externos** y sigue recibiendo conexiones por su puerto publicado (comprobado con un origen externo simulado). `DOCS_BIND` permitirá abrirlo a la red local para un proxy externo | Docker no publica puertos desde redes `internal`; `edge` lo consigue con un solo ajuste. Verificado en `informes/docs-red-*.md`. Límite: `docs` aún alcanza servicios del propio anfitrión por la puerta de enlace de su red (cualquier contenedor puede). `api` conserva su red (tiene salida: se revisará cuando se cierre su alcance) |

---

## 25. Segundo bloque implementado: identidad, sesiones y dispositivos

Implementado el 2026-10-03. Resultados en `informes/identidad-*.md` y `informes/identidad-restauracion-*.md`.

### Tablas (migración `0002_identity.sql`)
`app_user`, `activation_token`, `device`, `session`, `refresh_token`, `login_throttle`, `transport_driver_assignment`. Nada se borra: `deca_api` no tiene `DELETE` en ninguna tabla y los `UPDATE` se limitan por columna.

### Roles y autorización
`admin`, `oficina`, `conductor`, `solo_lectura`. Se comprueba en el servidor en cada petición (sesión, usuario activo, estado del dispositivo y rol, leídos de la base de datos).
- **admin**: gestiona usuarios de cualquier rol, dispositivos y consulta la auditoría.
- **oficina**: crea, desactiva y reemite credenciales de **conductores**; autoriza y revoca dispositivos de conductores; asigna conductores a transportes. Sin auditoría.
- **solo_lectura**: lee transportes, DeCA y dispositivos.
- **conductor**: solo `/api/v1/driver/*`, solo lectura.

### Parámetros reales
| Parámetro | Valor | Origen |
|---|---|---|
| Access token | 600 s (10 min), firmado con HMAC derivado de `APP_KEY` | provisional |
| Sesión de dispositivo pendiente | **72 h** (absoluta) | aprobado |
| Dispositivos pendientes por usuario | **3** | aprobado |
| Conductor con dispositivo autorizado | refresh 30 días, sesión máxima 90 días | provisional |
| Oficina, admin, solo lectura | refresh 8 h, sesión máxima 24 h | provisional |
| Credencial temporal de activación | 16 caracteres (80 bits), 72 h, 5 intentos, un solo uso | provisional |
| Contraseña | Argon2id (m=19 456 KiB, t=2, p=1); mínimo 10 y máximo 128 caracteres; rechazo de las más comunes, repetitivas, secuenciales o que contengan el usuario | provisional |
| Fuerza bruta | por (usuario, IP): 5 fallos → 1 min, 8 → 5 min, 10 → 15 min · por usuario: 20/40/60 · por IP: 30/60/100 · límite de 120 peticiones/min en `/auth/*` | provisional |

### Endpoints nuevos
`POST /api/v1/auth/{login,activate,refresh,logout}`, `GET /api/v1/me`, `POST|GET /api/v1/users`, `POST /api/v1/users/:id/{deactivate,activation}`, `GET /api/v1/devices`, `POST /api/v1/devices/:id/{authorize,revoke}`, `GET /api/v1/audit`, `GET /api/v1/transports`, `POST /api/v1/transports/:id/assign-driver`, y del conductor `GET /api/v1/driver/transports[/:id]`, `GET /api/v1/driver/decas/:id/{current.pdf,qr.svg}`. Los de DeCA del bloque 1 pasan a exigir rol (oficina, admin o solo lectura).

### Diferencias con el diseño
| Diseño | Implementado | Motivo |
|---|---|---|
| `device_id` aleatorio | Id **y secreto de 256 bits** generados por el servidor; la confianza la da la posesión del secreto | Conocer un id no debe bastar para heredar la confianza de un dispositivo |
| Cookie `HttpOnly` | Tokens en JSON y cabecera `Authorization` | Aún no hay cliente web; se decidirá con las pantallas (T41) |
| Oficina con TOTP obligatorio | **Implementado después** (§26). Sus dispositivos nuevos siguen quedando AUTORIZADOS: el control es el TOTP | Riesgo T38 resuelto |
| Asistente `/setup` | Primer administrador por CLI: `./deca create-user` | Sin endpoint público de configuración |
| Contraseña temporal para entrar | Endpoint de **activación** con código de un solo uso | Más simple y seguro |
| Pendiente: «ACK», push, DeCA externo | Solo lectura al principio; **DeCA externo habilitado después** (§27). ACK y push siguen sin existir | Decisión del propietario |
| Login por correo | Nombre de usuario en minúsculas | Sin dependencia de correo |
| Sesiones tras restaurar | Todas se **invalidan**; los dispositivos conservan su confianza | Decisión documentada en T39 |
| `solo_lectura` sin acceso a dispositivos | Puede listarlos (solo lectura) | Coherente con su rol |

---

## 26. TOTP de oficina (implementado)

Implementado el 2026-10-03, antes de cualquier publicación. Pruebas: `informes/identidad-20261003T145403Z.md` (185/185) e `informes/identidad-restauracion-20261003T145551Z.md` (26/26).

### Qué hace
- **Roles afectados:** `admin`, `oficina`, `solo_lectura`. No los conductores (D-05).
- **Estándar:** RFC 6238 (HMAC-SHA1, 6 dígitos, paso de 30 s), con `node:crypto`, **sin dependencias nuevas**. Validado contra los vectores oficiales del RFC y contra un generador independiente escrito para la prueba.
- **Alcance `MFA_PENDING`:** la sesión de un rol de oficina sin segundo factor solo permite configurarlo, ver `/me` y cerrar sesión. Cualquier otra función devuelve `403 mfa_required`. Se calcula desde la base de datos en cada petición (`session.mfa_at`), así que una sesión sin constancia de segundo factor (p. ej. anterior a esta versión) queda en `MFA_PENDING`.
- **Inicio de sesión:** con TOTP activo, el código es obligatorio en la misma petición y **no se crea sesión ni dispositivo antes de superarlo**.
- **Anti-repetición:** `app_user.totp_last_step`; solo se acepta un paso posterior al último usado (actualización atómica). Tolerancia de ±1 paso.
- **Fuerza bruta:** los códigos erróneos suman al mismo bloqueo progresivo que las contraseñas.
- **Secreto en reposo:** AES-256-GCM con una clave derivada de `APP_KEY` por HKDF con separación de dominio. `APP_KEY` ya viaja en el backup, así que **tras restaurar los secretos se descifran**; `./deca verify` lo comprueba.
- **Reinicio (autenticador perdido):** `POST /api/v1/users/:id/totp/reset` (solo admin, nunca el propio) o `./deca reset-totp --username u` en el servidor. Borra el secreto, revoca las sesiones y audita `TOTP_RESET`.
- **Restablecimiento de contraseña:** reemitir la credencial de activación no salta el segundo factor: exige además el código vigente y no se consume mientras falle.

### Endpoints
`POST /api/v1/auth/totp/setup`, `POST /api/v1/auth/totp/enable`, `POST /api/v1/users/:id/totp/reset`; `totp_code` opcional en `login` y `activate`; `mfa_required` en las respuestas y en `/me`; `totp_enabled` en el listado de usuarios.

### Migración `0003_totp.sql`
`app_user.totp_secret_enc`, `totp_enabled_at`, `totp_last_step` y `session.mfa_at`. Aditiva; permisos `UPDATE` solo sobre esas columnas.

### Decisiones propias (no estaban en el encargo)
| Decisión | Motivo |
|---|---|
| **Sin códigos de recuperación** | No solicitados; la salida es el reinicio por un admin o por CLI |
| El alta se permite con la sesión `MFA_PENDING` (solo contraseña) | Alguien debe poder configurarlo la primera vez; riesgo T42 acotado |
| Con el TOTP activo **no** se puede repetir el alta | Un atacante con una sesión no puede sustituir el autenticador |
| Un admin puede reiniciar el TOTP de otro, no el suyo | Hace falta una salida operativa sin crear una puerta trasera |
| Los dispositivos de oficina siguen autorizándose solos | El control de oficina es el TOTP, no el dispositivo |

### Riesgos residuales
T42 (alta con solo contraseña antes de que el titular enrole), T43 (secreto + `APP_KEY` en la misma copia), T44 (pérdida del único autenticador del único admin → `./deca reset-totp` en el equipo), T45 (phishing en tiempo real), T46 (hace falta NTP y no hay alerta de deriva).

---

## 27. DeCA externo (implementado)

Implementado el 2026-10-03. Pruebas: `scripts/ssrf-test.sh` (59), sección 15 de `scripts/identity-test.mjs` (47 comprobaciones propias) y restauración con documentos externos.

### Componentes
- `server/src/external/netpolicy.ts`: política de direcciones y validación de URL.
- `server/src/external/fetcher.ts`: `SafeFetcher` (descargador anti-SSRF).
- `server/src/external/service.ts` y `routes.ts`: cuotas, almacenamiento, auditoría, revisión.
- Migración `0004_external_deca.sql`: `external_deca` y `external_fetch_log`.

### Decisiones
| Decisión | Motivo |
|---|---|
| Tabla propia `external_deca`, **no** una fila `deca kind=EXTERNAL` | Un DeCA propio exige token público y versiones; el externo no es nuestro documento y no debe poder confundirse con uno |
| `review_status` solo admite `PENDIENTE_DE_REVISION` y `REVISADO` | No existe en el modelo un estado «válido» |
| El registro de intentos cuenta también los fallidos | Un sondeo SSRF siempre falla: la cuota debe frenarlos |
| Cuota: 5/hora y 15/día por usuario, 5 documentos por transporte | Valores iniciales (propuesta de «3 bis»); configurables por entorno |
| Respuesta con categorías gruesas | El detalle («dirección privada») sería un oráculo para sondear la red |
| Se guarda la URL completa de origen en `external_deca`, y solo el host en el registro de intentos | La URL del cargador puede ser una capacidad de acceso a su documento |
| La IPv4 mapeada se rechaza a mano, no con una regla de `BlockList` | En Node la regla `::ffff:0:0/96` casa con **todas** las IPv4 y bloqueaba cualquier descarga; lo detectó la prueba |
| Fastify elimina (no rechaza) los campos no previstos del cuerpo | Seguro frente a asignación masiva; no devuelve 400 |

### Límites conocidos
- La política es de aplicación: `api` conserva salida a Internet a nivel de red.
- Sin cola offline para móviles sin cobertura.
- No se interpreta el contenido del PDF (sin OCR ni extracción de campos).
- Un PDF puede ser un documento cualquiera: `pdf_header_ok` solo significa «parece un PDF completo».

---

## 28. Pruebas en la red local (publicación local)

- **Máquina de trabajo y de despliegue: <IP-DEL-SERVIDOR>** . El portátil (<IP-DEL-PORTÁTIL>) solo monta su disco por sshfs. Docker y las pruebas se ejecutan **solo en la .130**.
- `api` y `docs` publican en la IP local de la .130 (`API_BIND` y `DOCS_BIND` del `.env`), **nunca en `0.0.0.0`**: no se exponen las demás interfaces ni los puentes de Docker.
- `PUBLIC_DOCS_BASE_URL=http://<IP-DEL-SERVIDOR>:18081`: los QR de los DeCA nuevos llevan esa dirección. Los emitidos antes conservan la suya dentro del PDF.
- Sin HTTPS: solo para una red de confianza (T47). La Resolución exige https en el QR real: eso llegará con NPM.
- Verificación: `scripts/lan-test.sh` (no destructiva; 42 comprobaciones) y una petición desde otro dispositivo de la red.
- Visto desde un dispositivo de la LAN, la API recibe la **IP real del cliente** (el bloqueo por fuerza bruta distingue dispositivos). Detrás de NPM habrá que configurarlo (T30).
