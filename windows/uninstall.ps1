# Remove o Meu Player: atalhos, entrada em "Aplicativos instalados" e a pasta do aplicativo (inclusive o login guardado).
param([string]$TestRoot = '')
$Name = 'Meu Player'
if ($TestRoot) {
  $dir = Join-Path $TestRoot 'app'; $menu = Join-Path $TestRoot 'menu'; $desk = Join-Path $TestRoot 'desk'
} else {
  $dir = Join-Path $env:LOCALAPPDATA $Name
  $menu = [Environment]::GetFolderPath('Programs'); $desk = [Environment]::GetFolderPath('Desktop')
}
foreach ($folder in $menu, $desk) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $folder ($Name + '.lnk')) }
if (-not $TestRoot) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MeuPlayer' }
# a pasta contem este proprio script: apaga logo depois que ele terminar
Start-Process -WindowStyle Hidden cmd.exe -ArgumentList ('/c ping 127.0.0.1 -n 3 >nul & rd /s /q "' + $dir + '"')
