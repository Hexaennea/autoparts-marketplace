# Deploys the PartPilot TEST site to Google Cloud Run (Mumbai).
#
# Run from the project folder:   .\deploy-test.ps1
#
# - Reads the database and Supabase keys from server\.env and stores them in Google Secret Manager.
#   The keys are never printed and never uploaded with the code.
# - Builds the app on Google Cloud Build and runs it on Cloud Run.
# - Demo mode and test payments stay ON: this is a test site, not the real launch.

param(
  [string]$Project = "partpilot-test-5170",
  [string]$Account = "harsivautotechpvt@gmail.com",
  [string]$Region = "asia-south1",
  [string]$Service = "partpilot"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Invoke-Gcloud {
  # Runs gcloud for the PartPilot project and account; stops the script if it fails.
  $global:LASTEXITCODE = 0
  & gcloud @args --project=$Project --account=$Account --quiet
  if ($LASTEXITCODE -ne 0) { throw "gcloud $($args[0]) $($args[1]) failed (exit $LASTEXITCODE)" }
}

function Test-Secret([string]$name) {
  $ErrorActionPreference = "Continue"
  & gcloud secrets describe $name --project=$Project --account=$Account --format="value(name)" 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Set-Secret([string]$name, [string]$value) {
  # Write the value to a temporary file (no trailing newline), hand it to Secret Manager, delete the file.
  $tmp = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($tmp, $value, (New-Object Text.UTF8Encoding $false))
    if (Test-Secret $name) {
      Invoke-Gcloud secrets versions add $name "--data-file=$tmp" | Out-Null
    } else {
      Invoke-Gcloud secrets create $name "--data-file=$tmp" --replication-policy=automatic | Out-Null
    }
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
  Write-Host "  saved secret $name"
}

# ---- 1. Read server\.env -------------------------------------------------------------------
$envFile = Join-Path $root "server\.env"
if (-not (Test-Path $envFile)) { throw "server\.env not found" }
$cfg = @{}
foreach ($line in Get-Content $envFile) {
  $t = $line.Trim()
  if ($t -eq "" -or $t.StartsWith("#") -or -not $t.Contains("=")) { continue }
  $i = $t.IndexOf("=")
  $k = $t.Substring(0, $i).Trim()
  $v = $t.Substring($i + 1).Trim().Trim('"').Trim("'")
  $cfg[$k] = $v
}
$dbUrl = $cfg["DATABASE_URL"]
$supabaseUrl = ($cfg["SUPABASE_URL"] -replace "/+$", "")
$supabaseKey = $cfg["SUPABASE_SECRET_KEY"]
if (-not $supabaseKey) { $supabaseKey = $cfg["SUPABASE_SERVICE_ROLE_KEY"] }
$bucket = $cfg["PARTPILOT_MEDIA_BUCKET"]; if (-not $bucket) { $bucket = "media" }
if (-not $dbUrl -or $dbUrl -match "localhost|127\.0\.0\.1") { throw "DATABASE_URL in server\.env must be the Supabase address" }
if (-not $supabaseUrl -or -not $supabaseKey) { throw "SUPABASE_URL and SUPABASE_SECRET_KEY must be set in server\.env" }
Write-Host "1/4 Read server\.env (values hidden)"

# ---- 2. Secrets ------------------------------------------------------------------------------
Write-Host "2/4 Saving keys in Google Secret Manager"
Set-Secret "pp-database-url" $dbUrl
Set-Secret "pp-supabase-secret-key" $supabaseKey
if (-not (Test-Secret "pp-session-secret")) {
  # Random 64-character signing key for logins; created once so re-deploys don't sign everyone out.
  $bytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  Set-Secret "pp-session-secret" ([Convert]::ToBase64String($bytes))
}

# The Cloud Run app runs as the project's default compute account: let it read the secrets and build.
$number = (& gcloud projects describe $Project --account=$Account --format="value(projectNumber)").Trim()
$runAccount = "$number-compute@developer.gserviceaccount.com"
foreach ($s in "pp-database-url", "pp-supabase-secret-key", "pp-session-secret") {
  Invoke-Gcloud secrets add-iam-policy-binding $s "--member=serviceAccount:$runAccount" --role=roles/secretmanager.secretAccessor | Out-Null
}
Invoke-Gcloud projects add-iam-policy-binding $Project "--member=serviceAccount:$runAccount" --role=roles/run.builder --condition=None | Out-Null

# ---- 3. Build and deploy ---------------------------------------------------------------------
Write-Host "3/4 Building and deploying (takes 5-10 minutes the first time)"
$envVars = @(
  "PARTPILOT_DEMO_MODE=true",
  "PARTPILOT_PAYMENTS_TEST_MODE=true",
  "PARTPILOT_TRUST_PROXY=true",
  "PARTPILOT_DB_SSL=require",
  "PARTPILOT_DB_POOL_MAX=5",
  "SUPABASE_URL=$supabaseUrl",
  "PARTPILOT_MEDIA_BUCKET=$bucket"
) -join ","
$secrets = "DATABASE_URL=pp-database-url:latest,SUPABASE_SECRET_KEY=pp-supabase-secret-key:latest,PARTPILOT_SECRET_KEY=pp-session-secret:latest"
Invoke-Gcloud run deploy $Service --source . --region=$Region --port=8000 --allow-unauthenticated `
  --memory=512Mi --cpu=1 --min-instances=0 --max-instances=1 `
  "--set-env-vars=$envVars" "--set-secrets=$secrets"

# ---- 4. Tell the app its own address ---------------------------------------------------------
$url = (& gcloud run services describe $Service --region=$Region --project=$Project --account=$Account --format="value(status.url)").Trim()
Invoke-Gcloud run services update $Service --region=$Region "--update-env-vars=PARTPILOT_PUBLIC_URL=$url" | Out-Null
Write-Host "4/4 Done"
Write-Host ""
Write-Host "Test site: $url" -ForegroundColor Green
