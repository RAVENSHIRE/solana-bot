# Micro-Capital: 10-USD-Profil

Das lokale Phantom-Dashboard verwendet die vorhandenen Jupiter-, RPC- und DexScreener-Clients. Die Hauptstrategie und das 2×/5×/Phoenix-Playbook bleiben eigenständige Simulationen. Dieses Profil ist ein guarded Live-Prototyp; keine beobachtete Profitabilität oder produktionsreife 24/7-Verfügbarkeit wird behauptet.

Start und Phantom-Freigaben: [PHANTOM-BALANCE.md](PHANTOM-BALANCE.md).

## Handelsregeln

- Standardbudget 10 USD, Standard-Einstieg 2 USD. Neue Orders liegen im 20–30%-Band der kleineren Größe aus aktueller Equity und Startbudget. Ein größeres Wallet erhöht die Ordergrenze nicht. Legacy-CLI-Profile mit 5 USD sind weiterhin ausdrücklich möglich.
- Nur SOL/USDC. BUY benötigt einen frischen Rückverkaufsquote für den minimalen Kauf-Output. Minimaler Rückfluss muss Input, beide geschätzten Netzwerkgebühren und neue ATA-Rent übersteigen. Das ist ein Filter aus Quotes, kein statistischer Erwartungswert.
- Zwei sequenzielle Swaps sind keine atomare Arbitrage. Exit-Quote und Ausführung können sich ändern. Ein Kosten-/Reserve-Gate darf einen Exit blockieren; die Position bleibt offen sichtbar. Kein Zwangsverkauf umgeht die Limits.
- Native Reserve mindestens 0.003 SOL. Input, tatsächliche Netzwerkgebühr, permanente ATA-Rent und konservativ zwei temporäre Account-Rentbeträge müssen zusätzlich verfügbar sein. Die Reserve ist ein Betriebsparameter, keine allgemeine Rent-Konstante.
- Maximal 1.5% konservativer Roundtrip-Drag, bezogen auf den ursprünglichen Kaufwert in USD: Basis-/Priority-Gebühr, Slippage, negativer Spread und neue permanente ATA-Rent. Der Exit hat nur das verbleibende USD-Budget. Rent wird über RPC gemessen, niemals als fester Marktwert erfunden.
- Prioritätsgebühr aus frischen RPC-Stichproben, begrenzt durch Kostenbudget und vorhandenes Jupiter-Maximum. Vor Signatur wird `getFeeForMessage` der tatsächlichen Message geprüft. Fehlende Daten gelten nicht als Nullgebühr.
- Maximal 30 bps Slippage pro Quote. Kein automatisches Erhöhen, kein Rent-Reclaim und kein Account-Close außerhalb der Swap-Gates. Unsigned RPC-Simulation muss die erwarteten Wallet-/USDC-Minima erhalten.

Ein Ledger startet erst nach Funding und explizitem Arm. Die 30%-Verlustgrenze bezieht sich anschließend auf die tatsächliche Startbewertung, z.B. 7 USD bei exakt 10 USD Start. Die Grenze bleibt nach Neustart erhalten. Bei Kill Switch stoppt Live-Ausführung, die Oberfläche meldet HALTED und bleibt mit der getrennten Simulation zugänglich. Sie erfindet keinen weiterlaufenden Simulationsprozess.

## Persistenz und Wiederanlauf

`data-micro/micro-LIVE.json` und `micro-SIMULATION.json` sind getrennte Bücher. Eine serielle Engine und ein exklusiver Lock pro Ledger/Modus/State-Verzeichnis verhindern überlappende Micro-Tasks, auch bei unterschiedlichen Wallets auf mehreren Dashboard-Ports. Ältere Versionen mit Wallet-spezifischen Locks müssen vor dem Update beendet werden. Andere Programme oder State-Verzeichnisse werden dadurch nicht systemweit kontrolliert. Nicht mehrere Live-Bots mit derselben Wallet betreiben.

Ledger-Version 2 speichert das Profil. Version 1 wird ohne Verlust der Baseline, Historie, Halts oder Pending-Signaturen migriert; ihr bisheriger Startwert bestimmt ihr Profil. Eine neue 10-USD-Voreinstellung setzt ein altes Buch nicht zurück. Fehlerhafte Dateien, unerklärte Balanceänderungen und unklare Transaktionen bleiben gesperrt, bis sie nachvollziehbar abgeglichen sind.

Ein fehlender Quote schreibt keine Position ab. Bekannte Fehler vor dem Senden geben die noch unsignierte Absicht frei. Nach dauerhaft gespeicherter Signatur oder unbekanntem Broadcast-Ausgang erfolgt kein automatischer Ersatzauftrag. Ein Stop verkauft keine Position und macht einen Broadcast nicht rückgängig.

## Legacy-CLI

`start-live-test.ps1` und die ausdrücklich als **Legacy** markierten Tasks verwenden weiterhin den lokalen Keypair-Signer. Der Standard ist jetzt 10 USD / 2 USD; 5 USD / 1 USD kann als Parameter gewählt werden. Diese Befehle verbinden keine Browser-Wallet. Der alte SOL-basierte `start-main-live-test.ps1` gehört nicht zu diesem Profil.

## Messwerte und VPS-Meilenstein

Kennzahlen entstehen aus beobachteten Balances und bestätigten Fills. Nicht gemessene Analytics bleiben `null`/`--`. Reale Kosten, Positionen und Signaturen bleiben im Ledger erhalten. Der CLI-History-Recorder und die bestehende Telemetrie bleiben verfügbar; die Phantom-Oberfläche zeigt ihren eigenen Live-Ledger über die Session-API.

`CLOUD READY` erfordert mindestens 30 geschlossene Live-Roundtrips, mehr als 20% realisierten Netto-Tradinggewinn, aktuelle Equity mindestens 120% der gemessenen Baseline und keine offene Position, ungeklärte Transaktion, externe Balanceänderung oder bekannte Guardrail-Verletzung. Es ist ein Review-Meilenstein, kein Nachweis statistischen Edges und kein automatisches Deployment.

VPS-Plan: [VPS-V2.md](VPS-V2.md).
