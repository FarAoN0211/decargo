<img src="imagenes/decargo.png" alt="DECARGO" width="220">

# DECARGO · REQUISITOS LEGALES DeCA

> **Revisión 2 (2026-10-03).** Incorpora las decisiones D-01 a D-12 del propietario y sus correcciones: (1) distinción entre *capacidad técnica de versionar* y *autorización legal para modificar* (R14, nueva P-13); (2) el conductor no edita datos por **decisión de diseño**, no por prohibición jurídica (R09); (3) «al menos un año» ya no se codifica como 365 días (R12); (4) desactivar la URL a los 7 días y conservar al menos un año **no se presentan como contradicción** (R11, P-11); (5) DeCA externo simplificado en la v1, sin extracción automática de campos (R30). Las cuestiones P-01 a P-12 siguen identificadas; se añade P-13.
>
> **Revisión 3 (2026-10-03).** **Cloudflare queda descartado.** Cuando se publique, se usará **Nginx Proxy Manager (NPM)**, que se trata como infraestructura **externa futura** y no se integra ni se configura ahora. Se eliminan las referencias específicas de Cloudflare. P-11 deja de poder cerrarse con entrega manual de la oficina: antes de cerrar la v1 debe definirse un mecanismo sencillo y seguro.

Fecha de consulta de todas las fuentes: **2026-10-03**. Los textos oficiales leídos están copiados en [`fuentes/`](fuentes/) para poder contrastarlos.

> Este documento es una investigación técnica, **no asesoramiento jurídico**. Todo lo marcado **PENDIENTE DE VALIDACIÓN JURÍDICA** debe revisarlo un abogado o la Administración antes de convertirlo en comportamiento definitivo del programa.

## 0. Normas y abreviaturas

| Abrev. | Norma | Enlace oficial |
|---|---|---|
| **ORD** | Orden FOM/2861/2012, de 13 de diciembre, que regula el documento de control administrativo del transporte público de mercancías por carretera (BOE-A-2013-154), modificada por RD 70/2019 (art. 6) y Orden TRM/282/2026 (art. 7) | https://www.boe.es/buscar/act.php?id=BOE-A-2013-154 |
| **RES** | Resolución de 5 de junio de 2026 de la DG de Transporte por Carretera y Ferrocarril: sistemas y características de los DeCA (BOE-A-2026-12784, BOE 12/06/2026). Deja sin efecto la Resolución de 22/05/2023 | https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-12784 |
| **L9/25** | Ley 9/2025, de 3 de diciembre, de Movilidad Sostenible, disposición transitoria octava (BOE-A-2025-24545). Entra en vigor el día siguiente a su publicación (BOE 04/12/2025) | https://www.boe.es/buscar/act.php?id=BOE-A-2025-24545 |
| **RD70** | Real Decreto 70/2019, art. 7: nueva redacción del art. 6 ORD (BOE-A-2019-2289) | https://www.boe.es/buscar/act.php?id=BOE-A-2019-2289 |
| **TRM282** | Orden TRM/282/2026, de 25 de marzo: corrige las referencias del art. 7 ORD (BOE-A-2026-7128, en vigor desde 29/03/2026) | https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-7128 |
| **ROTT** | RD 1211/1990, Reglamento de la LOTT, art. 222 (BOE-A-1990-24442) | https://www.boe.es/buscar/act.php?id=BOE-A-1990-24442 |
| **LOTT** | Ley 16/1987 de Ordenación de los Transportes Terrestres, arts. 140, 141, 143, 147 (BOE-A-1987-17803) | https://www.boe.es/buscar/act.php?id=BOE-A-1987-17803 |
| **FAQ** | Preguntas frecuentes DeCA, Ministerio de Transportes y Movilidad Sostenible (fuente oficial **interpretativa**, no normativa) | https://www.transportes.gob.es/transporte-terrestre/profesionales-transporte/servicios-transportista/documento-electronico-control-administrativo-deca/preguntas-frecuentes-faq-deca |
| **RGPD** | Reglamento (UE) 2016/679 | https://eur-lex.europa.eu/eli/reg/2016/679/oj |
| **LOPDGDD** | Ley Orgánica 3/2018 | https://www.boe.es/buscar/act.php?id=BOE-A-2018-16673 |
| **eIDAS** | Reglamento (UE) 910/2014 | https://eur-lex.europa.eu/eli/reg/2014/910/oj |
| **eFTI** | Reglamento (UE) 2020/1056 | https://eur-lex.europa.eu/eli/reg/2020/1056/oj |

**Alcance de la verificación en esta sesión.** ORD, RES, L9/25 (DT 8ª), RD70, TRM282, ROTT 222, LOTT y FAQ se leyeron en texto oficial íntegro. RGPD, LOPDGDD, eIDAS y eFTI se citan por enlace oficial, pero **no se ha leído su articulado en esta sesión**. Hay que verificarlos antes de implementar (ver R50).

---

## 1. Requisitos (los 50 puntos solicitados)

