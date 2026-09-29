# $5 Micro-Capital-Profil

Dieses separate Profil verwendet die vorhandenen Jupiter-, RPC- und DexScreener-Clients. Es verändert weder die Hauptstrategie noch das 2x/5x/Phoenix-Playbook. Ein Live-Handel wurde bei der Implementierung nicht ausgeführt. Das Profil ist ein überprüfbarer Prototyp mit Ausführungssperren, kein Nachweis einer profitablen oder produktionsreifen Strategie.

## Start in VS Code unter Windows

1. `Solana: Verbindung und Live-Voraussetzungen pruefen` prüft Mainnet, die bestehende lokale Wallet, tatsächliche USD-Kurse, Balance, Rent und einen Jupiter-Quote. Es wird keine Transaktion gebaut, signiert oder gesendet. Ein erfolgreicher Check garantiert keinen handelbaren Kandidaten.
2. `Solana: Micro-Dashboard starten` öffnet den lokalen Server auf `http://localhost:3002`. Die Webseite im Browser öffnen. Sie liest `data-micro/active-dashboard.json` und folgt dadurch LIVE oder SIMULATION.
3. `Solana: Micro-Simulation starten` beobachtet echte Quotes mit einem getrennten virtuellen Buch. Für echtes Handeln startet **der Benutzer** `Solana: Kleinen Live-Test starten` und bestätigt im Terminal `LIVE`. Standard: Budget $5, Kaufwunsch $1. Der tatsächliche Betrag wird bei jeder Entscheidung aus aktuellen Kursen berechnet.

Die Starter ändern nur Prozessvariablen; `.env` und vorhandene Portfolios bleiben erhalten. `start-main-live-test.ps1` bewahrt den bisherigen SOL-basierten Starter. Dieser gehört nicht zum Micro-Profil und besitzt dessen zusätzliche Gates nicht. Nicht gleichzeitig zwei Live-Engines mit derselben Wallet betreiben.

## Wallet und Zugang

Der vorhandene Executor verwendet einen **lokalen Keypair-Signer** aus der bestehenden Wallet-Konfiguration. Er verbindet keine Phantom-Browser-Session. Ob die konfigurierte Wallet auch in Phantom angezeigt wird, ist davon unabhängig. Geheimnisse bleiben lokal; keine Seed Phrase oder privaten Schlüssel in Chat oder Git einfügen.

Das Dashboard besitzt jetzt eine native, rein lesende Phantom-Verbindung: `Connect Phantom` übernimmt die öffentliche Solana-Adresse und zeigt RPC-Balances an. Auto-Confirm und ein Phantom-Signer für den Trading-Executor sind weiterhin **nicht implementiert**. Die offizielle Browser-SDK-Dokumentation unterstützt `injected` ohne App-ID; Auto-Confirm ist für die Browser-Erweiterung vorgesehen. Dafür sind die tatsächliche Erweiterung, eine vom Nutzer freigegebene Session und eine signierte Rückgabe an den lokalen Executor erforderlich. Kein Phantom-Konto/App-ID wurde erfunden oder angelegt. Der lokale Signer wird nicht als Phantom-Auto-Confirm ausgegeben.

Vor dem ersten Lauf muss die tatsächliche Gesamtbewertung der separaten SOL/USDC-Testwallet innerhalb des gewählten Budgets und mindestens bei $3.50 liegen. Bereits erwirtschaftete Gewinne dürfen das Startbudget übersteigen; ein vorhandener Ledger muss dazu passen. Andere finanzierte Token oder USDC in zusätzlichen Nicht-ATA-Konten führen zum Abbruch, weil ihre Bewertung/Verwaltung nicht Teil dieses Profils ist. Vorhandene Wallet-Bestände werden nicht als Bot-Handelserfolg verbucht.

## Ausführung und Kosten

