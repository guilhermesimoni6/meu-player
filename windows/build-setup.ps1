# Gera windows\dist\MeuPlayer-Setup.exe usando o IExpress, que ja vem no Windows (nao precisa instalar nada).
# Uso:  powershell -ExecutionPolicy Bypass -File windows\build-setup.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$stage = Join-Path $env:TEMP 'meuplayer-build'
$dist = Join-Path $here 'dist'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $stage
New-Item -ItemType Directory -Force -Path $stage, $dist | Out-Null

# 1) icone .ico (PNG de 256 px dentro do contêiner ICO) feito a partir do icone do site
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile((Join-Path $root 'icons\icon-512.png'))
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($src, 0, 0, 256, 256); $g.Dispose()
$ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $png = $ms.ToArray()
$bmp.Dispose(); $src.Dispose()
$fs = [System.IO.File]::Create((Join-Path $stage 'meu-player.ico')); $bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]1)
$bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
$bw.Write([uint32]$png.Length); $bw.Write([uint32]22); $bw.Write($png); $bw.Close()

# 2) arquivos do instalador
Copy-Item (Join-Path $here 'install.ps1'), (Join-Path $here 'uninstall.ps1') $stage
$out = Join-Path $stage 'MeuPlayer-Setup.exe'
$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$out
FriendlyName=Meu Player
AppLaunched=cmd /c powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File install.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0="install.ps1"
FILE1="uninstall.ps1"
FILE2="meu-player.ico"
[SourceFiles]
SourceFiles0=$stage\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
"@
$sedPath = Join-Path $stage 'setup.sed'
Set-Content -Path $sedPath -Value $sed -Encoding ASCII
& "$env:WINDIR\System32\iexpress.exe" /N /Q $sedPath | Out-Null
$t = 0; while (-not (Test-Path $out) -and $t -lt 60) { Start-Sleep -Milliseconds 500; $t++ }
if (-not (Test-Path $out)) { throw 'O IExpress nao gerou o instalador.' }
Start-Sleep -Seconds 1
Copy-Item -Force $out (Join-Path $dist 'MeuPlayer-Setup.exe')
Write-Host ('Pronto: ' + (Join-Path $dist 'MeuPlayer-Setup.exe'))