### R01. Qué norma regula el DeCA
- **Requisito:** documento administrativo de control exigible en el transporte público de mercancías por carretera, formalizado por cada envío.
- **Norma:** ORD arts. 1 y 3; ROTT 222.1; LOTT 147.1.
- **Interpretación:** el DeCA es el documento de control de la ORD, hecho digital por L9/25 y detallado técnicamente por la RES.
- **Consecuencia técnica:** el núcleo de datos es el art. 6 ORD. El formato del archivo lo fija la RES.

### R02. Modificaciones recientes
- **Requisito:** conocer la cadena normativa vigente.
- **Norma:** RD70 (añade la autorización especial de circulación como letra e) y reordena las letras de la a) a la h)); TRM282 (corrige en el art. 7 las letras a las que remite); L9/25 DT 8ª; RES.
- **Interpretación:** el art. 6 vigente tiene las letras **a–h**. Los textos que citan 6.a–6.g o «la letra g) observaciones» son anteriores a RD70.
- **Consecuencia técnica:** el modelo de datos usa la numeración vigente. La responsabilidad se asigna por letra (R08, R09).

### R03. Qué cambia en octubre de 2026
- **Requisito:** el DeCA deja de poder ser papel y pasa a ser digital.
- **Norma:** L9/25 DT 8ª.1: «deberá ser necesariamente digital a los diez meses desde la entrada en vigor de esta ley».
- **Fuente adicional:** FAQ fija la fecha en el **5 de octubre de 2026** y dice que no hay periodo transitorio adicional sin sanción.
- **Interpretación:** cálculo: entrada en vigor 05/12/2025 + 10 meses = 05/10/2026, coherente con la FAQ.
- **Consecuencia técnica:** no hay margen de tolerancia. La plataforma debe emitir DeCA válidos desde el primer día de uso.

### R04. Desde cuándo es obligatorio el formato digital
- **Requisito:** sí es obligatorio, desde el **5/10/2026**.
- **Norma:** L9/25 DT 8ª.1; FAQ.
- **Consecuencia técnica:** la plataforma tiene que cubrir el 100 % del ciclo con documentos nativos digitales, sin fallbacks en papel manuscrito.

### R05. A qué transportes afecta
- **Requisito:** transporte **público** de mercancías por carretera, **interior** (origen y destino en España) y cabotaje.
- **Norma:** ORD art. 1; ROTT 222.1; LOTT art. 65 citado en el preámbulo de la RES.
- **Consecuencia técnica:** el tipo de transporte es un dato del transporte. Si no es interior público, la plataforma avisa («no requiere DeCA») pero no bloquea.

### R06. Excepciones
- **Norma:** ORD art. 2.1 (a: sin título habilitante; b: mudanzas; c: vehículos accidentados o averiados; d: paquetería y servicios similares de pocos bultos manipulables por una persona); ROTT 222.1 (internacionales, que usan los documentos de los convenios); FAQ (el transporte privado complementario no lleva DeCA, pero sí documentación que acredite LOTT 102.2 a, c y d; tampoco es obligatorio el eCMR).
- **Excepción adicional:** RES noveno: si los datos del art. 6 se gestionan y presentan con el esquema eFTI, no hace falta presentar el DeCA en la forma de la RES.
- **Interpretación:** la lista es cerrada y la aplica el operador, no el software.
- **Consecuencia técnica:** campo «categoría de exención» opcional con aviso informativo. No se implementa eFTI (fuera de alcance, ver §5 de `ESTADO_PROYECTO.md`).

### R07. Quién debe generar el DeCA
- **Requisito:** ambos, cargador contractual y transportista efectivo, están **obligados a formalizarlo**. La norma no dice quién lo hace materialmente.
- **Norma:** ORD art. 4; FAQ («no se especifica quién debe realizar materialmente el documento»).
- **Interpretación:** puede generarlo cualquiera de los dos, y también ambos.
- **Consecuencia técnica:** la plataforma debe contemplar dos orígenes: DeCA propio y DeCA externo (ver R29 a R32).

### R08. Obligaciones del cargador contractual
- **Norma:** ORD arts. 4.b, 7.1 y 7.2 (versión TRM282).
- **Contenido:** formalizar el documento. Es responsable de **no formalizarlo** y de que no vaya a bordo, salvo que pruebe que **se emitió**. Responde de la inexactitud o falta de los datos a), b), c) y d) del art. 6 (cargador, transportista, origen/destino, mercancía y peso) y de lo que añada en h).
- **Definición:** «cargador contractual» es quien contrata directamente con el transportista efectivo. Si un transportista A subcontrata a B, A es el cargador contractual de B (FAQ).
- **Consecuencia técnica:** cada campo del DeCA tiene un «responsable del dato» (cargador/transportista) en el modelo. El PDF distingue visualmente ambas figuras (R42).

