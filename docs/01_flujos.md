# Fase 4: Flujos reales

> **Revisión 2 (2026-10-03).** Cambios: v1 = 1 transporte = 1 DeCA (D-04); método 1 como regla normal sin que el usuario elija (D-03); permisos de modificación por campo, no «todo es modificable» (P-13); DeCA externo simplificado, sin extracción de campos (v1); copia del conductor anterior descrita solo como comportamiento técnico; purga local con holgura configurable; nuevo **CASO K** (teléfono nuevo, D-05); la restauración exige prueba real de extremo a extremo.

Notación: **[O]** oficina (admin web), **[C]** conductor (PWA), **[S]** servidor, **[A]** agente de inspección, **[X]** tercero (cargador). Las referencias `Rxx` y `P-xx` apuntan a `REQUISITOS_LEGALES_DECA.md`.

## Conceptos que fijan los flujos

- **Jornada (ruta)** → contiene N **transportes**. Cada transporte es un envío (R05, ORD art. 3).
- **DeCA** → documento lógico con N **versiones** (PDF). **En la v1: 1 transporte = 1 DeCA.** La RES sexto permite agrupar varios envíos en uno solo si cargador contractual y transportista efectivo son los mismos. El modelo de datos queda **preparado**, pero la interfaz de la v1 **no ofrece** esa opción.
- **Conductor y vehículo** son asignaciones con historial, no campos fijos del DeCA (R34).
- Estados de transporte: `PENDIENTE → EN_CURSO → FINALIZADO` (más `CANCELADO` interno).

---

## CASO A: Oficina crea transporte, genera DeCA, asigna conductor; queda offline

```
[O] crea Transporte (cargador, origen/destino, mercancía, fecha...)
[O] "Generar DeCA"
[S] valida campos art. 6 ORD (a..h), avisa de los que falten
[S] crea deca + versión 1:
      - token aleatorio (≥128 bits) → URL https://<dominio-docs>/d/<token>
      - PDF nativo con QR incrustado, CreationDate/ModDate
      - guarda PDF en almacén, SHA-256, tamaño (≤5 MB)
      - audit_log: DECA_CREATED
[O] asigna conductor + tractora + semirremolque → audit_log
[S] encola Web Push al conductor "Nuevo transporte"
[C] PWA recibe push / refresca lista
[C] PWA descarga PDF y lo guarda en almacenamiento local (Cache Storage + IndexedDB)
[C] comprueba hash → marca "DeCA disponible sin conexión" (versión, fecha de descarga)
[S] registra ACK de descarga (device_id, versión, hora)  → la oficina ve "conductor tiene la v1"
```
Reglas: la creación del PDF es **anterior al inicio efectivo** (R38). La oficina ve si el conductor confirmó recepción (RES quinto y séptimo: «hacer llegar» la copia).

## CASO B: Conductor muestra QR y agente accede al documento

```
[A] solicita el DeCA en carretera
[C] abre transporte → MOSTRAR QR (pantalla completa, brillo máximo, QR grande)
[A] escanea → GET https://<dominio-docs>/d/<token>
[S-docs] valida token → responde 200 application/pdf (descarga directa, sin login ni botones)
[S-docs] registra acceso mínimo (hora, doc_id, resultado). Sin datos personales extra
```
El servicio documental es independiente de la API privada (R25, R26).

## CASO C: Conductor sin cobertura abre copia local

```
[C] sin red → PWA arranca desde service worker
[C] VER DeCA → muestra PDF local (versión N, descargado el <fecha>)
[C] MOSTRAR QR → QR generado en local a partir de la URL guardada
[A] escanea con SU dispositivo → necesita cobertura del agente (fuera de nuestro control)
```
- Indicador permanente: «Sin conexión · versión N · última sincronización hh:mm».
- **P-01:** jurídicamente no está determinado que la copia local baste (R27, R28). La PWA no afirma «verificado» offline.
- Si hay una versión más reciente en servidor que el móvil no ha podido descargar, al recuperar red se actualiza y el aviso se mantiene hasta confirmar.

## CASO D: Cambio de tractora durante el transporte

