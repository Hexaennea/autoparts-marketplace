# PartPilot - one-command local start on Windows (PowerShell 5.1 or 7+).
#
#   Double-click start-windows.cmd, or run:  .\start-windows.ps1
#   Options:  -Reset   rebuild the demo database from scratch
#             -Port N  serve on another port (default 8000)
#
# Needs: Node.js 22+ and PostgreSQL 17 running locally, with server\.env holding DATABASE_URL
# (see server\.env.example). First run installs Node packages, builds the UI and seeds the
# demo database. Later runs skip whatever is already done.

param(
    [switch]$Reset,
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Server = Join-Path $Root "server"
$Frontend = Join-Path $Root "frontend"

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ""; Write-Host "X  $text" -ForegroundColor Red; exit 1 }

# ---- 1. Node 22+ -------------------------------------------------------------------------
Step "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js 22+ was not found. Install it from https://nodejs.org/ and run this again." }
$nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]"))
if ($nodeMajor -lt 22) { Fail "Node.js 22+ is needed (found $nodeMajor). Update it from https://nodejs.org/." }
Write-Host ("   using: node " + (& node --version))

# ---- 2. PostgreSQL + settings ------------------------------------------------------------
Step "Checking PostgreSQL"
$EnvFile = Join-Path $Server ".env"
if (-not (Test-Path $EnvFile)) {
    Fail "server\.env is missing. Copy server\.env.example (local) or server\supabase.env.example (Supabase) to server\.env."
}
# A DATABASE_URL pointing at another machine (e.g. Supabase) needs no local PostgreSQL service.
$dbLine = Select-String -Path $EnvFile -Pattern '^\s*DATABASE_URL\s*=' | Select-Object -First 1
$isLocalDb = (-not $dbLine) -or ($dbLine.Line -match '@(localhost|127\.0\.0\.1|\[::1\])[:/]')
if ($isLocalDb) {
    $pg = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $pg) { Fail "PostgreSQL was not found. Install it with:  winget install -e --id PostgreSQL.PostgreSQL.17" }
    if ($pg.Status -ne "Running") { Fail "The PostgreSQL service ($($pg.Name)) is not running. Start it from Services." }
    Write-Host "   using: $($pg.Name)"
} else {
    Write-Host "   using: remote database from server\.env"
}

# ---- 3. Packages -------------------------------------------------------------------------
foreach ($dir in @($Server, $Frontend)) {
    if (-not (Test-Path (Join-Path $dir "node_modules"))) {
        Step "Installing packages in $(Split-Path $dir -Leaf)"
        Push-Location $dir
        try { & npm.cmd install --no-audit --no-fund } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { Fail "npm install failed (see the messages above)." }
    }
}

# ---- 4. Build the web app ----------------------------------------------------------------
Step "Building the web app"
Push-Location $Frontend
try { & npm.cmd run build } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Fail "The web build failed (see the messages above)." }

# ---- 5. Database ---------------------------------------------------------------------------
Push-Location $Server
try {
    if ($Reset) {
        Step "Rebuilding the demo database"
        & npm.cmd run seed:reset
    } else {
        Step "Applying database migrations"
        & npm.cmd run migrate
        if ($LASTEXITCODE -eq 0) {
            Step "Adding demo data if the database is empty"
            & npm.cmd run seed -- --if-empty
        }
    }
} finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Fail "Database setup failed (see the messages above)." }

# ---- 6. Run -------------------------------------------------------------------------------
$Url = "http://localhost:$Port"
Step "Starting PartPilot on $Url  (press Ctrl+C to stop)"
Write-Host "   Shopper  priya@partpilot.test               Demo@12345"
Write-Host "   Seller   lakshmi.autospares@partpilot.test  Demo@12345"
Write-Host "   Admin    admin@partpilot.test               Admin@12345"
Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", "Start-Sleep -Seconds 4; Start-Process '$Url'"
$env:PORT = "$Port"
Push-Location $Server
try { & npm.cmd run dev } finally { Pop-Location }
