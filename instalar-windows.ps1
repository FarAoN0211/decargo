# DECARGO · instalación en Windows 10/11 con Docker Desktop (motor WSL 2).
# Se lanza con doble clic en INSTALAR-WINDOWS.bat. DECARGO se ejecuta dentro de WSL (Linux) con el Docker de Docker Desktop:
# este script comprueba los requisitos, copia DECARGO a la distribución Linux de WSL y ejecuta allí ./instalar.sh.
# Se puede volver a ejecutar: no borra datos ni cambia los secretos ya creados.
$ErrorActionPreference = 'Stop'
$Distro = 'Ubuntu'
$Dest = '~/decargo'

function Ok($m)    { Write-Host "  [OK] $m" -ForegroundColor Green }
function Falta($m) { Write-Host "  [X]  $m" -ForegroundColor Red }
function Aviso($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function SiNo($q)  { $r = Read-Host "$q [S/n]"; return -not ($r -match '^[nN]') }
function Fin($code) { Write-Host ''; Read-Host 'Pulsa Intro para cerrar'; exit $code }
function WslListar { (& wsl.exe -l -q 2>$null) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ } }

Write-Host '== DECARGO · instalación en Windows ==' -ForegroundColor Cyan
Write-Host ''
Write-Host '1. Requisitos' -ForegroundColor Cyan

# Windows 10 2004 (19041) o posterior, 64 bits
$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
if ($build -ge 19041 -and [Environment]::Is64BitOperatingSystem) { Ok "Windows (compilación $build, 64 bits)" }
else { Falta 'Hace falta Windows 10 versión 2004 (compilación 19041) o posterior, de 64 bits.'; Fin 1 }

# WSL 2
& wsl.exe --status *> $null
if ($LASTEXITCODE -ne 0) {
  Falta 'WSL (Subsistema de Windows para Linux) no está instalado.'
  Write-Host '      Se instala con el comando «wsl --install» como administrador y después hay que REINICIAR el equipo.'
  if (SiNo '      ¿Instalarlo ahora (pedirá permisos de administrador)?') { Start-Process wsl.exe -ArgumentList '--install', '-d', $Distro -Verb RunAs -Wait; Aviso 'Reinicia el equipo y vuelve a ejecutar INSTALAR-WINDOWS.bat.' }
  Fin 1
}
Ok 'WSL instalado'

# Docker Desktop en marcha
$dockerOk = $false
try { & docker version --format '{{.Server.Version}}' *> $null; $dockerOk = ($LASTEXITCODE -eq 0) } catch { $dockerOk = $false }
if (-not $dockerOk) {
  $dd = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $dd) {
    Aviso 'Docker Desktop está instalado pero no en marcha: lo arranco y espero (hasta 3 minutos)…'
    Start-Process $dd
    for ($i = 0; $i -lt 90 -and -not $dockerOk; $i++) { Start-Sleep 2; try { & docker version --format '{{.Server.Version}}' *> $null; $dockerOk = ($LASTEXITCODE -eq 0) } catch {} }
  }
  if (-not $dockerOk) {
    Falta 'Hace falta Docker Desktop en marcha: https://www.docker.com/products/docker-desktop/'
    Write-Host '      Al instalarlo, elige el motor WSL 2. Después ábrelo una vez, acepta sus condiciones y vuelve a ejecutar este instalador.'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      if (SiNo '      ¿Instalar Docker Desktop ahora con winget?') { winget install -e --id Docker.DockerDesktop; Aviso 'Abre Docker Desktop, acepta sus condiciones y vuelve a ejecutar INSTALAR-WINDOWS.bat.' }
    }
    Fin 1
  }
}
Ok "Docker Desktop en marcha (motor $(& docker version --format '{{.Server.Version}}'))"

# Distribución Linux de WSL donde vive DECARGO (Ubuntu)
if (-not (WslListar | Where-Object { $_ -eq $Distro })) {
  Aviso "No hay ninguna distribución «$Distro» en WSL. Se instala ahora: al terminar te pedirá un usuario y una contraseña de Linux (cualquiera; apúntalos)."
  if (-not (SiNo '      ¿Instalar Ubuntu en WSL?')) { Fin 1 }
  & wsl.exe --install -d $Distro
  Aviso 'Cuando Ubuntu termine de configurarse (te habrá pedido usuario y contraseña), vuelve a ejecutar INSTALAR-WINDOWS.bat.'
  Fin 0
}
Ok "Distribución $Distro en WSL"