```
(Opcional, no incluido en el primer bloque: el conductor puede «Solicitar cambio de vehículo» comunicando vehículo anterior, nuevo, motivo y hora declarada; la solicitud no modifica el DeCA por sí misma, lo hace después el mecanismo autorizado de oficina/servidor.)
[O] "Cambiar vehículo": tractora A → B, hora real, motivo
[S] transacción:
      - cierra asignación A (hasta=hora), abre asignación B
      - crea deca_version N+1
          método 1 (regla normal, sin preguntar al usuario): MISMO QR/URL, nueva versión del PDF;
             muestra B vigente y A como "ya no válida" + motivo + hora; versiones anteriores conservadas
          método 2: solo respaldo automático (límite de 5 MB) o reemisión avanzada de administrador
      - audit_log: VEHICLE_CHANGED {anterior, nuevo, hora, usuario, motivo}
[S] push al conductor "DeCA actualizado" (obligatorio hacerle llegar el PDF, RES quinto)
[C] descarga PDF nuevo y confirma ACK
```
Base legal: ORD art. 6.g (el cambio de vehículo debe constar por la empresa de transportes); RES quinto (R33). Es el caso de modificación con base legal expresa. Aviso en pantalla si el conductor no ha confirmado recibir la nueva versión.

## CASO E: Cambio de conductor durante el transporte

```
[O] "Cambiar conductor": A → B, hora, motivo
[S] cierra asignación de A, abre la de B → audit_log DRIVER_CHANGED
[S] NO genera versión del DeCA (el conductor no es dato del art. 6; R34)
[S] push a B: "Transporte asignado"; la PWA de B descarga el DeCA vigente
[S] la PWA de A pierde el transporte en su próxima sincronización
```
Comportamiento técnico del conductor anterior (A):
- puede conservar temporalmente una copia local del PDF;
- al sincronizar, el transporte deja de estar asignado a A;
- la aplicación purga esa copia posteriormente según la política de purga local (Caso I).

No se hace ninguna afirmación sobre el valor jurídico de la copia que conserve A.

## CASO F: Conductor A inicia, conductor B continúa y entrega

Es el CASO E más:
```
[B] abre el transporte (copia offline ya descargada)
[B] FINALIZAR TRANSPORTE → [S] estado FINALIZADO, hora servidor, driver_id = B
[S] el historial conserva: A (desde-hasta), B (desde-hasta)
```
Una jornada puede tener transportes con conductores distintos. El historial por asignación lo permite.

## CASO G: Carga nocturna, DeCA externo del cargador (implementado)

```
[C] 03:00, oficina cerrada. El cargador genera su DeCA y da un QR / enlace. El conductor puede estar en un teléfono nuevo (PENDIENTE)
[C] «Añadir DeCA externo»: escanea el QR (la aplicación obtiene la URL) o la pega
[C→S] POST /api/v1/driver/external-deca {transport_id, url}
[S] solo sobre transportes PROPIOS en PENDIENTE/EN_CURSO y visibles para ese dispositivo; máx. 5 documentos por transporte
[S] URL: https, sin credenciales, puerto 443, host con nombre. Si no → 400 url_no_valida (sin red y sin gastar cuota)
[S] CUOTA por usuario: 5 intentos/hora y 15/día (cuentan también los fallidos). Si se supera → 429 con Retry-After
[S] DESCARGA ANTI-SSRF (ver T17): todas las IP resueltas públicas; conexión a la IP validada; ≤3 redirecciones revalidadas;
    TLS≥1.2; sin compresión; 15 s; ≤5 MB; debe parecer un PDF completo (%PDF-… y %%EOF)
[S] guarda el PDF por hash (SHA-256), conserva la URL de origen y el estado del dispositivo; auditoría EXTERNAL_DECA_ADDED
[S] respuesta: id, sha256, review_status = PENDIENTE_DE_REVISION, validated = false y el aviso «no se ha comprobado que sea un DeCA válido»
[C] puede abrir su copia; [O] la ve en /api/v1/external-decas, la descarga y la marca REVISADO (solo «mirado», nunca «válido»)
Errores: 422 external_fetch_failed con razón gruesa (url_no_valida / no_se_pudo_descargar / no_es_pdf / demasiado_grande), 503 busy
```
- **No** se afirma «DeCA válido» y **no** se asume que sustituya las obligaciones del transportista (P-02, P-04, P-12). No hay OCR ni extracción de campos.
- El documento externo vive en su propia tabla: **no** crea ni modifica ningún DeCA propio.
- Si el móvil no tiene cobertura en la nave de carga no hay cola offline todavía: la petición falla y se repite al recuperar red (limitación conocida).

