param([decimal]$BudgetSol = 0, [decimal]$TradeSol = 0, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Read-Sol([string]$Prompt) {
    $value = (Read-Host $Prompt).Replace(',', '.')
    return [decimal]::Parse($value, [Globalization.CultureInfo]::InvariantCulture)
}

if ($BudgetSol -le 0) { $BudgetSol = Read-Sol 'Maximales SOL-Guthaben der separaten Testwallet' }
if ($TradeSol -le 0) { $TradeSol = Read-Sol 'SOL pro Kauf (zusaetzliche Gebuehrenreserve erforderlich)' }
if ($TradeSol -lt 0.001 -or $BudgetSol -le $TradeSol) {
    throw 'Kauf muss mindestens 0.001 SOL sein; Gesamtbudget muss groesser sein.'
}

$values = @{
    SIMULATION_MODE = 'false'
    LIVE_TRADING_CONFIRMED = 'I_UNDERSTAND_THE_RISKS'
    LIVE_TEST_BUDGET_SOL = $BudgetSol.ToString([Globalization.CultureInfo]::InvariantCulture)
    RS_TRADE_SIZE_SOL = $TradeSol.ToString([Globalization.CultureInfo]::InvariantCulture)
    SUTR_ARB_SIZE_SOL = $TradeSol.ToString([Globalization.CultureInfo]::InvariantCulture)
    RISK_MAX_POSITION_SOL = $TradeSol.ToString([Globalization.CultureInfo]::InvariantCulture)
    RISK_MAX_TOTAL_EXPOSURE_SOL = $TradeSol.ToString([Globalization.CultureInfo]::InvariantCulture)
    RISK_MAX_DAILY_LOSS_SOL = $TradeSol.ToString([Globalization.CultureInfo]::InvariantCulture)
    RISK_MAX_OPEN_POSITIONS = '1'
    SUTR_ENABLED = 'false'
    SUTR_LP_SIM_ENABLED = 'false'
    SUTR_RENT_RECLAIM_ENABLED = 'false'
    RS_ENABLED = 'true'
    PRE_SIMULATE_TX = 'true'
    STATE_DIR = './data-live-test'
    LOG_DIR = './logs/live-test'
}
$saved = @{}
foreach ($key in $values.Keys) {
    $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    [Environment]::SetEnvironmentVariable($key, $values[$key], 'Process')
}
$saved['RISK_MIN_SOL_RESERVE'] = [Environment]::GetEnvironmentVariable('RISK_MIN_SOL_RESERVE', 'Process')
try {
    & npm.cmd run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Typecheck fehlgeschlagen.' }
    & npm.cmd run live:check
    if ($LASTEXITCODE -ne 0) { throw 'Live-Vorpruefung fehlgeschlagen; nichts gesendet.' }
    $report = Get-Content './data-live-test/live-preflight.json' -Raw | ConvertFrom-Json
    $env:RISK_MIN_SOL_RESERVE = ([decimal]$report.reserveSol).ToString([Globalization.CultureInfo]::InvariantCulture)
    Write-Host "Wallet: $($report.wallet) | Guthaben: $($report.balanceSol) SOL | Kauf: $TradeSol SOL"
    Write-Host 'Hauptstrategie ReversalSniper; maximal eine offene Position. Nach einem Exit sind weitere Einstiege moeglich.'
    Write-Host 'Das Tageslimit sperrt neue Einstiege, garantiert aber keinen Maximalverlust. Strg+C beendet den Bot, verkauft offene Positionen nicht.'
    if ($CheckOnly) { return }
    if ((Read-Host 'Echte Orders erlauben? Zum Start exakt LIVE eingeben') -cne 'LIVE') { return }
    & node --import tsx src/index.ts
    if ($LASTEXITCODE -ne 0) { throw 'Live-Bot beendet; Log pruefen.' }
}
finally {
    foreach ($key in $saved.Keys) {
        [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process')
    }
}