# Docker de Docker Desktop disponible DENTRO de Ubuntu (integración WSL)
& wsl.exe -d $Distro -- docker version *> $null
if ($LASTEXITCODE -ne 0) {
  Falta "Docker no está disponible dentro de $Distro."
  Write-Host "      En Docker Desktop: Settings → Resources → WSL integration → activa «$Distro» → Apply & restart. Después vuelve a ejecutar este instalador."
  Fin 1
}
Ok "Integración de Docker Desktop con $Distro"

# Herramientas que usa DECARGO dentro de Linux
Write-Host '      Comprobando las herramientas de Linux (python3, openssl, curl, iproute2)…'
& wsl.exe -d $Distro -u root -- bash -c 'command -v python3 >/dev/null && command -v openssl >/dev/null && command -v curl >/dev/null && command -v ss >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 openssl curl iproute2 >/dev/null)'
if ($LASTEXITCODE -ne 0) { Falta 'No se pudieron instalar python3, openssl, curl e iproute2 en Ubuntu (¿hay conexión a Internet?).'; Fin 1 }
Ok 'Herramientas de Linux'

Write-Host ''
Write-Host '2. Copiar DECARGO a Linux (WSL)' -ForegroundColor Cyan
# DECARGO se ejecuta desde el disco de Linux (más rápido y con los permisos correctos), no desde C:\.
$src = (& wsl.exe -d $Distro -- wslpath -a ($PSScriptRoot -replace '\\', '/')).Trim()
& wsl.exe -d $Distro -- bash -c "mkdir -p $Dest && cp -a '$src/.' $Dest/ && cd $Dest && chmod +x deca instalar.sh scripts/*.sh 2>/dev/null; sed -i 's/\r$//' deca instalar.sh scripts/*.sh 2>/dev/null; true"
if ($LASTEXITCODE -ne 0) { Falta "No se pudo copiar DECARGO a $Dest dentro de $Distro."; Fin 1 }
Ok "DECARGO copiado a $Dest (dentro de $Distro). Los datos viven en volúmenes de Docker, no en esa carpeta."

Write-Host ''
Write-Host '3. Red' -ForegroundColor Cyan
# IP de Windows en la red local (la que tiene puerta de enlace). Docker Desktop publica los puertos en Windows.
$ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1).IPv4Address.IPAddress
Write-Host '      ¿Desde dónde se va a usar DECARGO?'
Write-Host "        1) Solo desde este equipo (y un proxy HTTPS instalado en este mismo equipo)  → 127.0.0.1"
Write-Host "        2) Desde otros equipos y teléfonos de la red local                          → $ip"
$op = Read-Host '      Elige 1 o 2 [1]'
$bind = if ($op -eq '2' -and $ip) { $ip } else { '127.0.0.1' }
Ok "DECARGO escuchará en $bind"
if ($bind -ne '127.0.0.1') { Aviso 'Si el Firewall de Windows pregunta por Docker, permite el acceso en redes PRIVADAS (no en públicas).' }

Write-Host ''
Write-Host '4. Instalación (dentro de Linux)' -ForegroundColor Cyan
# El instalador de Linux pregunta la dirección pública, arranca DECARGO y crea el primer administrador.
& wsl.exe -d $Distro -- bash -lc "cd $Dest && DECARGO_SETUP_IP=$bind ./instalar.sh"
$rc = $LASTEXITCODE

Write-Host ''
if ($rc -eq 0) {
  Write-Host '== Hecho ==' -ForegroundColor Green
  Write-Host '  · DECARGO arranca solo cuando arranca Docker Desktop: en Docker Desktop → Settings → General, activa «Start Docker Desktop when you sign in».'
  Write-Host "  · Para gestionarlo (copias, actualizaciones…) usa deca-windows.ps1 en esta carpeta, por ejemplo:  .\deca-windows.ps1 backup"
} else { Falta "La instalación no terminó (código $rc). Revisa los mensajes de arriba." }
Fin $rc
