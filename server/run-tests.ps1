# Runs the server tests on the LOCAL PostgreSQL (never Supabase).
# Uses the postgres superuser password from server\.env.pgsuper; the password is never printed.
#
#   .\run-tests.ps1                      all tests
#   .\run-tests.ps1 tests\invoices.test.ts   one file

param([string[]]$Files = @("tests/*.test.ts"))

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
$line = Get-Content ".env.pgsuper" | Where-Object { $_ -like "PG_SUPERUSER_PASSWORD=*" } | Select-Object -First 1
if (-not $line) { throw "PG_SUPERUSER_PASSWORD not found in server\.env.pgsuper" }
$pw = [uri]::EscapeDataString($line.Substring($line.IndexOf("=") + 1).Trim())
$env:TEST_DATABASE_URL = "postgres://postgres:$pw@localhost:5432/partpilot_test"
npx.cmd tsx --test --test-concurrency=1 @Files
exit $LASTEXITCODE