### R09. Obligaciones del transportista efectivo
- **Norma:** ORD arts. 4.a, 7.1 y 7.3.
- **Contenido:** formalizar el documento y llevarlo a bordo. Responde de los datos e) AEC, f) fecha, g) matrícula y de lo que añada en h). Si cambia el vehículo, **debe hacerlo constar la empresa de transportes** (art. 6.g).
- **Consecuencia técnica:** la ORD atribuye a «la empresa de transportes» el hacer constar el cambio de vehículo, así que la modificación efectiva la registra la oficina/servidor.
- **Aclaración:** que el conductor **no edite directamente** los datos legales del DeCA es una **decisión de diseño** (mínimo privilegio). **No** se documenta como prohibición jurídica general, porque las fuentes leídas no la establecen. En el futuro podrá existir «Solicitar cambio de vehículo» (el conductor comunica vehículo anterior, vehículo nuevo, motivo y hora declarada, y la modificación efectiva y versionada la ejecuta el mecanismo autorizado de oficina/servidor). **No forma parte del primer bloque de implementación.**

### R10. Obligaciones del conductor
- **Norma:** LOTT 147.1 y ROTT 222.1: llevar a bordo el documento. RES séptimo: llevar una copia (electrónica en móvil o en papel) con QR, y presentar «el DeCA con el código QR, o en su defecto, tan sólo el código QR» ante una inspección.
- **Interpretación:** la ORD no atribuye obligaciones de formalización al conductor. Sus datos no forman parte del contenido mínimo para mercancías.
- **Consecuencia técnica:** la PWA debe permitir mostrar el QR de forma aislada (acción **MOSTRAR QR**) y también el documento (**VER DeCA**).

### R11. Quién debe conservar el documento
- **Norma:** ORD art. 9.1; RES segundo.4.
- **Contenido:** conservan el cargador contractual y el transportista efectivo (los «sujetos obligados a documentar»). Pueden tener repositorios independientes. Si lo generó uno de ellos, basta con que el otro pueda **descargarlo** durante un año.
- **Consecuencia técnica:** si la plataforma genera el DeCA, el documento debe poder ponerse a disposición de la contraparte durante al menos un año. **Esto no contradice** la facultad de desactivar la URL pública del QR a los 7 días (R23): son cuestiones distintas (la URL usada durante el servicio, frente a la conservación y disponibilidad posterior). La arquitectura se prepara para un acceso autenticado posterior (D-07), **no implementado en el primer bloque**. **Antes de cerrar la v1 debe definirse y documentarse** un mecanismo sencillo y seguro (P-11), distinto de la URL pública del QR.

### R12. Durante cuánto tiempo
- **Norma:** ORD art. 9.1 («al menos un año»); RES segundo.4 («al menos un año»).
- **Consecuencia técnica:** la fuente dice «**al menos un año**». **No se codifica como 365 días.** Se calcula como **un año de calendario** sobre la fecha de referencia (la fecha se suma con aritmética de calendario, p. ej. 29/02/2028 → 28/02/2029) y el campo resultante es un **«no antes de»** (`retain_not_before`): el sistema nunca borra antes de esa fecha. En la v1 **no existe ninguna purga automática de documentación legal**; cualquier borrado posterior sería una acción manual deliberada y sujeta a RGPD (R50).
- **PENDIENTE DE VALIDACIÓN JURÍDICA (menor, P-08):** desde qué momento se cuenta el año (emisión, fecha del transporte o fin del servicio). Provisionalmente se toma la fecha de finalización del servicio (la más tardía, es decir, la más conservadora).

### R13. Datos obligatorios
- **Norma:** ORD art. 6 (versión RD70); RES primero.1.a.
- **Contenido (mínimos):**
  - a) Cargador contractual: nombre o denominación, NIF y domicilio.
  - b) Transportista efectivo: nombre o denominación y NIF.
  - c) Lugar de origen y de destino del envío.
  - d) Naturaleza y peso de la mercancía (si el peso exacto es de difícil determinación, «otra magnitud para determinar su peso»).
  - e) Autorización especial de circulación, si el vehículo circula amparado por una.
  - f) Fecha de realización del transporte del envío.
  - g) Matrícula del vehículo. En conjunto articulado, tractora y semirremolque o remolque.
  - h) Observaciones, reservas u otras indicaciones **si lo solicitan los sujetos intervinientes**.
- **Consecuencia técnica:** son los campos mínimos y validables del modelo. Todo lo demás (conductor, hora, etc.) es opcional.

### R14. Datos que pueden modificarse durante el transporte
- **Norma:** RES quinto («los datos del DeCA»); ORD art. 6.g (cambio de vehículo).
- **Qué dicen las fuentes:** la RES quinto regula **cómo** se modifica cuando «se requiera la modificación o actualización de los datos» (R15). La ORD 6.g impone que el cambio de vehículo conste por la empresa de transportes. La ORD 7 reparte la **responsabilidad por la exactitud**: cargador contractual (a, b, c, d y las observaciones h que incluya) y transportista efectivo (e, f, g y las h que incluya).
- **Qué NO está demostrado por ninguna fuente leída:** qué datos pueden modificarse, quién está autorizado a modificar cada uno, ni en qué momento del transporte. **No se afirma** que «cualquier campo pueda modificarse».
- **Estado:** **PENDIENTE DE VALIDACIÓN JURÍDICA (P-13).**
- **Consecuencia técnica:** se separan dos cosas. La **capacidad técnica** de versionar cualquier campo existe en el modelo. La **autorización** para modificar se decide con una **política de modificación** por campo que depende del *responsable del dato* (ORD 7), del *momento* (borrador, emitido, en curso, finalizado) y del *rol*. El servidor **rechaza** lo que la política no permite, aunque técnicamente se pudiera hacer. La política provisional está en `docs/03_arquitectura_y_diseno.md` §10 y es una hipótesis de trabajo, no un criterio jurídico.