- Eine serielle Schleife prüft alle 15 Sekunden. Pro Wallet/Modus/State-Verzeichnis verhindert ein exklusiver Prozess-Lock einen zweiten Micro-Prozess. Der Lock ersetzt keinen systemweiten Schutz vor anderen Programmen, die dieselbe Wallet verwenden.
- Nur SOL/USDC. BUY verlangt einen frischen Rückverkaufsquote für den minimalen Kauf-Output. Dessen minimaler SOL-Output muss Input, beide geschätzten Netzwerkgebühren und neue ATA-Rent übersteigen. Fees in Jupiter-Routen sind bereits im Output enthalten. Zusätzlich wird negative Abweichung vom USD-Referenzwert konservativ als Spread berücksichtigt.
- **Das sind zwei aufeinanderfolgende Swaps, keine atomare Arbitrage.** Der Rückverkaufsquote ist ein Kandidatenfilter, kein statistisch geschätzter EV und keine garantierte Exit-Ausführung. Der Exit wird bei der nächsten Schleife neu quotiert. Ein Kosten-/Reserve-Gate kann ihn blockieren; die Position bleibt dann sichtbar und wird später erneut geprüft. Es gibt keine erzwungene Liquidation, die Limits umgeht.
- Neue Käufe liegen zwischen $1 und $1.50 sowie 20–30% der beobachteten Equity. Bei unvereinbaren Grenzen wird nicht gehandelt. Bestehende Positionen werden vollständig geschlossen; Reinvestition folgt erst danach.
- Mindestens 0.003 SOL native Reserve. Vor dem Bau werden zusätzlich Input, Gebühren, erforderliche neue ATA-Rent und konservativ zwei temporäre Token-Account-Rentbeträge reserviert. RPC-Simulation prüft vor der Signatur die projizierten Wallet-/USDC-Bestände. 0.003 SOL ist eine gewählte Betriebsreserve, keine allgemeine Solana-Rentkonstante.
- Maximal 1.5% gesamte konservative Kosten pro Roundtrip, bezogen auf den ursprünglichen Kaufwert. Priority Fee, Basisgebühr, Slippage, negativer Spread und neue permanente ATA-Rent zählen mit. Der Exit verbraucht nur das verbleibende USD-Kostenbudget, auch bei geändertem SOL-Preis.
- Rent wird über `getMinimumBalanceForRentExemption` gelesen. Fehlende ATA-Konten werden nicht pauschal als billig oder kostenlos behandelt. Eine neue ATA ist nur bei erfülltem Kostenlimit **und** positivem Netto-Roundtrip zulässig. Bei einem $1-Trade kann schon Rent diesen Test scheitern lassen; dann bleibt der Bot ohne Kauf.
- Priorität: frische RPC-Stichprobe, auf das verbleibende Budget und die vorhandene Jupiter-Maximalgebühr begrenzt. Anschließend wird `getFeeForMessage` für die tatsächlich gebaute Message geprüft. Leere oder fehlende Daten sind keine Nullgebühr.
- Slippage maximal 30 bps je Quote. Kein automatisches Erhöhen, kein separater Rent-Reclaim und keine Account-Close-Transaktion im Micro-Executor. Aktuelle Quotes, Preisalter, Identität, Simulation und Kosten müssen vor der Signatur bestehen. Signieren ist noch keine Übermittlung; die Signatur wird vor dem Broadcast dauerhaft gespeichert.

Reservierte temporäre Rent ist gebundenes Kapital, nicht automatisch eine endgültig gezahlte Gebühr. Eine Simulation kann trotzdem keine Ausführung garantieren. Fehlgeschlagene gesendete Transaktionen können Kosten verursachen; bei unklarem oder gescheitertem Abschluss wird der Ledger gesperrt und nicht durch neue Käufe fortgesetzt.

## Kill Switch, Neustart und Abgleich

