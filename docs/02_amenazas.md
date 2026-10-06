<img src="../imagenes/decargo.png" alt="DECARGO" width="220">

# DECARGO · Fase 5: Modelo de amenazas y seguridad

> **Revisión 3 (2026-10-03).** Cloudflare queda descartado: se eliminan las amenazas y decisiones que existían solo por él. **Nginx Proxy Manager (NPM) es infraestructura externa futura**, sin integración ni configuración ahora. Se documenta la decisión sobre las operaciones de estado de un dispositivo pendiente (T31) y la revisión de D-05 (T28).

## 1. Activos

| Activo | Por qué importa |
|---|---|
| PDFs de DeCA y su historial | Documentación obligatoria. Su alteración es infracción muy grave (LOTT 140.9) |
| Base de datos (usuarios, transportes, auditoría) | Datos personales y mercantiles |
| Credenciales y sesiones | Acceso a modificación de documentos |
| Secretos del sistema (`.env`, claves de backup, clave VAPID) | Su pérdida impide restaurar o notificar |
| Disponibilidad del servicio documental | Un agente debe poder descargar el PDF en carretera (R26) |

## 2. Fronteras de confianza

```
Internet (futuro) ──► [Nginx Proxy Manager: infraestructura EXTERNA] ──┬─► docs (PÚBLICO, solo lectura, sin sesión)   ← QR / agentes
                                   ├─► api  (PRIVADA, sesiones, escritura)        ← oficina / conductores
                                   └─► web  (estáticos)
api ──► postgres (red interna)      docs ──► postgres (rol SOLO LECTURA, vista mínima) + volumen docs (read-only)
```
Dos listeners distintos, dos roles de BD distintos, dos hostnames. Comprometer `docs` no da escritura ni acceso a otras tablas.

**Publicación (D-08):** hoy **no hay publicación a Internet**: solo acceso local. Cuando se publique se usará Nginx Proxy Manager, **infraestructura externa** que no forma parte del Compose de DECARGO. DECARGO solo expone internamente `docs` y `api`/`web`. No se presupone cómo está configurada la red.

## 3. Amenazas y contramedidas