### R15. Cómo registrar las modificaciones
- **Norma:** RES quinto.
- **Método 1 (modificar el PDF existente):** se añaden los datos nuevos y el motivo del cambio, y se conservan los datos antiguos indicando claramente que ya **no son válidos**. La URL y el QR no cambian.
- **Método 2 (nuevo PDF):** se genera un PDF completo, con nueva URL y nuevo QR, y se conserva el original por trazabilidad.
- **En ambos casos:** se debe **hacer llegar** el PDF modificado o el nuevo al conductor.
- **Interpretación:** ambos métodos son equivalentes legalmente. La elección es de diseño.
- **Consecuencia técnica (D-03):** el sistema soporta los dos, pero **la interfaz no pide elegir**. Regla predecible: las modificaciones usan siempre el **método 1** (mismo QR y URL, nueva versión del PDF, versiones anteriores conservadas internamente, datos anteriores representados como no válidos). El **método 2** queda técnicamente disponible solo como (a) respaldo automático si el PDF del método 1 no pudiera respetar el límite de 5 MB, y (b) acción **avanzada** de administrador («reemitir con nuevo QR»), fuera del flujo normal de edición.

### R16. Trazabilidad
- **Norma:** RES primero.2 (registrar fecha y hora de creación y de modificación); RES quinto (conservar original o datos antiguos); RES segundo.1 (fechas como metadatos del PDF).
- **Consecuencia técnica:** auditoría interna completa (quién, cuándo, valor anterior/nuevo) además del mínimo legal. Ver `docs/03_arquitectura_y_diseno.md` §Versionado.

### R17. Requisitos técnicos del documento electrónico
- **Norma:** ROTT 222.2 (disponibilidad, integridad, inalterabilidad e inviolabilidad; transformable en «signos de escritura legibles»); RES primero y segundo.
- **Contenido:** el software debe contemplar los datos del art. 6, transformarlos en fichero cuando sean conocidos y **siempre antes del inicio efectivo del servicio**, almacenarlos en un repositorio disponible para descarga en carretera, y dar a cada uno una URL única.
- **Consecuencia técnica:** el servicio documental debe ser de alta disponibilidad práctica (ver §Arquitectura). Generación solo desde datos estructurados.

### R18. Formatos admitidos
- **Norma:** RES segundo.1 y segundo.2.
- **Contenido:** PDF, de generación **nativa digital**. No son válidos los escaneos ni las imágenes digitalizadas.
- **Consecuencia técnica:** el PDF se genera con texto real (fuentes embebidas), nunca con capturas de pantalla ni HTML renderizado a imagen.

### R19. ¿Es PDF obligatorio?
- **Norma:** RES segundo.1.
- **Interpretación:** **sí, PDF es el formato obligatorio** del DeCA conforme a la RES. La única vía alternativa es eFTI (RES noveno), que queda fuera del alcance. RES octavo admite otros *formatos de documento* (cartas de porte, CMR, ADR, etc.) en cuanto a campos y disposición, pero el fichero sigue siendo PDF.

### R20. Tamaño máximo
- **Norma:** RES segundo.1: «no superior a 5 MB».
- **Consecuencia técnica:** límite duro conservador de 5 000 000 bytes (la RES no aclara si «MB» es 10^6 o 2^20, así que se toma el valor menor). La generación **falla** si el resultado lo supera. Se recomienda objetivo ≤200 KB.
- **Consecuencia adicional:** el DeCA externo del cargador también debe validarse contra 5 MB.

### R21. Requisitos del QR
- **Norma:** RES segundo.3.
- **Contenido:** el PDF incluye el QR **dentro del propio PDF**, con la URL única y específica del documento. Puede ofrecerse además como fichero independiente.
- **Consecuencia técnica:** QR vectorial incrustado en el PDF, con corrección de errores adecuada y tamaño de impresión suficiente. Endpoint para descargar el QR como imagen (PNG/SVG).

### R22. Qué debe contener o resolver el QR
- **Norma:** RES segundo.3 y tercero.3.
- **Contenido:** la URL del documento. Al invocarla debe producirse la descarga directa del PDF.
- **Consecuencia técnica:** el QR contiene únicamente una URL https. No contiene datos del transporte en claro.

### R23. Requisitos de la URL
- **Norma:** RES tercero.1, tercero.2 y tercero.5.
- **Contenido:**
  - Empieza por `https://` con TLS 1.2 o superior.
  - La forma de construirla es libre y puede incluir tokens, claves o expiración, garantizando que **no expire antes de la finalización del servicio**.
  - Pasados 7 días naturales desde el fin del servicio, **se puede** desactivar la descarga (facultad, no obligación).
  - Dominio libre y sin comunicación previa (RES primero.3).
