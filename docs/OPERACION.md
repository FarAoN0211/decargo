# DECARGO · operación del servidor

Comandos del día a día con `./deca` (en Windows: `.\deca-windows.ps1 <comando>`). Instalación: [INSTALACION.md](INSTALACION.md).

## Usuarios desde la terminal
```bash
./deca create-user --username admin --name "Nombre" --role admin --company-name "Mi empresa S.L." --company-nif B12345678 --company-address "Calle 1, Almería"
```
Imprime **una sola vez** el código de activación (solo se guarda su hash). El usuario lo canjea en `POST /api/v1/auth/activate` y fija su contraseña. A partir de ahí, la oficina crea conductores por la API. Roles: `admin`, `oficina`, `conductor`, `solo_lectura`.
**Segundo factor (TOTP) para oficina, admin y solo lectura:** tras activar la cuenta, la sesión solo permite `POST /api/v1/auth/totp/setup` (devuelve el secreto, la URI `otpauth://` y un QR SVG para la aplicación autenticadora) y `POST /api/v1/auth/totp/enable` con un código. Después, el login exige `totp_code`. Si se pierde el autenticador: un admin usa `POST /api/v1/users/:id/totp/reset`, o en el servidor `./deca reset-totp --username u`.
Pruebas (⚠️ crean datos y algunas **destruyen volúmenes**: solo en una copia desechable, nunca contra una pila con datos): `scripts/identity-test.mjs run | restore-check`, `scripts/vertical-test.sh`, `scripts/clean-restore-test.sh`, `scripts/docs-network-test.sh`. No destructivas: `scripts/ssrf-test.sh` y `scripts/lan-test.sh`.

## Datos y contenedores
Los datos viven en volúmenes de Docker con nombre (`decargo_pgdata`, `decargo_documents`, `decargo_backups`), no en los contenedores. `./deca down` seguido de `./deca up` **no pierde nada**.
**Nunca uses `docker compose down -v`**: borraría los volúmenes.

## Backup
```bash
./deca backup       # pg_dump consistente + documentos + configuración → repositorio restic cifrado y versionado
./deca snapshots
./deca verify       # hashes de todos los PDF, tokens descifrables con APP_KEY y cadena de auditoría
```
**Backup de desarrollo frente a backup operativo:**
- **Hoy (desarrollo):** el repositorio es un volumen de Docker en el **mismo equipo y disco**. Sirve para validar backup y restauración. **No es una estrategia suficiente de producción.**
- **Producción (pendiente):** requiere una copia **independiente del almacenamiento principal** (destino por decidir) y, opcionalmente, una copia remota cifrada. RAID no es backup.

## Restauración (servidor nuevo o perdido)
1. Prepara Linux + Docker y copia el paquete DECARGO.
2. Conecta el repositorio de backup al volumen `decargo_backups` (`./deca init` lo crea vacío; copia dentro el repositorio restic).
3. `./deca init`, y pon en `.env` la `RESTIC_PASSWORD` original.
4. `./deca restore [snapshot]` (por defecto, el último). Restaura PostgreSQL y documentos, recupera `APP_KEY` del backup y levanta los servicios.
5. `./deca verify`.

Un backup no se considera válido porque el comando termine bien: se valida **restaurando**. Pruebas automáticas (destruyen los volúmenes de datos tras hacer backup):
```bash
./scripts/vertical-test.sh         # flujo completo + destruir + restaurar
./scripts/clean-restore-test.sh    # simula un servidor nuevo (sin volúmenes, sin imágenes, .env nuevo)
```
Los informes quedan en `informes/`.

## Seguridad
- `docs`: solo lectura (rol PostgreSQL `deca_docs` que solo lee la vista `docs_resolve`, volumen `:ro`, sistema de ficheros `read_only`, sin capacidades Linux, no root). Única ruta: `GET /d/<token>`.
- Token: 32 bytes aleatorios (CSPRNG); en la base de datos solo el hash SHA-256.
- Auditoría y versiones de DeCA: solo inserción (trigger); auditoría con hash encadenado.
- Los endpoints `/api/v1/dev/*` son de prueba (clave `DEV_API_KEY`); se desactivan con `DEV_ENDPOINTS=0`.

## Actualización
Pendiente de implementar (`./deca update`): backup obligatorio previo, migraciones aditivas y rollback. Hoy: `./deca backup`, sustituir el paquete y `./deca up` (las migraciones se aplican solas y son inmutables).
