# DECARGO · instalación

DECARGO se instala en un equipo de la empresa (o en un servidor contratado por ella) y funciona con **Docker y Docker Compose**: PostgreSQL, la API, el servicio de documentos y la web corren en contenedores. No hay que instalar nada más.

- [Requisitos](#requisitos)
- [Linux](#linux)
- [Windows 10/11](#windows-1011)
- [Dirección https (obligatoria para los QR)](#dirección-https-obligatoria-para-los-qr)
- [Primer acceso](#primer-acceso)
- [Antes de usarlo con datos reales](#antes-de-usarlo-con-datos-reales)
- [Copias de seguridad](#copias-de-seguridad)
- [Actualizar](#actualizar)
- [Desinstalar](#desinstalar)

## Requisitos
| | Mínimo |
|---|---|
| Sistema | Linux de 64 bits (Debian, Ubuntu, Rocky…) o Windows 10 (2004+) / 11 de 64 bits con WSL 2 |
| Docker | Docker Engine 24+ con el plugin Compose v2, o Docker Desktop |
| Memoria y disco | 2 GB de RAM; 5 GB libres, más lo que ocupen los PDF y las copias de seguridad |
| Red | Un **dominio con https** que llegue al equipo (para los QR de los DeCA; ver más abajo) |
| Copias | Un disco o destino **distinto** del equipo para guardar las copias de seguridad |

## Linux
1. Instala Docker Engine con su plugin Compose: <https://docs.docker.com/engine/install/>. Después, añade tu usuario al grupo `docker` (`sudo usermod -aG docker $USER`) y vuelve a iniciar sesión.
2. Descarga DECARGO y ejecuta el instalador:
   ```bash
   git clone https://github.com/FarAoN0211/decargo.git
   cd decargo
   ./instalar.sh
   ```
   `./instalar.sh --check` solo comprueba los requisitos.

El instalador:
1. Comprueba los requisitos: Docker, Compose, `openssl`, `python3`, `curl`, `iproute2`, memoria y disco.
2. Crea `.env` con secretos aleatorios (`./deca init`).
3. Pregunta la IP local del equipo y la dirección pública https (`./deca setup`).
4. Arranca DECARGO.
5. Crea el **primer administrador**. Su código de activación se muestra una sola vez.

Se puede volver a ejecutar sin riesgo: no borra datos ni cambia los secretos.

## Windows 10/11
DECARGO es software de Linux. En Windows se ejecuta dentro de **WSL 2** (el Linux integrado en Windows) con el Docker de **Docker Desktop**. El instalador lo prepara todo.

1. Instala **Docker Desktop** (<https://www.docker.com/products/docker-desktop/>) con el motor **WSL 2**, ábrelo una vez y acepta sus condiciones.
2. Descarga DECARGO: botón «Code → Download ZIP» y descomprímelo, o `git clone`.
3. Haz doble clic en **`INSTALAR-WINDOWS.bat`**. El instalador:
   1. Comprueba Windows, WSL y Docker Desktop. Si falta WSL, ofrece instalarlo; después hay que reiniciar.
   2. Instala Ubuntu en WSL si no lo tienes. Te pedirá crear un usuario y una contraseña de Linux.
   3. Comprueba que Docker Desktop está integrado con Ubuntu. Si no lo está, se activa en Docker Desktop → Settings → Resources → WSL integration → Ubuntu.
   4. Copia DECARGO a Ubuntu (`~/decargo`).
   5. Pregunta si DECARGO se usará **solo desde ese equipo** (127.0.0.1) o también **desde la red local** (la IP de Windows).
   6. Ejecuta el instalador de Linux.
4. En Docker Desktop → Settings → General, activa **«Start Docker Desktop when you sign in»**. Así DECARGO arranca solo al encender el equipo.

Para gestionarlo desde Windows, abre PowerShell en la carpeta de DECARGO:
```powershell
.\deca-windows.ps1 status          # estado
.\deca-windows.ps1 backup          # copia de seguridad
.\deca-windows.ps1 config show     # configuración
.\deca-windows.ps1 actualizar      # aplica la versión de esta carpeta (copia de seguridad previa)
```

> El instalador de Windows es nuevo. Si algo falla, el mensaje indica el paso; la instalación se puede repetir sin perder nada.
> Un equipo con Windows que se apaga o suspende deja de servir los DeCA: para producción es mejor un equipo siempre encendido.

## Dirección https (obligatoria para los QR)
La Resolución de 5 de junio de 2026 exige que el QR del DeCA lleve un enlace **https**. DECARGO publica sus servicios en la red local sin cifrar. Delante hace falta un **proxy inverso con certificado**: Nginx Proxy Manager, Caddy, Traefik o el del router o hosting. Configúralo así:

| Dirección pública | Destino |
|---|---|
| `https://tu-dominio/` | servicio **web** (`WEB_BIND:WEB_PORT`, por defecto puerto 18082) |
| `https://tu-dominio/d/` | servicio **docs** (`DOCS_BIND:DOCS_PORT`, por defecto puerto 18081) |

Después:
1. Entra como administrador en **Configuración → Dirección pública de los DeCA**, escribe `https://tu-dominio`, pulsa **Comprobar** y **Guardar**. También se puede hacer con `./deca config set-domain https://tu-dominio` y `./deca up`.
2. `./deca config show` muestra la IP, los puertos y la ruta de la aplicación.

Con el dominio puesto:
- `https://tu-dominio/` muestra la **web pública**: presentación, descarga de la app Android y demostración.
- La aplicación vive en `https://tu-dominio/<ruta>/`. Esa ruta la crea el instalador y está en `.env` (`DECARGO_APP_PATH`). El botón **Acceder** de la web pública lleva a ella. Para cambiarla: `./deca config set-app-path nueva` y `./deca up`.

## Primer acceso
1. Abre la aplicación (botón **Acceder** de la web pública) → **Activar cuenta**.
2. Escribe el usuario del administrador y el **código de activación** que mostró el instalador, y elige una contraseña.
3. Configura la **verificación en dos pasos** con una aplicación autenticadora (Google Authenticator, Aegis…). Es obligatoria para la oficina.
4. Si perdiste el código: `./deca create-user` crea otro usuario. Un administrador también puede generar un código nuevo desde Conductores.

## Antes de usarlo con datos reales
En **Configuración**:
- **Datos de la empresa:** son el transportista efectivo de los DeCA.
- **Modelo de documento:** el modelo DECARGO o la carta de porte.
- **Desactivar el modo de pruebas:** mientras esté activo, los PDF llevan «DOCUMENTO DE PRUEBA».
- **Lista «antes de usar con datos reales»:** https, modo de pruebas, endpoints de prueba y avisos.
- **App Android** (opcional): para los avisos que encienden la pantalla, sube aquí las credenciales de Firebase. La propia pantalla explica cómo obtenerlas.

## Copias de seguridad
```bash
./deca backup       # base de datos + PDF + configuración → repositorio restic cifrado y versionado
./deca snapshots    # copias disponibles
./deca verify       # integridad de los PDF y de la auditoría
```
- **Guarda la `RESTIC_PASSWORD` del archivo `.env` fuera del equipo.** Sin ella no se puede abrir ninguna copia.
- El repositorio de copias es el volumen de Docker `decargo_backups`. Ponlo en **otro disco**, o cópialo fuera con regularidad: una copia en el mismo disco no protege si el disco falla.
- Programa una copia diaria. En Linux, con `crontab -e`, por ejemplo: `0 3 * * * cd /ruta/a/decargo && ./deca backup`.
- Restaurar: [OPERACION.md](OPERACION.md#restauración-servidor-nuevo-o-perdido). Cambiar de servidor: [TRASLADO_SERVIDOR.md](TRASLADO_SERVIDOR.md).

## Actualizar
```bash
./deca backup              # siempre antes
git pull                   # o sustituye la carpeta por la versión nueva (conserva .env)
./deca up                  # reconstruye y aplica las migraciones de la base de datos
./deca verify
```
En Windows: descarga la versión nueva sobre la carpeta y ejecuta `.\deca-windows.ps1 actualizar`.

Las migraciones solo añaden: nunca borran datos ni modifican documentos ya emitidos.

## Desinstalar
`./deca down` detiene DECARGO **sin borrar datos**. Los datos viven en volúmenes de Docker (`decargo_pgdata`, `decargo_documents`, `decargo_backups`).

Para eliminarlos de verdad, haz antes una copia y después ejecuta `docker volume rm` sobre esos volúmenes. **No se puede deshacer.** Recuerda que la ley obliga a conservar los DeCA un tiempo mínimo.