- **Consecuencia técnica:** TLS ≥1.2 forzado, token de ≥128 bits de entropía, y desactivación configurable que **nunca** se aplica antes de la finalización del servicio. Un transporte que no se finaliza no caduca (la oficina recibe una alerta si lleva demasiado tiempo EN_CURSO). **Cuando se publique mediante Nginx Proxy Manager (infraestructura externa, D-08)**, el TLS lo terminará NPM: el mínimo TLS 1.2 deberá **comprobarse allí** en la fase de publicación. No se configura ahora.

### R24. ¿La URL debe permitir acceso directo al documento?
- **Norma:** RES tercero.3.
- **Interpretación:** **sí**. Invocar la URL debe producir la **descarga directa del PDF**.
- **Consecuencia técnica:** `GET` sin cookies, sin redirecciones a páginas intermedias, `Content-Type: application/pdf`. Probar con `curl`.

### R25. Autenticación y protección
- **Norma:** RES tercero.4.
- **Contenido:** las medidas de seguridad **no pueden limitar la descarga directa**. «No será válida ninguna URL que dirija a una página web que requiera credenciales o autenticación, ni que incorpore botones de descargas u otros elementos que impliquen una interacción manual».
- **Interpretación:** el token en la URL y la expiración son medidas admitidas. Login, CAPTCHA, páginas intermedias y botones no.
- **Consecuencia técnica:** la protección es **solo** el token no enumerable, más limitación de tasa y detección de abuso del lado servidor. **Importante:** un rate limit agresivo no debe bloquear a un agente legítimo. Se aplica por token y por IP con umbrales altos. **Publicación futura (NPM, D-08):** el proxy no debe introducir login, CAPTCHA, página intermedia, botón de descarga, *challenge* anti-bot ni redirecciones innecesarias en la ruta documental (RES tercero.4). Se verificará con `curl` y desde un dispositivo externo cuando se publique.

### R26. Qué debe poder hacer un agente en una inspección
- **Norma:** RES tercero.3 y séptimo.
- **Contenido:** los agentes de las fuerzas de vigilancia del transporte deben poder **descargar** el fichero durante el servicio, mediante la URL. El conductor presenta el DeCA con QR o solo el QR.
- **Consecuencia técnica:** el agente usa su propio dispositivo para escanear. Nuestro servicio documental debe estar disponible desde Internet público, sin lista de IPs permitidas.

### R27. Qué ocurre sin cobertura de datos
- **Norma:** la RES **no regula expresamente** este supuesto.
- **Lo que sí dice:** la copia del conductor puede ser electrónica en móvil o impresa (séptimo), y el agente descarga por la URL (tercero.3). Requiere conexión **del agente**, no necesariamente del conductor.
- **Estado:** **PENDIENTE DE VALIDACIÓN JURÍDICA**: qué debe ocurrir si ni el conductor ni el agente tienen conexión en el punto de control.
- **Consecuencia técnica (mitigación sin decidir el fondo jurídico):** copia local completa del PDF y del QR en la PWA (R28); opción de **copia impresa** documentada como respaldo.

### R28. ¿Basta mostrar una copia local/offline?
- **Norma:** RES séptimo (la copia en móvil es un medio válido de llevar el documento a bordo; ante inspección «presentará el DeCA con el código QR») y tercero.3 (descarga por URL).
- **Interpretación posible:** mostrar la copia local en el móvil cumple la obligación de **llevar y presentar** el documento. La obligación de **disponibilidad en el repositorio** recae en el emisor.
- **Estado:** **PENDIENTE DE VALIDACIÓN JURÍDICA**: no existe texto que diga que una copia local sustituya la verificación por URL. Tampoco que la excluya.
- **Consecuencia técnica:** la copia local siempre debe mostrar el PDF íntegro, su versión, el estado «última sincronización» y el QR. No se presenta como «verificado» si no hay conexión.

### R29. DeCA generado por el cargador
- **Norma:** ORD art. 4 (ambos obligados); RES segundo.4 (si uno lo generó, basta con que el otro pueda descargarlo); ORD art. 7.1 (el cargador queda exento si prueba que lo emitió).
- **Interpretación:** el sistema normativo está pensado para **un documento compartido** entre ambas partes (ORD art. 8: dos ejemplares del mismo documento).
- **Consecuencia técnica:** función «Añadir DeCA externo» (flujo G en `docs/01_flujos.md`).

### R30. ¿Puede usarlo el transportista?
- **Norma:** RES segundo.4; ORD art. 8; FAQ (ambos son responsables de que el documento se lleve a bordo).
- **Interpretación:** un DeCA que cumpla el art. 6 y la RES, generado por el cargador, **parece poder servir** al transportista como su documento. Pero algunos datos (e: AEC, f: fecha, g: matrícula) son responsabilidad del transportista y puede que el cargador no pueda conocerlos con exactitud.
- **Estado:** **PENDIENTE DE VALIDACIÓN JURÍDICA** en cuanto a si el transportista queda plenamente cubierto sin más, o si debe completar y modificar él el documento (R15) y con qué datos.
- **Consecuencia técnica (v1):** el servidor descarga el PDF con protecciones anti-SSRF, comprueba que se recibió un PDF y su tamaño (≤5 MB), lo almacena, calcula el hash, lo asocia al transporte, conserva la URL de origen y lo deja disponible al conductor y a la oficina para **revisión posterior**. **No** se hace OCR ni extracción automática de campos. **No** se muestra «DeCA válido» ni «cumplimiento completo»: haber descargado un PDF no demuestra nada sobre su validez. La extracción de campos podrá estudiarse más adelante.

