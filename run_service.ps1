param (
    [string]$Mode = "basic",
    [int]$Port = 8765
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# Kill any existing processes
Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
foreach ($conn in $connections) {
    if ($conn.OwningProcess) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}

$PyExe = "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
if (-not (Test-Path $PyExe)) {
    $PyExe = (Get-Command python).Source
}

$PyScript = if ($Mode -eq "ai") { "server.py" } else { "serve.py" }
Write-Host "Starting Python server ($PyScript) on port $Port..." -ForegroundColor Cyan

$serverProc = Start-Process -FilePath $PyExe -ArgumentList @("$ScriptDir\$PyScript", "$Port") -WorkingDirectory $ScriptDir -RedirectStandardOutput "$ScriptDir\server.log" -RedirectStandardError "$ScriptDir\server_err.log" -PassThru

Start-Sleep -Seconds 1

if (Test-Path "$ScriptDir\tunnel.log") { Remove-Item "$ScriptDir\tunnel.log" -Force }

Write-Host "Starting Cloudflare tunnel..." -ForegroundColor Cyan
$cfExe = "$ScriptDir\cloudflared.exe"
$tunnelProc = Start-Process -FilePath $cfExe -ArgumentList @("tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$Port") -WorkingDirectory $ScriptDir -RedirectStandardError "$ScriptDir\tunnel.log" -PassThru

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
    Write-Host "`n==========================================================" -ForegroundColor Green
    Write-Host " LIVE PROJECT URL (OPEN ON PHONE OR PC):" -ForegroundColor Green
    Write-Host "   $url" -ForegroundColor Yellow
    Write-Host "==========================================================`n" -ForegroundColor Green
} else {
    Write-Warning "Tunnel URL not found in 30s. Check tunnel.log."
}

# Keep script alive to supervise both processes
while (-not $serverProc.HasExited -and -not $tunnelProc.HasExited) {
    Start-Sleep -Seconds 2
}
Write-Host "A process exited. Terminating."