| # | Amenaza | Contramedida | Estado |
|---|---|---|---|
| T01 | **Robo de credenciales** | Contraseñas con argon2id. Longitud mínima. Lista de contraseñas comunes. TOTP **obligatorio** para usuarios de oficina y administradores (el panel será accesible desde Internet cuando se publique). Para conductores, ver T28. Aviso de nuevos inicios de sesión | Diseño |
| T02 | **Fuerza bruta** | Límite por cuenta y por IP con retardo creciente. Bloqueo temporal. Mensajes de error genéricos. Registro en auditoría | Diseño |
| T03 | **Enumeración de DeCA** | Token aleatorio criptográfico ≥128 bits (se propone 256) en base64url. Sin IDs secuenciales. 404 uniforme (mismo cuerpo y tiempo) para token inexistente, desactivado o malformado. Rate limit por IP con umbral alto (R25) | Diseño |
| T04 | **Manipulación de URLs** | La URL solo resuelve un token. No acepta parámetros que cambien de documento. Sin `../`. Almacén direccionado por ID interno, nunca por ruta recibida | Diseño |
| T05 | **Acceso no autorizado a otros documentos** | `docs` solo expone `GET /d/<token>`. No hay listados, índices ni búsqueda. Rol de BD sin acceso a otras tablas | Diseño |
| T06 | **Robo de sesión** | Cookie `HttpOnly; Secure; SameSite=Strict`. Access token corto, refresh rotatorio con detección de reutilización. Revocación de sesiones desde admin. Sesión ligada a `device_id` y a su alcance (completo o limitado, D-05) | Diseño |
| T07 | **Dispositivo perdido o robado** | Revocar dispositivo/sesión en un clic (invalida sesiones y borra la suscripción push). La copia offline del PDF es un riesgo de **confidencialidad** y se acota: caché solo de transportes asignados; se purga **con una holgura configurable tras la finalización confirmada por el servidor** (propuesta: 24 h), al cerrar sesión (con aviso si hay acciones pendientes) y al contactar con el servidor tras una revocación. Un dispositivo revocado que no vuelva a conectar conserva sus datos locales hasta entonces (límite documentado). No se guardan credenciales en claro | Diseño |
| T08 | **Empleado que se va / usuario no desactivado** | Desactivar usuario ⇒ invalida todas sus sesiones, rechaza refresh y revoca tokens push. Informe de usuarios sin actividad >N días. Revisión periódica de altas | Diseño |
| T09 | **Modificación indebida de documentos** | Versiones inmutables. Hash SHA-256 por versión. Cadena de auditoría con hash encadenado (`prev_hash`). **Política de modificación** por campo, responsable del dato, momento y rol (P-13): el servidor rechaza lo no permitido aunque sea técnicamente versionable. Por **decisión de diseño** el conductor no edita datos legales (no es una prohibición jurídica). Verificación periódica de integridad (comando `verify`) | Diseño |
| T10 | **Pérdida del servidor** | Backups versionados independientes (§backup). Restauración documentada y probada | Diseño |
| T11 | **Ransomware** | RAID no es backup. Repositorio de backup **append-only o con copia fuera de línea/remota** (el ransomware cifra lo que ve montado). Retención versionada. Credenciales del backup fuera del servidor | Diseño |
| T12 | **Exposición accidental de backups** | Cifrado de cliente (restic, AES-256) antes de salir del servidor. Bucket privado. La clave no se guarda junto al backup | Diseño |
| T13 | **Inyección SQL** | Consultas parametrizadas / ORM. Rol de BD mínimo. Sin SQL dinámico con entrada de usuario | Diseño |
| T14 | **XSS** | Frameworks con escape por defecto. CSP estricta (`default-src 'self'`, sin `unsafe-inline`). Sin `innerHTML` con datos de usuario. Los PDFs se sirven con `X-Content-Type-Options: nosniff` y `Content-Disposition`. Los datos que se imprimen en el PDF no se interpretan como marcado | Diseño |
| T15 | **CSRF** | Cookies `SameSite=Strict`. Comprobación de `Origin`. Token anti-CSRF en operaciones sensibles. API solo JSON | Diseño |
| T16 | **Escalada de privilegios** | RBAC en servidor (nunca en el cliente). Roles: `admin`, `oficina`, `conductor`, `solo_lectura`. Autorización por empresa y por recurso. Tests de IDOR. Un conductor solo ve transportes que tiene asignados | Diseño |
| T17 | **SSRF en «Añadir DeCA externo»** | **Implementado y probado** (59 comprobaciones, `scripts/ssrf-test.sh`). Solo https, sin credenciales, puerto 443, host con nombre (sin IP literal en ninguna forma, sin hosts locales ni de una etiqueta). **Todas** las direcciones resueltas deben ser públicas (privadas, loopback, enlace local, metadatos de nube, CGNAT, reservadas, multicast, IPv4 mapeada, NAT64, 6to4 y Teredo bloqueadas; respuesta DNS mixta rechazada). Anti-rebinding: se conecta a la IP ya validada, una sola resolución por salto, certificado validado contra el nombre. Máx. 3 redirecciones, cada una revalidada desde cero y nunca a http. TLS ≥1.2 con verificación obligatoria. Sin compresión, sin cookies ni credenciales. 15 s en total y 5 s de inactividad. 5 MB, también sin Content-Length. Concurrencia 2 (sin cola). Respuesta al conductor con categorías gruesas (no revela si el destino era interno). **Residual:** la política vive en la aplicación; `api` conserva salida a Internet a nivel de red (no se ha restringido por firewall) | Implementado |
| T18 | **PDF malicioso (DeCA externo)** | Se comprueba `%PDF-x.y` al inicio y `%%EOF` al final (descarga completa), tamaño mínimo y ≤5 MB; **no se interpreta el contenido** (sin OCR ni extracción). Se guarda por hash y se sirve siempre con `application/pdf` y `no-store`, nunca como HTML. Lo abre la oficina con el visor del navegador: **residual** si el visor tuviera una vulnerabilidad. No se ejecuta nada en el servidor | Implementado, residual bajo |
| T19 | **QR falso o phishing** (un QR que dirige a otra web) | La PWA muestra el **dominio** de la URL escaneada antes de adjuntar y exige confirmación. Avisa si no es `https` | Diseño |
| T20 | **Fuga por enlace** (el token se reenvía o se comparte) | El token es capacidad: quien lo tiene descarga el PDF. Es **inherente** al requisito legal (R25). Mitigaciones: desactivación configurable tras el servicio (R23.5), registro de accesos, revocación y regeneración de token en método 2 | **Riesgo aceptado, documentado** |
| T21 | **Datos personales en el PDF público** | El PDF **no** incluye datos del conductor (R34). Solo datos del art. 6. El cargador y el transportista ya son personas jurídicas habitualmente, pero pueden ser autónomos: aviso | Diseño |
| T22 | **Denegación de servicio sobre `docs`** | Rate limit, límites de conexión y caché de PDF en memoria. El servicio es de solo lectura y ligero. Si cae la API privada, `docs` sigue sirviendo | Diseño |
| T23 | **Manipulación del reloj** (fecha/hora de creación) | Hora del servidor (UTC) con NTP. Alerta de deriva en el panel de salud. La hora de dispositivos se guarda solo como dato declarado | Diseño |
| T24 | **Cadena de suministro** (dependencias, imágenes) | Imágenes con versión fijada (sin `latest`). `npm ci`/lockfile. Escaneo con `trivy`/`npm audit` en el CI. Imágenes mínimas y usuario no root | Diseño |
| T25 | **Fuga de secretos** | `.env` con permisos 600, nunca en git. Secretos de Docker. Rotación documentada | Diseño |
| T26 | **Exposición de la API privada a Internet (futura)** | Hoy solo acceso local. Cuando se publique, los conductores necesitarán alcanzar la API desde fuera: autenticación, TOTP de oficina, límite de tasa y alcance limitado. El hostname documental será siempre público (R26). Una **VPN** podría restringir funciones administrativas, pero **no puede sustituir** el acceso público que necesita un agente para el QR | Decisión pendiente (publicación) |
| T27 | **Insider con acceso al servidor** | Acceso por SSH con clave. Auditoría de operaciones. Aviso: quien administra el host puede ver los PDFs. Cifrado de disco recomendado | Documentado |
| T28 | **Credenciales robadas usadas en un teléfono nuevo** (D-05) | **Implementado y probado.** El dispositivo nuevo queda `PENDIENTE_DE_CONFIRMACION` con sesión provisional de alcance limitado (72 h) aplicado **en el servidor**: solo conductor, solo lectura, solo los transportes que ya tenía asignados antes de registrarse el dispositivo, sin funciones administrativas ni datos de otros. Máximo 3 pendientes por usuario (el 4.º no se crea; los REVOCADOS no cuentan; sin condición de carrera). Alerta a la oficina (listado de pendientes). Auditoría. **Riesgo residual:** quien tenga las credenciales verá los DeCA ya asignados a ese conductor hasta que la oficina revoque. El PIN de alta es opcional y no está implementado | Implementado |
| T29 | **Proxy externo futuro (NPM) que rompa el acceso directo o el TLS** | Requisito para la fase de publicación, no se implementa ahora: la ruta documental no puede pasar por login, CAPTCHA, página intermedia, botón, *challenge* anti-bot ni redirecciones innecesarias, y debe cumplirse TLS ≥1.2 (R23, R25). Se verificará con `curl` y desde un dispositivo externo | Pendiente de la fase de publicación |
| T30 | **IP de cliente falsificada mediante cabeceras de proxy** | Cuando exista un proxy delante, solo se confiará en sus cabeceras si la conexión viene de una dirección configurada explícitamente. Sin proxy configurado se usa la IP de conexión. Afecta a los límites de tasa y a la IP truncada de los logs. No se implementa hasta la publicación | Diseño |
| T33 | **Robo de sesión por refresh token** (bloque 2) | Refresh rotatorio: cada uso entrega uno nuevo. Si se presenta uno **ya usado**, se revoca TODA la familia (sesión) y se audita `SESSION_REUSE_DETECTED`. Solo se guarda el hash SHA-256. Probado. Coste: un reintento legítimo tras perder la respuesta de red revoca la sesión y obliga a volver a iniciar sesión | Implementado |
| T34 | **Fuerza bruta y enumeración de usuarios** (bloque 2) | Argon2id; bloqueo progresivo por (usuario, IP), por usuario y por IP, también para usuarios inexistentes; misma respuesta y mismo coste (hash ficticio) para usuario inexistente, desactivado o contraseña errónea. Límite de peticiones en `/auth/*`. Acotado el bloqueo hostil: el contador por usuario solo bloquea tras 20 fallos | Implementado. Residual: ver T30 (la IP de cliente aún no es fiable) |
| T35 | **Suplantación de un dispositivo autorizado** (bloque 2) | El dispositivo se identifica con un id **y un secreto de 256 bits** generados por el servidor (solo se guarda su hash). Conocer el id no basta. Unas credenciales robadas desde otro teléfono no heredan la confianza de ningún dispositivo | Implementado |
| T36 | **Autoescalada de privilegios** (bloque 2) | Autorizar/revocar exige rol oficina o admin con dispositivo AUTORIZADO; **nadie autoriza su propio dispositivo**; la oficina solo gestiona conductores; el rol y el alcance se leen de la base de datos en cada petición. `deca_api` no puede cambiar roles ni reasignar dispositivos (permisos por columna). Probado | Implementado |
| T37 | **Credencial temporal de activación interceptada o adivinada** (bloque 2) | 80 bits de entropía, un solo uso, caducidad 72 h (provisional), 5 intentos, solo hash Argon2id, una nueva anula la anterior, una contraseña débil no la consume. Se muestra una sola vez (CLI o respuesta de la API) | Implementado |
| T38 | **Usuarios de oficina sin segundo factor** | **Implementado y probado** (TOTP RFC 6238). `admin`, `oficina` y `solo_lectura` deben superar un código TOTP: si ya lo tienen configurado, el login lo exige **antes** de crear sesión o dispositivo; si no, la sesión nace en `MFA_PENDING` y solo permite configurarlo. Cada código vale una sola vez; ±1 paso de 30 s; los fallos entran en el bloqueo por fuerza bruta; la credencial de activación reemitida tampoco salta el segundo factor. Los conductores no lo usan (D-05) | Implementado. Riesgos nuevos: T42 a T46 |
| T39 | **Sesiones tras una restauración** (bloque 2) | Se **invalidan todas** al restaurar (los dispositivos conservan su confianza). Evita que un estado antiguo acepte tokens rotados después del backup | Implementado |
| T40 | **Crecimiento de sesiones, refresh y contadores** (bloque 2) | No se borran filas (`deca_api` sin DELETE, por diseño). Sin purga de caducados todavía | Residual bajo |
| T41 | **Tokens en el navegador** (bloque 2) | Los tokens van en JSON (cabecera `Authorization`), por lo que no hay CSRF. Dónde los guarda cada cliente (PWA y web) es una decisión del bloque de pantallas: un XSS podría robarlos. Pendiente | Pendiente |
| T42 | **Alta del TOTP con solo la contraseña (TOFU)** | Una cuenta de oficina aún sin TOTP deja configurarlo a quien presente su contraseña: si un atacante la tiene antes que el titular, podría enrolar SU autenticador. Mitigaciones: el alta se hace justo tras activar la cuenta; el listado de usuarios muestra `totp_enabled` para detectar cuentas sin configurar; un admin puede reiniciarlo; con el TOTP activo el alta no se puede repetir. **Riesgo residual bajo-medio, acotado en el tiempo** | Residual |
| T43 | **Secreto TOTP robado de la base de datos** | El secreto debe ser reversible (hace falta para validar), por lo que se guarda **cifrado con AES-256-GCM y una clave derivada de `APP_KEY`**. Quien obtenga la base de datos **y** `APP_KEY` (ambas viajan en el backup, que a su vez va cifrado con `RESTIC_PASSWORD`) podría generar códigos. Proteger `.env`, `RESTIC_PASSWORD` y los backups | Residual medio |
| T44 | **Pérdida del autenticador** | Sin códigos de recuperación (no solicitados). Salida: un admin reinicia el TOTP de otro usuario; si se pierde el del **único** administrador, `./deca reset-totp` en el servidor (requiere acceso al equipo). El reinicio revoca las sesiones y se audita. Nadie reinicia el suyo propio | Aceptado |
| T45 | **Phishing en tiempo real** | TOTP no es resistente al phishing: un atacante que retransmita en el momento contraseña y código obtendría una sesión. Límite conocido del estándar | Residual |
| T46 | **Desajuste de reloj del servidor** | La validez depende de la hora del servidor (±30 s). Hace falta NTP. Aún no hay alerta de deriva en un panel de salud | Pendiente |
| T47 | **Publicación en la red local sin cifrar** (pruebas) | `api` y `docs` publican en la IP local de la máquina (<IP-DEL-SERVIDOR>), nunca en `0.0.0.0`: no se exponen otras interfaces ni los puentes de Docker (comprobado, `scripts/lan-test.sh`). **Sin HTTPS**: contraseñas, códigos de activación, tokens y códigos TOTP viajan en claro por esa red; cualquiera en ella puede leerlos. Solo para pruebas en una red de confianza. `DEV_ENDPOINTS=1` deja activo `/api/v1/dev/test-deca` (protegido por una clave aleatoria). El QR de pruebas usa `http` y **no cumple** la Resolución (https) | Aceptado para pruebas |
| T48 | **Dos máquinas operando sobre el mismo directorio** (operativa) | El portátil monta por sshfs el disco de la .130. El `.env` es único y compartido, así que ejecutar Docker o las pruebas en el portátil contra ese directorio cambia secretos y direcciones de la pila de la .130 (ocurrió y desalineó la contraseña de PostgreSQL). **Regla: Docker y las pruebas se ejecutan SOLO en la .130**; las pruebas destructivas, nunca contra una pila con datos | Procedimiento |
| T31 | **Operaciones que modifican estado desde un dispositivo pendiente** (D-05) | **Decisión del propietario: AÑADIR DeCA EXTERNO está HABILITADO también para el dispositivo pendiente**, con las mitigaciones de «3 bis» D implementadas: cuota por usuario (5/hora y 15/día, contando también los intentos fallidos), solo transportes PROPIOS en PENDIENTE o EN_CURSO y visibles para ese dispositivo, máx. 5 documentos por transporte, descargador anti-SSRF (T17), estado siempre `PENDIENTE_DE_REVISION`, nunca sustituye al DeCA propio (tabla aparte), auditoría con el estado del dispositivo, y `validated=false` siempre. **FINALIZAR TRANSPORTE sigue DESHABILITADO** (no existe el endpoint) a la espera de decisión | Externo habilitado; FINALIZAR pendiente |