Unter $3.50 Equity oder unter der nativen Reserve wird LIVE gesperrt. Auch unerklärte Balanceänderungen und offene Transaktions-Intents sperren LIVE. Über den PowerShell-Starter führt Exit-Code 75 zur getrennten Micro-Simulation; das Dashboard auf 3002 folgt der aktiven Datei. Haupt-Dashboard 3000 und Playbook 3001 bleiben eigenständig.

Ein Stop verkauft keine offene Position. Nach dem Senden kann eine Transaktion trotz Prozessende noch bestätigt werden. `micro-LIVE.json` enthält die Pending-Signatur für den Abgleich gegen RPC/Explorer. Ein beschädigter Ledger, unbekannte Bestände oder ein alter Lock werden **nicht** automatisch gelöscht oder zurückgesetzt. Erst laufende Prozesse und die konkrete Transaktion prüfen; dann kann gezielt abgeglichen werden. Automatisierte Reconciliation/Phantom-Wiederverbindung sind noch offen.

Wer `npm run micro:live` direkt startet, erhält bei einem Halt Exit-Code 75 und muss die Simulation separat starten. Der automatische Moduswechsel gehört zum PowerShell-Starter. Ein bereits gesperrtes Simulationsbuch wird ebenfalls nicht still zurückgesetzt.

## Messwerte und CLOUD READY

`micro-LIVE.json` und `micro-SIMULATION.json` halten getrennte Positionen, Kosten, bestätigte Signaturen, geschlossene Roundtrips und Performance. Dashboard-Werte entstehen aus Beobachtungen/Buchungen; unbekannte Konfidenz, RPC-Latenz und Safety-Scores bleiben `null`/`--`. Kurs- und Equity-Verläufe sind beobachtete Samples, keine erfundenen historischen Daten. Historische USD-Gewinne werden nicht mit dem neuesten SOL-Kurs rückwirkend umgerechnet.

Quotes, Beobachtungen, Entscheidungen und Fills werden bei aktiviertem `DATA_HISTORY_ENABLED` unter `data-micro/history` aufgezeichnet. Die vorhandenen Größen-/Aufbewahrungsgrenzen gelten. Der kompakte Ledger speichert bis zu 10.000 Fills; dann stoppt das Profil, statt Kennzahlen unbemerkt durch Abschneiden zu verfälschen.

`CLOUD READY` erfordert ausschließlich im LIVE-Ledger:

- mindestens 30 vollständig geschlossene Roundtrips;
- mehr als 20% realisierten Netto-Tradinggewinn relativ zur tatsächlich gemessenen Start-Equity;
- aktuelle Equity mindestens $6;
- keine offene Position, keine ungeklärte Transaktion, keine externe Balanceänderung und keinen bekannten Guardrail-Verstoß.

Das ist ein Review-Meilenstein. Es erfolgt kein Docker/AWS-Deployment. 30 Trades und 20% Rendite belegen allein keinen statistischen Edge. Dafür fehlen unter anderem ausreichend unabhängige Out-of-Sample-Beobachtungen, Robustheit über Marktregime und eine Prüfung von Selektionsbias/Ausführungsrisiken. Das verlinkte Medium-Konzept liefert keinen solchen Nachweis für diese konkrete Solana-Strategie.

## Konsolenausgabe

Zeitstempel + `[CHECK]`, `[START]`, `[SKIP]`, `[BUY]`, `[SELL]`, `[HALT]` oder `[CLOUD READY]`, ergänzt um tatsächlich bekannte Felder. Zugangsdaten werden redigiert. PAPER-Fills werden ausdrücklich als `SIMULATION`/`PAPER` gekennzeichnet.

## Technische Quellen

- Phantom Browser SDK: https://docs.phantom.com/sdks/browser-sdk
- Solana Gebühren: https://solana.com/docs/core/fees
- Solana RPC Rent: https://solana.com/docs/rpc/http/getminimumbalanceforrentexemption
- Jupiter Swap-Vertrag des bestehenden Clients: https://dev.jup.ag/api-reference/swap/swap
