# Instala o Meu Player no Windows: atalhos no Menu Iniciar e na Area de Trabalho, sem precisar de administrador.
# O aplicativo abre o site publicado numa janela propria (Edge ou Chrome em modo aplicativo), com perfil separado.
param([string]$TestRoot = '')
$ErrorActionPreference = 'Stop'
if (-not $TestRoot -and $env:MEUPLAYER_TEST) { $TestRoot = $env:MEUPLAYER_TEST }
$Name = 'Meu Player'
$Url = 'https://guilhermesimoni6.github.io/meu-player/'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -AssemblyName System.Windows.Forms

if ($TestRoot) {
  $dir = Join-Path $TestRoot 'app'; $menu = Join-Path $TestRoot 'menu'; $desk = Join-Path $TestRoot 'desk'
} else {
  $dir = Join-Path $env:LOCALAPPDATA $Name
  $menu = [Environment]::GetFolderPath('Programs'); $desk = [Environment]::GetFolderPath('Desktop')
}
function Say($text, $icon) { if (-not $TestRoot) { [void][System.Windows.Forms.MessageBox]::Show($text, $Name, 'OK', $icon) } else { Write-Host $text } }

function Find-Browser {
  foreach ($n in 'msedge.exe', 'chrome.exe') {
    foreach ($h in 'HKLM', 'HKCU') {
      $v = (Get-ItemProperty ($h + ':\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\' + $n) -ErrorAction SilentlyContinue).'(default)'
      if ($v -and (Test-Path $v)) { return $v }
    }
  }
  return $null
}

try {
  $browser = Find-Browser
  if (-not $browser) { Say 'Nao encontrei o Microsoft Edge nem o Google Chrome neste computador. Instale um deles e rode o instalador de novo.' 'Warning'; exit 1 }

  New-Item -ItemType Directory -Force -Path $dir, $menu, $desk | Out-Null
  foreach ($f in 'meu-player.ico', 'uninstall.ps1') { Copy-Item -Force (Join-Path $here $f) (Join-Path $dir $f) }

  $args = '--app=' + $Url + ' --user-data-dir="' + (Join-Path $dir 'perfil') + '" --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required --window-size=1280,860'
  $ws = New-Object -ComObject WScript.Shell
  foreach ($folder in $menu, $desk) {
    $l = $ws.CreateShortcut((Join-Path $folder ($Name + '.lnk')))
    $l.TargetPath = $browser; $l.Arguments = $args; $l.WorkingDirectory = $dir
    $l.IconLocation = (Join-Path $dir 'meu-player.ico'); $l.Description = 'Toca-fitas para o seu Spotify'
    $l.Save()
  }

  if (-not $TestRoot) {
    $k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MeuPlayer'
    New-Item -Force -Path $k | Out-Null
    $un = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $dir 'uninstall.ps1') + '"'
    Set-ItemProperty $k DisplayName $Name; Set-ItemProperty $k DisplayVersion '1.0'; Set-ItemProperty $k Publisher 'Meu Player'
    Set-ItemProperty $k DisplayIcon (Join-Path $dir 'meu-player.ico'); Set-ItemProperty $k UninstallString $un
    Set-ItemProperty $k InstallLocation $dir; Set-ItemProperty $k NoModify 1 -Type DWord; Set-ItemProperty $k NoRepair 1 -Type DWord
  }
  Say ('Meu Player instalado. Procure por "' + $Name + '" no Menu Iniciar ou use o atalho da Area de Trabalho. Na primeira vez, entre com a sua conta do Spotify.') 'Information'
} catch {
  Say ('Nao foi possivel instalar: ' + $_.Exception.Message) 'Error'
  exit 1
}