## 3 bis. Análisis pendiente de decisión: FINALIZAR TRANSPORTE y AÑADIR DeCA EXTERNO desde un dispositivo pendiente

**Estado actual:** **AÑADIR DeCA EXTERNO está habilitado** para el dispositivo pendiente (decisión del propietario), con las mitigaciones de D implementadas y probadas. **FINALIZAR TRANSPORTE sigue deshabilitado** y pendiente de decisión. El análisis que sigue se conserva tal como se hizo antes de habilitar.

### A) Riesgo de permitir FINALIZAR TRANSPORTE desde un dispositivo pendiente
Quien tenga las credenciales del conductor podría marcar como finalizado un transporte que sigue en marcha. Consecuencias:
1. **Congela las correcciones.** La política provisional bloquea modificar un transporte FINALIZADO (P-13). Un cierre falso impediría a la oficina registrar, por ejemplo, un cambio de vehículo durante el trayecto (ORD 6.g).
2. **Arranca los relojes.** Inicia el plazo de 7 días para desactivar la URL pública del QR y el plazo de purga local de 24 h en el teléfono legítimo: el conductor perdería su copia local antes de tiempo (P-01).
3. **Oculta el transporte.** La lista del conductor solo muestra transportes pendientes o en curso: el legítimo dejaría de verlo.
4. **Falsea el registro operativo.** Fecha y hora de fin, y activación del siguiente transporte.
5. **No es reversible** en esta versión: no existe «reabrir transporte» y no lo he añadido por no ser solicitado.
Finalizar no es prueba de entrega (tu decisión previa), pero sí cambia el estado de los datos legales.