---

## CASO H: Oficina modifica un dato

```
[O] edita un campo (peso, mercancía, destino...) en un DeCA ya emitido
[S] comprueba la POLÍTICA DE MODIFICACIÓN (campo × responsable del dato × momento × rol):
      si no está permitido → se rechaza y se explica por qué (aunque técnicamente se pudiera versionar)
[S] si está permitido, la UI avisa: "este DeCA ya fue emitido; el cambio genera una nueva versión" + pide motivo
[S] en una transacción:
      - guarda deca_version N+1 con diff {campo, valor anterior, valor nuevo}
      - audit_log (quién, cuándo, anterior, nuevo, motivo)
      - genera el PDF con el método 1 (regla normal): mismo token/QR/URL, datos nuevos + motivo
        + datos antiguos marcados "NO VÁLIDOS"; las versiones anteriores se conservan internamente
        (método 2 solo como respaldo automático o acción avanzada de administrador)
[S] ModDate del PDF, hash nuevo
[S] push: "DeCA actualizado" a los conductores asignados
[C] descarga y confirma ACK; hasta entonces la PWA indica "versión nueva pendiente de descarga"
```
Antes de **generar** el DeCA, los datos son un borrador editable. Desde que el DeCA está emitido, todo cambio permitido es una modificación versionada (R15). Una vez FINALIZADO el transporte, la v1 **no permite** modificarlo (P-13).

## CASO I: Conductor finaliza el transporte

```
[C] FINALIZAR TRANSPORTE (confirmación en dos toques)
[C] si no hay red: se registra localmente con hora del dispositivo y se envía al recuperar conexión
[S] estado FINALIZADO, finished_at = hora servidor (conserva también hora declarada por el dispositivo)
[S] audit_log; push/stream a la oficina
[C] PURGA LOCAL con holgura: el PDF NO se borra al pulsar el botón. Se purga cuando pasen
    N horas desde que el SERVIDOR confirmó la finalización (propuesta por defecto: 24 h, configurable),
    siempre que no haya acciones pendientes de sincronizar. Motivos: pulsación accidental, comprobación
    posterior, pérdida momentánea de conexión, sincronización pendiente. Las 24 h se cuentan desde el `finished_at` confirmado por el SERVIDOR, no desde la hora del teléfono. No se purga si la finalización está pendiente de sincronizar, si hay una acción crítica pendiente, si hay un estado inconsistente o si falta confirmación del servidor. La purga afecta SOLO a la copia local: nunca borra el PDF del servidor
[S] el siguiente transporte de la jornada pasa a EN_CURSO (si hay uno PENDIENTE siguiente)
[S] fija dos plazos **independientes**: (1) la URL pública puede desactivarse a los 7 días naturales (D-07); (2) los documentos se conservan al menos un año de calendario (`retain_not_before`, R12) y **no se eliminan** al desactivar la URL
```
«Finalizar» **no** es prueba de entrega (requisito del propietario). Se etiqueta en la UI y en la base de datos como `FINALIZADO` por el conductor, no `ENTREGADO`.

## CASO J: El servidor falla por completo

```
1. Preparar equipo nuevo con Linux + Docker + Compose
2. Obtener el paquete de la plataforma (misma versión o superior) y la copia de seguridad
3. Recuperar los SECRETOS (clave del repositorio de backup, .env) del lugar de custodia independiente
4. ./deca restore --from <repositorio> [--snapshot <id>]
      - restaura volúmenes (documentos + dump PostgreSQL + configuración)
      - levanta servicios y ejecuta migraciones
5. ./deca verify: comprueba hashes de todos los PDFs contra la BD, cuenta registros, prueba una URL de DeCA
6. Reconectar la publicación externa (Nginx Proxy Manager, infraestructura externa futura; en las pruebas locales basta la URL local)
7. Las PWA siguen funcionando: misma URL, mismas identidades; los dispositivos autorizados se conservan
```
**Un backup no se considera validado porque el proceso de copia termine sin errores.** Antes de dar el sistema por terminado se hace una **prueba de aceptación en entorno limpio**:

```
SERVIDOR VACÍO → RESTAURAR BACKUP → LEVANTAR DOCKER COMPOSE → VERIFICAR BASE DE DATOS
→ VERIFICAR HASHES DE DOCUMENTOS → VERIFICAR LOGIN → VERIFICAR PWA
→ VERIFICAR UN QR/URL REAL DE PRUEBA (GET público sin credenciales que devuelve el PDF)
```
Detalle en `docs/03_arquitectura_y_diseno.md` §17 y §18.

## CASO K: Teléfono nuevo a las 03:00, oficina cerrada (D-05)

```
[C] el teléfono se ha roto o perdido; el conductor entra en uno nuevo con usuario y contraseña
[S] credenciales correctas + device_id desconocido:
      - si el usuario ya tiene 3 dispositivos PENDIENTES → NO se crea un cuarto; se informa al
        usuario; los anteriores quedan intactos (los REVOCADOS no cuentan)
      - si no → registra el dispositivo como PENDIENTE_DE_CONFIRMACION
[S] concede una sesión provisional de ALCANCE LIMITADO, de máximo 72 h
[C] puede: ver SUS transportes ya asignados (los anteriores al registro del teléfono), abrir el DeCA vigente, mostrar el QR
          y AÑADIR DeCA EXTERNO a un transporte suyo (con cuota y descargador anti-SSRF; Caso G)
[C] NO puede: FINALIZAR transportes (deshabilitado hasta nueva orden; análisis en docs/02_amenazas.md «3 bis»),
              confirmar recepción ni suscribirse a avisos (no implementados); nada administrativo; nada de otros
              conductores; modificar datos legales; auditoría; configuración
[C] opcional: si el conductor dispone de su PIN de alta, puede introducirlo para ELEVAR AL INSTANTE la
              confianza del dispositivo a AUTORIZADO. El PIN NO es necesario para el acceso documental
[S] audit_log DEVICE_REGISTERED_PENDING; panel de oficina: "NUEVO DISPOSITIVO PENDIENTE"
[O] AUTORIZAR → confianza plena; REVOCAR → invalida sesiones y refresh tokens, borra suscripciones push
[S] a las 72 h la sesión limitada caduca: hay que autenticarse de nuevo. La caducidad NO elimina
    transportes, NO modifica DeCA, NO borra datos del servidor y NO altera asignaciones
```
El conductor nunca queda bloqueado por no poder contactar con la oficina ni por no recordar un PIN. Un dispositivo revocado que siga totalmente desconectado puede conservar temporalmente la información ya guardada en local (riesgo residual documentado en T07).

## CASO L: Oficina y segundo factor TOTP

```
ALTA (primera vez)
[O] activa su cuenta con la credencial temporal → sesión con alcance MFA_PENDING (solo puede configurar el TOTP)
[O] POST /auth/totp/setup → secreto + URI otpauth + QR; lo escanea con su aplicación autenticadora
[O] POST /auth/totp/enable {código} → TOTP activo; la MISMA sesión pasa a FULL

INICIO DE SESIÓN
[O] contraseña + código TOTP en la misma petición
[S] contraseña correcta, TOTP activo, sin código → 401 totp_required (no se crea sesión ni dispositivo)
[S] código erróneo, repetido (mismo paso) o de otro usuario → 401 invalid_totp (cuenta para el bloqueo por fuerza bruta)
[S] código correcto y no usado → sesión FULL

AUTENTICADOR PERDIDO
[A] un admin: POST /users/:id/totp/reset  (o ./deca reset-totp --username u en el servidor)
[S] borra el secreto, revoca las sesiones del usuario y audita TOTP_RESET; el usuario vuelve a hacer el ALTA
RESTABLECIMIENTO DE CONTRASEÑA con TOTP activo
[S] la credencial de activación reemitida exige además el código TOTP vigente; sin él no se consume
```

---

## Matriz de flujos × requisitos

| Caso | Requisitos legales clave | Pendientes |
|---|---|---|
| A | R17, R21 a R24, R38, RES séptimo | P-03 |
| B | R24 a R26 | |
| C | R27, R28 | **P-01** |
| D | R15, R33 | P-06 |
| E/F | R34, R35 | P-05 |
| G | R29 a R32, R11 | **P-02**, P-04, P-12 |
| H | R14, R15, R37, R39 | P-13 |
| I | (no legal; L9/25 no regula el fin del servicio) | |
| J | R11, R12 | |
| K | (decisión D-05, amenazas T28 y T31) | |
| L | (amenazas T38, T42 a T46) | |
