# DECARGO · Traslado de servidor y cambio de dominio

No hay que editar ficheros a mano. Hay dos herramientas:

- **Web → Configuración** (solo administrador): cambia la **dirección pública** de los DeCA (la del QR), la **comprueba** y explica el traslado paso a paso.
- **`./deca setup`** (terminal del servidor): asistente que detecta la **IP local**, pregunta la dirección pública, comprueba los puertos y arranca.

| Dato | Dónde se cambia |
|---|---|
| Dirección pública de los DeCA (`https://decargo.tuempresa.com`) | Web → Configuración (se guarda en la base de datos y **viaja con las copias de seguridad**). También: `./deca config set-domain https://…` |
| IP local en la que publican `api`, `docs` y `web` | `./deca setup` (o `./deca config set-ip 192.168.1.50`) |
| Puertos (`API_PORT`, `DOCS_PORT`, `WEB_PORT`) | `.env`; `./deca ports` y `./deca setup` avisan si están ocupados |
| Ruta de la aplicación (`https://dominio/<ruta>/`; la raíz es la web pública) | `.env` → `DECARGO_APP_PATH`, creada una vez por `./deca init`/`./deca up`. Cambiarla: `./deca config set-app-path <ruta>\|nueva` y `./deca up`. Al trasladar, **copia el mismo valor** al `.env` nuevo para que los favoritos sigan valiendo (las rutas antiguas `/login`, `/conductor`… redirigen solas) |
| Botón «Probar DECARGO» | `./deca config set-demo-url https://…` (vacío = «Próximamente») |
| Proxy con HTTPS (NPM u otro) | fuera de DECARGO: dominio → `web`; ruta `/d/` → `docs` |

`./deca config show` enseña la dirección vigente y la IP/puertos del `.env`.

## Trasladar a otro servidor (misma empresa, otro equipo)

1. **Servidor antiguo:** `./deca backup`. Guarda aparte `RESTIC_PASSWORD` (sin ella la copia no se abre).
2. **Servidor nuevo:** copia la carpeta del proyecto y ejecuta `./deca setup`. Detecta la IP, pregunta la dirección pública y comprueba los puertos. Antes de restaurar, pon en el `.env` nuevo la `RESTIC_PASSWORD` del servidor antiguo.
3. Conecta el volumen de copias y ejecuta `./deca restore`. Recupera usuarios, transportes, DeCA y PDF; la `APP_KEY` se recupera sola (sin ella no se podrían volver a mostrar los QR). Se cierran todas las sesiones: cada persona vuelve a entrar; los dispositivos autorizados siguen autorizados.
4. **Proxy:** dominio → `web`; ruta `/d/` → `docs`; certificado HTTPS.
5. **Web → Configuración:** escribe la dirección pública nueva, pulsa **Comprobar** (verifica desde el servidor que «/» es DECARGO y que «/d/» llega a documentos) y **Guardar**.

## Qué pasa con los DeCA ya emitidos

- La dirección de un DeCA **va impresa dentro de su PDF** (en el QR): no se puede cambiar después sin emitir un PDF nuevo.
- El servicio `docs` busca el documento por su código (`/d/<código>`) y **responde con cualquier nombre de dominio**: los QR antiguos siguen funcionando mientras el dominio antiguo apunte al servidor nuevo.
- Los DeCA nuevos usan la dirección nueva. Inicio y Configuración muestran cuántos DeCA llevan otra, y el detalle de cada transporte lo señala.
- Si el dominio antiguo se va a dar de baja con transportes en curso o dentro del plazo de conservación, hay que mantenerlo apuntando al servidor o reemitir esos DeCA (nuevo PDF; pendiente de la política P-13).

## Antes de usarlo con datos reales

Configuración muestra esta lista con ✔/✘: dirección con https, `DECA_TEST_MODE=0` (quita el rótulo «DOCUMENTO DE PRUEBA»), `DEV_ENDPOINTS=0`, claves VAPID. Además: sin usuarios `*.dev` (`./deca seed-dev` es solo para desarrollo) y copia de seguridad en un destino independiente del disco del servidor.