### R31. ¿Pueden coexistir dos DeCA del mismo transporte?
- **Norma:** no regulado expresamente.
- **Estado:** **PENDIENTE DE VALIDACIÓN JURÍDICA**.
- **Consecuencia técnica:** el modelo permite que un transporte tenga más de un documento asociado (propio y externo), con un indicador de cuál es el «documento principal presentado». No se bloquea la coexistencia, se hace visible.

### R32. Qué documento conserva cada parte en ese supuesto
- **Norma:** RES segundo.4.
- **Estado:** **PENDIENTE DE VALIDACIÓN JURÍDICA** en el caso de dos documentos distintos.
- **Consecuencia técnica:** política conservadora: **conservar todos** los documentos relacionados con el transporte (propio, externo y versiones) durante al menos un año.

### R33. Cambio de tractora durante el transporte
- **Norma:** ORD art. 6.g: «si iniciada la operación de transporte se produjera un cambio de vehículo, esta circunstancia deberá hacerse constar en la documentación de control por la empresa de transportes».
- **Interpretación:** debe constar en el DeCA, lo hace **la empresa de transportes** (no el conductor), y puede hacerse con el método 1 o el 2 de la RES quinto. No se exige nuevo documento ni momento exacto más allá de «iniciada la operación».
- **Consecuencia técnica:** acción de oficina «Cambiar vehículo». Registra matrícula anterior, matrícula nueva, fecha y hora, usuario y motivo (es lo que pide el propietario del proyecto, y encaja con el requisito de conservar datos antiguos marcados como no válidos). Genera versión del DeCA (R15).
- **Aspecto sin resolver:** **PENDIENTE DE VALIDACIÓN JURÍDICA** (menor, P-06): si es admisible que el cambio se comunique por el conductor y la oficina lo registre con retraso. Lo registra la oficina con la hora real del cambio. «Solicitar cambio de vehículo» por el conductor (con hora declarada) puede existir después, sin modificar el DeCA por sí misma.

### R34. Cambio de conductor
- **Norma:** ORD art. 6 no incluye el conductor entre los datos de mercancías (sí lo incluye la hoja de ruta de viajeros, RES sexto.2).
- **Interpretación:** **el cambio de conductor no obliga a modificar el DeCA de mercancías**. «1 DeCA = 1 conductor» no es una regla legal.
- **Consecuencia técnica:** el conductor es un dato interno del transporte (con historial de asignaciones), no un campo del PDF. Esto además cumple la minimización de datos (R50).

### R35. Un conductor inicia y otro termina
- **Norma:** la misma que R34; RES séptimo (copia al conductor antes del inicio efectivo del servicio).
- **Interpretación:** el DeCA es el mismo. El nuevo conductor necesita llevar una copia con el QR.
- **Consecuencia técnica:** al reasignar el transporte, el DeCA pasa a la PWA del nuevo conductor (descarga offline) y se revoca para el anterior, salvo que continúe llevando carga del mismo DeCA.
- **PENDIENTE DE VALIDACIÓN JURÍDICA (menor):** si la entrega de copia «antes del inicio efectivo» se exige otra vez al nuevo conductor en el relevo. Se aplica por precaución: el nuevo conductor debe tener la copia antes de asumir.

### R36. Modificar el mismo DeCA, nueva versión u otro documento
- **Norma:** RES quinto.
- **Interpretación:** las dos vías (R15) son válidas. Para cambio de conductor no hace falta ninguna de las dos (R34).
- **Consecuencia técnica:** ver R15.

### R37. Historial de cambios
- **Norma:** RES quinto («conservarán los datos antiguos» / «conservar el fichero original»); ORD art. 9.
- **Consecuencia técnica:** historial inmutable (solo inserción). Cada versión conserva su PDF y su hash. El PDF del método 1 muestra también el historial de forma legible.

### R38. Fecha y hora de creación
- **Norma:** RES primero.2 («registrarán la fecha y hora de creación del fichero electrónico», para garantizar que es previa al inicio efectivo); RES segundo.1 (metadato del PDF).
- **Consecuencia técnica:** `CreationDate` del PDF y timestamp servidor (UTC) en base de datos. El reloj del servidor se sincroniza por NTP y el panel de salud alerta si hay deriva.
- **Observación:** «inicio efectivo del servicio» no está definido en la RES. **PENDIENTE DE VALIDACIÓN JURÍDICA** (ver P-03).

### R39. Fecha y hora de modificación
- **Norma:** RES primero.2 y segundo.1.
- **Consecuencia técnica:** `ModDate` del PDF y timestamp en BD en cada versión. En el método 1 se actualiza el metadato del mismo PDF.