### B) Riesgo de permitir AÑADIR DeCA EXTERNO desde un dispositivo pendiente
La acción hace que **el servidor descargue una URL elegida por quien tiene la sesión**. Consecuencias:
1. **SSRF**: sondeo de la red interna o de servicios del anfitrión a través del servidor. Mitigable con las protecciones de tu punto 15 (solo HTTPS, bloqueo de destinos privados, rebinding, redirecciones, tiempo y tamaño), pero esa pieza aún no existe y habrá que probarla.
2. **El servidor como proxy de salida** hacia URL públicas elegidas por un atacante (se origina desde la IP de la empresa).
3. **Saturación del almacén** (hasta 5 MB por petición).
4. **Contaminación documental**: un PDF falso asociado a un transporte real que el conductor podría llegar a mostrar en una inspección creyéndolo legítimo. Conviene recordar que falsear un documento de control es infracción muy grave (LOTT 140.9).
5. **PDF malicioso** que luego abre el personal de oficina.

### C) Ataques adicionales con credenciales del conductor robadas
- **FINALIZAR:** bucle sobre todos sus transportes asignados (sabotaje masivo), manipulación de horas, borrado indirecto de su copia local, congelación de correcciones, ocultar sus transportes al conductor real.
- **DeCA EXTERNO:** reconocimiento de red interna, abuso de ancho de banda y almacenamiento, colocación previa de documentos falsos para confundir al conductor o a la oficina, y uso del servidor para enviar peticiones a terceros.
- En ambos casos el atacante opera desde un dispositivo que la oficina aún no ha visto, y con una sesión de hasta 72 h.

