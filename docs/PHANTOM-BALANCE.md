# Phantom im lokalen Dashboard

`http://localhost:3000` startet in **Wallet & live session**. **Market & simulation** enthält die bisherigen Charts und Paper-Ergebnisse. Wallet-Wert, Live-Ledger und Simulation werden getrennt angezeigt.

## Start in VS Code

Die Task **Solana: Kleinen Live-Test starten** ruft `start-phantom-dashboard.ps1` auf. Sie installiert aus den Lockfiles, prüft TypeScript und startet das Dashboard **disarmed**. Einen bereits laufenden Dashboard-Prozess vorher im zugehörigen Terminal stoppen; der Starter beendet keine fremden Prozesse.

1. Dashboard im Browser mit Phantom öffnen und **Connect Phantom** wählen. Dies erstellt eine lokale Sitzung für die ausgewählte öffentliche Adresse. Es fragt noch keine Transaktionssignatur an.
2. Guthaben und angezeigte Blocker prüfen. Das Profil plant 10 USD und standardmäßig 2 USD pro Einstieg. Vor dem ersten Ledger erlaubt die Startprüfung 95–110% des geplanten Budgets, um kleine Kursbewegungen beim Funding abzudecken. Ein bestehender Ledger wird nie automatisch neu basiert.
3. **Start live session** erlaubt der lokalen Engine, Kandidaten zu prüfen. Sie wartet auch bei fehlendem Guthaben; Funding danach kann die nächsten Prüfungen ermöglichen. Erst ein akzeptierter Kandidat erzeugt eine Signaturanfrage. Keine Transaktion ohne alle Gates.
4. Entweder **Review in Phantom** je frischem Swap oder ausdrücklich **Enable Auto-Confirm** freigeben. Der Browser prüft die tatsächlich von Phantom gemeldete Mainnet-Erlaubnis vor automatischem Signieren. Wird Auto-Confirm von der Erweiterung nicht unterstützt oder abgelehnt, bleibt manuelle Bestätigung verfügbar. Das SDK benötigt für `injected` keine App-ID.

Funding allein garantiert keinen Einstieg: Bei einem fehlenden USDC-ATA kann schon dessen gemessene Rent die 1.5%-Kostenregel überschreiten. Es gibt keinen automatischen kostenpflichtigen Setup-Trade und keine heimliche Anhebung des Limits. Auch ohne positives Netto-Roundtrip-Quote bleibt der Bot ohne Auftrag.

## Sitzung und Stop

Authentifizierte Browser-Heartbeats verlängern die lokale Sitzung; nach 15 Minuten ohne solche Aktivität ist eine neue Verbindung erforderlich. Die tatsächliche Phantom-Auto-Confirm-Erlaubnis wird vor jeder automatischen Signatur geprüft und kann unabhängig davon ablaufen. Ein Browser-Heartbeat muss mindestens alle 12 Sekunden eintreffen; Browser-Schließen, Wallet-Wechsel, Ablauf und Disconnect sperren neue Ausführung. Nach einer Heartbeat-Unterbrechung startet die Engine nicht von selbst erneut. Der Stop-Button deaktiviert auch die automatische Signaturanfrage im Browser und versucht, Phantom Auto-Confirm zu widerrufen. Bei Netzproblemen darf dessen Widerruf nicht vorausgesetzt werden; Phantom zeigt die tatsächliche Wallet-Berechtigung.

Stop liquidiert keine Bestände. Bereits broadcastete Transaktionen werden soweit möglich weiter bestätigt und verbucht. Ein unklarer Ausgang hält den Ledger samt Signatur zur Reconciliation an. Niemals diese Datei löschen, um einen Stop zu umgehen.

Die Engine speichert vor Broadcast die geprüfte Signatur dauerhaft. Nachricht, Fee-Payer, Ed25519-Signatur, Quote-Alter, Guthaben, Gebühren und Reserve werden vor Submission erneut geprüft. Der asynchrone Task bleibt bis Settlement/Fehler abgeschlossen ist exklusiv; ein Timeout startet keinen zweiten Task.

## Daten und Zugang

Die Wallet-Anzeige liest native SOL sowie SPL-/Token-2022-Konten über vorhandene RPC-Provider. DexScreener liefert beobachtete USD-Preise. Unbekannte Preise bleiben `--`, unvollständige Portfolios sind als Teilbewertung markiert. Staking, andere Chains und DeFi-Positionen sind kein vollständiger Phantom-Gesamtportfoliowert.

Der Micro-Executor verwaltet nur native SOL und das kanonische USDC-ATA. Andere Tokenkonten sind sichtbar, aber weder Teil seiner Equity noch seiner Orders. Bereits vorhandene USDC werden nicht als vom Bot erworbene Position übernommen.

Die Phantom-Route liest ausschließlich benannte RPC-/Jupiter-Einstellungen aus `.env`; keine Seed Phrase und keinen `WALLET_PRIVATE_KEY`. Provider-Schlüssel bleiben serverseitig. Für Jupiter wird der vorhandene API-Key benötigt. Fehlende Zugänge werden als Fehler angezeigt; kein Provider/Konto wird simuliert.

Loopback-Bindung, Host-/Origin-Prüfung, zufällige lokale Capability und sitzungsgebundene Signaturanfragen schützen die HTTP-Steuerung. Die Capability liegt nur im Seitenspeicher. Sitzungen werden nach einem Serverneustart nicht wieder scharf geschaltet. Die lokale Webseite darf nicht unverändert öffentlich exponiert werden.

Referenz: https://docs.phantom.com/sdks/browser-sdk (SDK 2.0.3; die installierten Typdefinitionen sind maßgeblich).