### R40. Matrícula
- **Norma:** ORD art. 6.g.
- **Consecuencia técnica:** tractora + semirremolque/remolque como campos separados. Normalización (mayúsculas, sin espacios ni guiones) y validación de formato español como **aviso**, no como bloqueo (hay matrículas extranjeras de cabotaje).

### R41. Origen y destino
- **Norma:** ORD art. 6.c: «lugar de origen y destino del envío».
- **Interpretación:** la norma no define granularidad (municipio, dirección). Se recomienda dirección completa por seguridad probatoria, con mínimo municipio.
- **Estado:** **PENDIENTE DE VALIDACIÓN JURÍDICA (menor):** nivel de detalle exigido. Se adopta dirección + municipio + provincia como valor por defecto, y el mínimo configurable es municipio.

### R42. Mercancía
- **Norma:** ORD art. 6.d (naturaleza) y art. 7.2.
- **Consecuencia técnica:** descripción de la naturaleza de la mercancía en texto libre. ADR/SANDACH/residuos: el DeCA es **adicional** al documento correspondiente (FAQ), aunque pueden fusionarse en un solo documento si contiene los datos del art. 6.

### R43. Peso, cantidad, bultos y palés
- **Norma:** ORD art. 6.d.
- **Interpretación:** el dato legal es el **peso**. Si es de difícil determinación se busca «otro tipo de magnitud para determinar su peso». Palés, bultos y unidades son esa magnitud alternativa, no un sustituto libre.
- **Consecuencia técnica:** campo peso (kg) obligatorio **o** magnitud alternativa justificada. La UI muestra un aviso cuando se usa la alternativa.

### R44. Firmas
- **Norma:** RES preámbulo y cuarto; FAQ.
- **Contenido:** **no son obligatorias**. Si se firma por finalidad contractual, mínimo firma electrónica **avanzada (AdES)**; también válida la cualificada (QES) (eIDAS).
- **Consecuencia técnica:** **no se implementa firma en la versión 1.** Se deja diseñado el punto de extensión. FAQ aclara que la AdES no requiere certificado digital (p. ej. OTP o firma biométrica).

### R45. Certificados digitales
- **Norma:** FAQ («AdES no requieren de certificado digital»). Ninguna norma exige certificado para generar el DeCA.
- **Consecuencia técnica:** no requeridos.

### R46. Sello electrónico
- **Norma:** ninguna lo exige (RES completa leída).
- **Consecuencia técnica:** no se implementa. Si el cliente quisiera sellar, sería voluntario.

### R47. Sellado de tiempo
- **Norma:** ninguna lo exige. La RES exige únicamente registrar fecha y hora de creación y modificación (R38 y R39).
- **Consecuencia técnica:** no se implementa sellado cualificado. La integridad se refuerza con hash SHA-256 y cadena de auditoría propios (decisión de diseño, no obligación legal). Los metadatos del PDF **no** constituyen prueba de integridad por sí solos, por lo que se complementan con los registros de servidor.

### R48. Responsabilidades de la empresa que usa el sistema
- **Norma:** ORD art. 7; LOTT 141.17 (infracción **grave**: «carencia, falta de diligenciado o falta de datos esenciales de la documentación de control»), sancionada con 401 a 600 € (LOTT 143.1.d); LOTT 140.9 (**muy grave**: falseamiento de documentos de control o de sus datos), 4.001 a 6.000 € (LOTT 143.1.i).
- **Consecuencia técnica:** la plataforma no puede garantizar la exactitud de los datos que introduce el usuario. El README y el contrato de uso deben dejarlo claro.

### R49. Responsabilidades del proveedor del software
- **Norma:** **ninguna específica** en la ORD ni en la RES. La FAQ indica que no hay certificación obligatoria de aplicaciones DeCA.
- **Interpretación:** la RES impone requisitos a «las aplicaciones informáticas» (primero), pero la sanción administrativa recae sobre cargador y transportista. La responsabilidad del desarrollador sería contractual, civil o de producto.
- **Estado:** **PENDIENTE DE VALIDACIÓN JURÍDICA** (responsabilidad contractual, garantías y licencia). Recomendado: licencia con exclusión razonable de responsabilidad, revisada por abogado.

### R50. RGPD y LOPDGDD
- **Fuentes:** RGPD y LOPDGDD (no leídos en esta sesión; ver aviso del §0). Guía de la AEPD sobre responsable y encargado: https://www.aepd.es/sites/default/files/2019-09/informe-juridico-rgpd-responsable-encargado-empresas-seguridad.pdf
- **Hipótesis de trabajo (a verificar):**
  - La empresa transportista es **responsable del tratamiento**. Base de legitimación: obligación legal y ejecución de contrato (RGPD 6.1.b y 6.1.c).
  - Si el desarrollador solo entrega el software y no accede a los datos, **no es encargado**. Si presta soporte con acceso, alojamiento o backup remoto gestionado por él, **sí es encargado** y se necesita contrato del art. 28.
  - Minimización (RGPD 5.1.c), limitación del plazo de conservación (5.1.e), seguridad (32), registro de actividades (30) y notificación de brechas (33 y 34).
  - Derechos digitales laborales de LOPDGDD (intimidad en dispositivos, geolocalización): reforzar con **no geolocalizar**.
