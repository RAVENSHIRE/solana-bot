> Das VS-Code-Kommando `Solana: Kleinen Live-Test starten` verwendet jetzt das separate [$5-Micro-Profil](MICRO-CAPITAL.md). Diese Datei beschreibt den erhaltenen Legacy-Starter `start-main-live-test.ps1`; dessen Risikoregeln sind nicht das Micro-Profil.

# Windows-Integration und kleiner Live-Test

Die Integration wurde auf Raven direkt in das bestehende Repository eingespielt. Der vorherige Stand ist im Branch `backup/before-market-data-20260928` erhalten.

- Hauptdashboard (Simulation): http://localhost:3000
- Playbook-Dashboard (Simulation): http://localhost:3001
- Live-Dashboard nach Start der entsprechenden VS-Code-Aufgabe: http://localhost:3002

## Start in VS Code

`Terminal > Aufgabe ausführen` bietet drei Solana-Aufgaben: Verbindung prüfen, kleinen Live-Test starten und Live-Dashboard starten.

Der Live-Starter `start-main-live-test.ps1` fragt das maximale SOL-Guthaben der Testwallet und den SOL-Betrag pro Kauf ab. Er prüft Mainnet, Wallet-Guthaben sowie echte Jupiter-SOL/USDC-Quotes. Erst die Eingabe `LIVE` startet echte Orders. Die Vorprüfung allein signiert und sendet nichts.

Das separate Testprofil verwendet die Hauptstrategie ReversalSniper, eine offene Position und eine aus RPC-Rent sowie konfigurierten Gebühren berechnete Reserve. Nach einem Exit sind weitere Einstiege möglich. Das Tagesverlustlimit blockiert neue Einstiege, garantiert aber keinen Maximalverlust. Strg+C beendet den Prozess und verkauft offene Positionen nicht automatisch. Keine zweite Live-Instanz parallel starten.

Die bestehende `.env` bleibt unverändert. Der Live-Test schreibt nach `data-live-test/state-LIVE.json` und `data-live-test/dashboard-LIVE.json`. Der Starter stellt seine temporären Umgebungsvariablen beim Beenden wieder her. Private Schlüssel bleiben auf dem Rechner.

Das separate 2x/5x-/Phoenix-Playbook bleibt simulationsgebunden. Der Live-Test prüft keine private FOMO-Watchlist und garantiert weder die Verkäuflichkeit einzelner Memecoins noch Profitabilität.

Validiert: Windows-Typecheck, 58 Bot-Tests, 6 Dashboard-Tests, Root-/Playbook-/Dashboard-Build, authentifizierter RPC-/Jupiter-Lesetest, DexScreener/GeckoTerminal/Raydium-Smoke-Test und HTTP/SSE beider Simulationsdashboards. Ein echter Trade wurde nicht ausgeführt.