### D) Mitigaciones sencillas
| Para | Mitigación | Coste |
|---|---|---|
| FINALIZAR | No permitirlo mientras esté pendiente (**situación actual**) | El transporte sigue EN_CURSO hasta que la oficina autorice el dispositivo; el conductor conserva DeCA y QR, sin impacto en el cumplimiento |
| FINALIZAR | Permitirlo marcándolo «desde dispositivo pendiente» y **aplazar** purga local, desactivación de URL y congelación hasta que la oficina lo confirme o autorice el dispositivo | Más lógica; un estado intermedio nuevo |
| FINALIZAR | Convertirlo en una **solicitud** que la oficina confirma (mismo patrón que «solicitar cambio de vehículo») | Una tabla y una pantalla |
| DeCA EXTERNO | Cuota por usuario (p. ej. 5 por hora y 15 al día), solo sobre transportes propios en PENDIENTE o EN_CURSO, 5 MB, comprobación de `%PDF`, estado «pendiente de revisión» siempre, sin sustituir nunca el DeCA propio, marca de auditoría «dispositivo pendiente» | Moderado |
| DeCA EXTERNO | No habilitarlo hasta que el descargador anti-SSRF exista y esté probado | Ninguno ahora |
| Ambas | PIN de alta (opcional) que eleva el dispositivo al instante | Ya diseñado, no implementado |

