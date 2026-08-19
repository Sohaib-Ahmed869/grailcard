# Boots the full Grailcard stack in three windows. Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1
$root = Split-Path -Parent $PSScriptRoot

foreach ($p in 8100, 8180, 3000) {
    $c = netstat -ano | Select-String ":$p\s.*LISTENING" | Select-Object -First 1
    if ($c) {
        Write-Host "port $p already in use - skipping (stop it first to restart)"
    }
}

if (-not (netstat -ano | Select-String ":8100\s.*LISTENING")) {
    Start-Process powershell -ArgumentList "-NoExit", "-Command",
        "Set-Location '$root\services\vision'; & '.\.venv\Scripts\python.exe' -m uvicorn app.main:app --port 8100"
    Write-Host "vision starting on :8100"
}
if (-not (netstat -ano | Select-String ":8180\s.*LISTENING")) {
    Start-Process powershell -ArgumentList "-NoExit", "-Command",
        "Set-Location '$root\apps\api'; npx tsx src/main.ts"
    Write-Host "api starting on :8180"
}
if (-not (netstat -ano | Select-String ":3000\s.*LISTENING")) {
    Start-Process powershell -ArgumentList "-NoExit", "-Command",
        "Set-Location '$root\apps\web'; npx next dev -p 3000"
    Write-Host "web starting on :3000"
}
Write-Host "open http://localhost:3000 when all three are up"
