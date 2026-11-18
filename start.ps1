param (
    [string]$Mode = "basic"
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir
$Port = if ($env:PORT) { $env:PORT } else { "8765" }

# Stop any running instances first
& "$ScriptDir\stop.ps1"

# Find Python executable
$PyExe = $null
if (Test-Path "$ScriptDir\.venv\Scripts\python.exe") {
    $PyExe = "$ScriptDir\.venv\Scripts\python.exe"
} elseif (Test-Path "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe") {
    $PyExe = "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
} else {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $PyExe = $cmd.Source }
}

if (-not $PyExe) {
    Write-Error "No Python executable found. Please install Python 3.11 or 3.12."
    exit 1
}

$PyScript = if ($Mode -eq "ai") { "server.py" } else { "serve.py" }
Write-Host "Starting AccessAI Lite ($Mode mode) on port $Port..." -ForegroundColor Cyan

# Start Python server
$serverProc = Start-Process -FilePath $PyExe -ArgumentList "`"$ScriptDir\$PyScript`" $Port" -WorkingDirectory $ScriptDir -RedirectStandardOutput "$ScriptDir\server.log" -RedirectStandardError "$ScriptDir\server_err.log" -PassThru -WindowStyle Hidden

Start-Sleep -Seconds 1

# Check cloudflared
$cfExe = "$ScriptDir\cloudflared.exe"
if (-not (Test-Path $cfExe)) {
    $cfCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cfCmd) { $cfExe = $cfCmd.Source }
}

if (-not (Test-Path $cfExe) -and -not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Warning "cloudflared not found. Starting local-only server at http://127.0.0.1:$Port"
    exit 0
}

if (Test-Path "$ScriptDir\tunnel.log") { Remove-Item "$ScriptDir\tunnel.log" -Force }

Write-Host "Starting Cloudflare HTTPS tunnel..." -ForegroundColor Cyan
$tunnelProc = Start-Process -FilePath $cfExe -ArgumentList "tunnel --no-autoupdate --url http://127.0.0.1:$Port" -WorkingDirectory $ScriptDir -RedirectStandardError "$ScriptDir\tunnel.log" -PassThru -WindowStyle Hidden

$url = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path "$ScriptDir\tunnel.log") {
        $log = Get-Content "$ScriptDir\tunnel.log" -Raw
        if ($log -match "(https://[a-zA-Z0-9-]+\.trycloudflare\.com)") {
            $url = $matches[1]
            break
        }
    }
}

if ($url) {
    Set-Content -Path "$ScriptDir\url.txt" -Value $url
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host " LIVE ACCESS LINK (OPEN IN CHROME ON PHONE OR PC):" -ForegroundColor Green
    Write-Host "   $url" -ForegroundColor Yellow
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "Local URL: http://127.0.0.1:$Port"
} else {
    Write-Warning "Tunnel did not produce a URL in 30s. Check tunnel.log."
}
