param([decimal]$BudgetUsd = 10, [decimal]$BuyUsd = 2, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
$saved = @{}
try {
    if ($BudgetUsd -lt 5 -or $BudgetUsd -gt 10 -or $BuyUsd -lt ($BudgetUsd * 0.2) -or $BuyUsd -gt ($BudgetUsd * 0.3)) {
        throw 'Micro-Profil: Budget 5-10 USD; Kauf 20-30% des Budgets.'
    }
    $values = @{
        MICRO_BUDGET_USD = $BudgetUsd.ToString([Globalization.CultureInfo]::InvariantCulture)
        MICRO_TRADE_USD = $BuyUsd.ToString([Globalization.CultureInfo]::InvariantCulture)
        MICRO_STATE_DIR = './data-micro'
        LIVE_TRADING_CONFIRMED = ''
    }
    foreach ($key in $values.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $values[$key], 'Process')
    }
    & npm.cmd run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Typecheck fehlgeschlagen.' }
    & npm.cmd run micro:check
    if ($LASTEXITCODE -ne 0) { throw 'Micro-Vorpruefung fehlgeschlagen; keine Transaktion gesendet.' }
    Write-Host "MICRO | Budget $BudgetUsd USD | Kauf $BuyUsd USD | Reserve 0.003 SOL | Kostenlimit 1.5%"
    Write-Host 'Signer: lokaler Wallet-Schluessel aus .env. Keine Phantom-Browserverbindung.'
    Write-Host 'SOL/USDC: Kauf nur bei positivem Netto-Roundtrip-Quote. Zwei separate Swaps, kein garantierter Arbitragegewinn.'
    Write-Host 'Strg+C stoppt neue Arbeit; eine bereits gesendete Transaktion kann noch landen. Kein automatischer Verkauf beim Stop.'
    if ($CheckOnly) { return }
    if ((Read-Host 'Echte Orders erlauben? Zum Start exakt LIVE eingeben') -cne 'LIVE') { return }
    $env:LIVE_TRADING_CONFIRMED = 'I_UNDERSTAND_THE_RISKS'
    & npm.cmd run micro:live
    $microExit = $LASTEXITCODE
    $env:LIVE_TRADING_CONFIRMED = ''
    if ($microExit -eq 75) {
        Write-Host 'HALT | Live-Ledger gesperrt. Wechsel zur getrennten Micro-Simulation.' -ForegroundColor Yellow
        Write-Host 'Das Micro-Dashboard auf Port 3002 zeigt nach dem naechsten Snapshot SIMULATION.'
        & npm.cmd run micro:sim
        if ($LASTEXITCODE -ne 0) { throw 'Simulation beendet; Log pruefen.' }
    }
    elseif ($microExit -ne 0) { throw 'Micro-Prozess beendet. Kein automatischer Live-Neustart; Log pruefen.' }
}
finally {
    foreach ($key in $saved.Keys) {
        [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process')
    }
    Pop-Location
}