### E) Propuesta técnica
1. **FINALIZAR:** mantenerlo **deshabilitado** para dispositivos pendientes. Es lo más simple, no tiene impacto en cumplimiento y la oficina suele autorizar el dispositivo a primera hora. Si el negocio exigiera finalizar de madrugada, usar la **solicitud confirmada por oficina**, no el cierre directo.
2. **DeCA EXTERNO:** habilitarlo para pendientes **solo cuando** el descargador anti-SSRF esté implementado y probado, con las cuotas y marcas descritas en D. Hasta entonces, **solo lectura**. Es la operación de mayor valor en el escenario de carga nocturna, pero también la de mayor riesgo técnico.
3. En ambos casos el análisis se repasaría con los resultados de las pruebas SSRF antes de activarlas.

**Decisión pendiente: tuya.**

## 4. Principios aplicados

- **Mínimo privilegio:** roles de BD separados (`deca_api` lectura/escritura, `deca_docs` solo lectura sobre una vista, `deca_backup` solo lectura). Contenedores no root con `read_only: true` cuando es posible, `cap_drop: [ALL]`, `no-new-privileges`.
- **Defensa en profundidad:** el servicio documental es la única superficie obligatoriamente pública.
- **Fallar de forma segura:** cualquier error del servicio documental devuelve 404 genérico (nunca detalles).
- **Minimización:** sin ubicación, contactos, telemetría ni IMEI (ver §Privacidad).

## 5. Requisitos de cabeceras y TLS

- TLS ≥1.2 obligatorio (R23). Se recomienda permitir 1.3. Hoy no hay publicación; cuando exista, el TLS lo terminará NPM y deberá comprobarse allí.
- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` restrictivo (cámara solo en la PWA, para escanear QR).
- `docs`: `Cache-Control: private, no-store` (evita caché compartida de PDFs), sin cabeceras CORS.

## 6. Riesgos residuales aceptados

1. **El token en la URL es una capacidad compartible** (T20). Es el precio de cumplir R24/R25 (acceso sin credenciales).
2. Un administrador del host tiene acceso a los datos (T27).
3. La integridad documental se basa en hashes y auditoría propios, no en sellado cualificado (R47).
4. Un dispositivo **revocado que permanezca totalmente desconectado** conserva temporalmente la información ya guardada en local hasta que contacte con el servidor (D-05, 5.3).
5. Con credenciales robadas, un dispositivo nuevo accede a los DeCA ya asignados a ese conductor hasta que la oficina revoca (T28).
