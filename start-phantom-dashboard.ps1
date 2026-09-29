$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    Write-Host 'PHANTOM | Lokales Dashboard | Startbudget 10 USD | Standardkauf 2 USD'
    Write-Host 'Startet ohne Handelsfreigabe. Im Browser Phantom verbinden und Live-Session bewusst starten.'
    Write-Host 'Keine privaten Schluessel werden fuer die Phantom-Session aus .env geladen.'
    & npm.cmd ci --include=dev
    if ($LASTEXITCODE -ne 0) { throw 'Engine-Abhaengigkeiten konnten nicht installiert werden.' }
    & npm.cmd run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Typecheck fehlgeschlagen.' }
    $env:DASHBOARD_PORT = '3000'
    & "$PSScriptRoot\dashboard\start-dashboard.cmd"
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard konnte nicht starten. Bei belegtem Port den bestehenden Dashboard-Prozess zuerst stoppen.' }
}
finally { Pop-Location }
