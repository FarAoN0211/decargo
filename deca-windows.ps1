# DECARGO · gestión desde Windows: pasa el comando a ./deca dentro de WSL (Ubuntu), donde está instalado DECARGO.
#   .\deca-windows.ps1 status        estado de los contenedores
#   .\deca-windows.ps1 backup        copia de seguridad
#   .\deca-windows.ps1 up            arrancar / aplicar cambios
#   .\deca-windows.ps1 config show   configuración (dirección pública, puertos, ruta de la aplicación)
#   .\deca-windows.ps1 actualizar    copia la versión de ESTA carpeta a Linux (sin tocar .env ni datos), hace copia de seguridad y arranca
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Args2)
$Distro = 'Ubuntu'; $Dest = '~/decargo'
if ($Args2.Count -gt 0 -and $Args2[0] -eq 'actualizar') {
  $src = (& wsl.exe -d $Distro -- wslpath -a ($PSScriptRoot -replace '\\', '/')).Trim()
  & wsl.exe -d $Distro -- bash -lc "cd $Dest && ./deca backup && cp -a '$src/.' $Dest/ && sed -i 's/\r$//' deca instalar.sh scripts/*.sh && chmod +x deca instalar.sh scripts/*.sh && ./deca up"
  exit $LASTEXITCODE
}
$quoted = ($Args2 | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '
& wsl.exe -d $Distro -- bash -lc "cd $Dest && ./deca $quoted"
exit $LASTEXITCODE