- **Estado:** **PENDIENTE DE VALIDACIÓN JURÍDICA** (roles exactos, plazo de conservación de datos de conductores más allá de 1 año, necesidad de EIPD, contrato tipo).
- **Consecuencia técnica:** minimización estricta (R34), sin geolocalización, sin identificadores de dispositivo salvo un ID propio aleatorio, retención configurable, exportación y borrado de datos de personas.
- **Política provisional (D-10):** logs de acceso público 90 días. **Borrado automático de otros datos personales desactivado** hasta validar RGPD/LOPDGDD. La documentación legal no se elimina automáticamente por ninguna política genérica de limpieza.

---

## 2. Cuestiones PENDIENTE DE VALIDACIÓN JURÍDICA (consolidado, Fase 3)

| ID | Cuestión | Qué se hace mientras tanto | Relevancia |
|---|---|---|---|
| **P-01** | **Sin cobertura** (R27 y R28): si la copia local en el móvil es suficiente cuando ni conductor ni agente tienen conexión | Copia local completa + opción de copia impresa. No se afirma cumplimiento | **Alta** |
| **P-02** | **DeCA del cargador** (R30): si el transportista queda cubierto con el DeCA externo sin completarlo | Se almacena y queda para revisión de oficina. Sin extracción automática en la v1. No se marca como «válido» ni «cumple» | **Alta** |
| **P-03** | **«Inicio efectivo del servicio»** (R38): momento exacto, y si los datos provisionales (peso, palés) antes de cargar son admisibles | DeCA anticipado con marca de «datos provisionales» y modificación posterior (R15). Implica riesgo de «inexactitud» (ORD 7) | **Alta** |
| **P-04** | **Dos DeCA del mismo transporte** (R31 y R32) | Se permite la coexistencia con visibilidad. Se conservan todos | Media |
| **P-05** | Cambio de conductor: nueva entrega de copia al relevo (R35) | Se entrega siempre al nuevo conductor | Baja |
| **P-06** | Cambio de tractora comunicado por el conductor y registrado tarde por la oficina (R33) | Lo registra la oficina con la hora real del cambio. «Solicitar cambio de vehículo» queda para el futuro | Media |
| **P-07** | Granularidad de origen y destino (R41) | Dirección completa por defecto | Baja |
| **P-08** | Desde cuándo cuenta el «al menos un año» de conservación (R12) | Año de calendario desde la fecha de fin del servicio. Campo «no antes de». Sin borrado automático | Baja |
| **P-09** | Responsabilidad del proveedor/desarrollador (R49) y licencia | Cláusulas a revisar por abogado | Media |
| **P-10** | RGPD/LOPDGDD: roles, contrato de encargado, plazos, EIPD y transferencias (R50) | Minimización máxima. Logs públicos 90 días. Sin borrado automático de datos personales | **Alta** |
| **P-11** | **Acceso posterior de la contraparte.** *No es una contradicción*: la norma contempla tanto desactivar la URL pública a los 7 días (R23) como la conservación y disponibilidad durante al menos un año (R11). Lo abierto es **qué cuenta como «poder descargar»**, **para quién** y **por qué medio** cuando el documento lo generó la empresa | Se conservan los documentos sin borrar. **La entrega manual por la oficina NO se acepta como solución definitiva de la v1.** Antes de cerrar la v1 hay que definir y documentar un mecanismo sencillo y seguro, distinto de la URL pública del QR, una vez confirmado el alcance legal. No se inventa solución jurídica | **Alta (bloquea el cierre de la v1)** |
| **P-12** | Si basta el DeCA externo (cargador) **sin** el AEC, matrícula y fecha del transportista | Ver P-02 | Media |
| **P-13** | **Autorización para modificar campos** (R14): qué datos, quién y en qué momento pueden modificarse legalmente. No hay fuente que lo establezca | Política de modificación restrictiva y explícita (por campo, responsable, momento y rol), configurable. Tras FINALIZADO no se modifica. Ver §10 del documento 03 | **Alta** |

**Estado de P-01 a P-13:** todas siguen **abiertas**. Ninguna se da por resuelta por empezar a programar. P-11 queda reclasificada como «mecanismo por definir», no como incompatibilidad normativa.

## 3. Fuentes complementarias (no normativas)

Los siguientes sitios aparecieron en las búsquedas y se usaron **solo para orientarse**. Ninguna decisión se basa en ellos: eqgest.com, kaleidotrans.com, giormo.com, gauna.es, decatransporte.com, documentodeca.es, ilean.ai, controldeca.com, camionactualidad.es. Todo lo que dicen y se ha utilizado se contrastó con BOE y Ministerio.

**Dato divergente detectado:** varias fuentes privadas afirman que «el QR debe permitir descarga inmediata sin pasos adicionales» y sanciones de «401 a 600 €». Lo primero **sí** está en la RES (tercero.3 y .4). Lo segundo está en LOTT 141.17 y 143.1.d (verificado).
