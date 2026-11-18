# Stop existing processes
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$port = 8765
$connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
foreach ($conn in $connections) {
    if ($conn.OwningProcess) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}
Write-Host "AccessAI Lite stopped."
