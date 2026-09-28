# Reversal Sniper: Playbook – isolierter Paper-Test

Dieses Profil ergänzt den vorhandenen Bot um die angefragte Entry-/Tranche-/Phoenix-Logik. Es verwendet dessen Portfolio, RiskManager und SimulatedExecutor. Der neue Einstiegspunkt ist ausschließlich für Simulation; er lädt keinen Wallet-Schlüssel, baut keine Transaktion und signiert nichts. Das bisherige Strategieprofil wird nicht umgestellt.

## Start unter Windows

Im Projektverzeichnis:

```powershell
.\start-playbook.cmd
```

In einem zweiten Fenster:

```powershell
.\dashboard\start-playbook-dashboard.cmd
```

Dashboard: http://127.0.0.1:3001. Die bisherige Dashboard-Instanz auf Port 3000 kann parallel bleiben.

Alternativ plattformübergreifend:

```sh
npm ci
npm run build:playbook
npm run test:playbook
npm run sim:playbook
```

`RPC_ENDPOINTS` (Solana Mainnet) und `JUPITER_API_KEY` müssen in der vorhandenen `.env` konfiguriert sein. Die RPC-Clusterkennung wird geprüft. Eine Wallet-Adresse oder ein privater Schlüssel ist für dieses Profil nicht erforderlich. `EXECUTION_MODE`, `INITIAL_PAPER_BALANCE_SOL`, `DEFAULT_TRADE_SIZE_SOL` und die vorgeschlagenen Flags `--strategy` / `--mode=simulated` sind keine gültige Konfiguration des bisherigen Bots.

Das Profil setzt nur für seinen eigenen Prozess:

- SIMULATION, 10 SOL Startkapital **nur beim ersten Start**, 0,2 SOL Basis-Input.
- Eigenes Verzeichnis `data-playbook/` mit Portfolio, Telemetrie und Logs.
- Maximal 0,2 SOL Swap-Input pro Position. Bestehende Limits für Gesamt-Exposure, Tagesverlust, Positionsanzahl, Reserve und Fehler-Circuit-Breaker bleiben erhalten. Gebühren und Rent werden zusätzlich gegen Reserve/Exposure geprüft.
- Bestehender Initial-Stop (`RS_STOP_LOSS_PCT`, Standard 12 %) und maximale Haltedauer (`RS_MAX_HOLD_MIN`, Standard 360 Minuten) bleiben als zusätzliche Exits erhalten.
- Bestehender Liquiditätsfilter (`RS_MIN_LIQUIDITY_USD`, Standard 40.000 USD) bleibt erhalten.

Ein Neustart setzt weder Guthaben noch Historie zurück. Eine beschädigte Zustandsdatei führt zum Abbruch. Nach einem Prozessabsturz kann `data-playbook/playbook.lock` liegen bleiben: nur löschen, nachdem sicher feststeht, dass der Prozess beendet ist. Das verhindert zwei gleichzeitige Schreiber.

## Regeln und Daten

| Schritt | Umsetzung |
| --- | --- |
| Initial-Entry | Tatsächliche Market Cap > 0 und < 1 Mio. USD; vorhandene Website-/X-Links; Kauf-Dollarvolumen über 65 % des gesamten 5-Minuten-Volumens |
| Hard Reject | Mint-/Freeze-Authority, gefährliche Token-Erweiterungen, fehlende Prüfdaten oder Top-10-Owner über 25 % |
| 2x | 50 % des ursprünglichen Token-Bestands verkaufen |
| 5x | Weitere 25 % des ursprünglichen Bestands verkaufen; 25 % bleiben, abgesehen von Rundung kleinster Token-Einheiten |
| Direkter Sprung über 5x | Zwei getrennte Verkäufe; jeder Schritt wird erst nach erfolgreichem Paper-Fill persistiert |
| Trailing-Stop | Nach erfolgreichem 2x-Verkauf: gesamter Restbestand bei 20 % Rückgang vom beobachteten Positionshoch |
| Phoenix | Nach vollständigem Ausstieg weiter beobachten; mindestens 80 % unter dem beobachteten Zyklushoch, 30 volle Minuten ohne neues Tief und Kaufvolumen > 1,5 × Verkaufsvolumen |
| Re-Entry | Einmalig 25 % des ursprünglichen SOL-Inputs, als neue Position mit eigenem Einstand/Stop; erneute Sicherheits- und Kapitalprüfung |
| Re-Entry-Stop | 10 % unter dem Einstand der neuen Position. Danach kein weiterer Einstieg in diesem gespeicherten Zyklus |

Sicherheitsprüfungen blockieren niemals Exits. Der 20%-Stop schützt bereits nach dem 2x-Verkauf den dann verbleibenden 50%-Bestand; erst nach 5x sind es 25 %. Stop-Schwellen garantieren keinen Fill exakt am Triggerpreis. Ausfälle, fehlende Routen, Slippage und Impact-Limits können Verkäufe verzögern oder verhindern.

Kursverhältnisse verwenden USD. Der Einstiegskurs wird aus dem Paper-Fill und dem zeitnah beobachteten SOL/USD-Kurs berechnet; P&L und Kapitalgrenzen werden in SOL/Lamports gebucht. Der gespeicherte Höchstkurs ist das seit Beginn der Beobachtung erfasste Hoch, kein verifiziertes historisches Allzeithoch. Gebühren, Teil-Kostenbasis, Rent und kleinste Token-Einheiten werden separat abgerechnet. Jede realisierte Verkaufstranche zählt in der vorhandenen Trade-/Win-Statistik als Trade; das ist keine abgeschlossene Roundtrip-Win-Rate.

## Grenzen der Datenabdeckung

Discovery kombiniert `RS_WATCHLIST` mit aktuellen DEX-Screener-Profilen. Das ist keine vollständige Erfassung jedes Launches. Es wird höchstens ein neuer Entry-Kandidat pro Scan bearbeitet; offene Positionen und ausgestiegene Kandidaten werden unabhängig davon nominal alle 15 Sekunden überwacht. Datenanbieter können diesen Takt verzögern. Maximal 100 persistierte Token-Zyklen pro Testverzeichnis; beim Erreichen werden keine weiteren Token aufgenommen.

DEX-Screener-Kauf-/Verkaufs**anzahlen** werden nicht als Dollarvolumen verwendet. Das Volumen wird aus GeckoTerminal-Trades berechnet und nach tatsächlicher Token-Richtung zugeordnet. Die Antwort muss das gesamte 5-Minuten-Fenster abdecken und einen aktuellen Trade enthalten. Ein abgeschnittener Feed wird abgelehnt. Für Support werden 31 zusammenhängende abgeschlossene Minutenkerzen verlangt; leere Intervalle werden nicht erfunden.

Für die Konzentration werden alle klassischen SPL-Konten des Mints über RPC gelesen und nach Owner summiert. Die Summe muss zum Supply passen. Pool-Vault-Owner werden derzeit **mitgezählt**: das ist konservativ und kann viele Launches ablehnen. Es gibt keine ungeprüfte Pool-Ausnahmeliste. RPC-Anbieter, die diese Abfrage sperren, ergeben einen Ausschluss. Token-2022 wird im Playbook abgelehnt, solange diese vollständige Holder-Erfassung dafür nicht implementiert ist.

Website-/X-Links belegen nur, dass Links vorhanden sind. Sie bestätigen weder echte Unterstützung durch bekannte Personen noch Projektqualität. Unbekannte Scores, Wahrscheinlichkeiten und Gebühren in historischen USD bleiben im Dashboard `--`.

Das frühere Unter-20k-Vorhaben ist ein anderes Profil. `PLAYBOOK_MAX_MCAP_USD=20000` kann die Obergrenze absenken, verändert aber nicht automatisch die Liquiditäts- und Sicherheitsanforderungen. Eine niedrigere Obergrenze ist keine geprüfte Verbesserung der Rendite.

## Journal und Auswertung

`data-playbook/logs/trades-SIMULATION-YYYY-MM-DD.jsonl` enthält erfolgreiche/fehlgeschlagene Paper-Fills einschließlich Kosten und realisiertem P&L. `decisions-YYYY-MM-DD.jsonl` enthält beobachtete Kurse, Ausschlussgründe und vorhandene Entry-Evidenz. Die Dashboard-Telemetrie ist ein begrenzter Laufzeitpuffer und beginnt nach Neustart neu; die Portfolio-Historie und Strategie-Flags bleiben erhalten.

Das ist ein **Live-Vorwärtstest**, kein historischer Backtest und kein Profitabilitätsnachweis. Aussagen über historische $e/acc- oder Jack-Doherty-Trades benötigen konkrete Mint-Adressen, historische Daten ohne Zukunftswissen und ein geprüftes Fill-Modell. Der Simulator verlangt einen frischen zweiten Jupiter-Quote und berücksichtigt Gebühren, geschätzte Priority Fees, Slippage und ATA-Rent. Er bildet nicht sämtliche MEV-/Liquiditätsrisiken einer echten Ausführung nach.

## Validierung und Repository-Hinweis

`npm run build:playbook` baut das neue Profil samt benötigten bestehenden Modulen. Die Tests verwenden ausschließlich synthetische Fixtures; diese Werte gelangen nicht in Laufzeit oder Dashboard.

Die vorhandene Git-Kopie enthält `src/data/dexscreener.ts`, `geckoterminal.ts` und `raydium.ts` des alten Bots nicht. Deshalb ist dessen Gesamt-Build hier bereits unabhängig vom Playbook unvollständig. Das neue Profil hat eigene Datenadapter und einen separaten TypeScript-Build. Die Ignore-Regel wurde von `data/` auf `/data/` eingegrenzt, damit Quellmodule künftig nicht versehentlich ausgeschlossen werden.

Quellen für die verwendeten Schnittstellen: [DEX Screener](https://docs.dexscreener.com/api/reference), [GeckoTerminal](https://api.geckoterminal.com/docs/index.html), [Trade-Daten](https://docs.coingecko.com/reference/pool-trades-contract-address), [OHLCV](https://docs.coingecko.com/reference/pool-ohlcv-contract-address), [Solana getProgramAccounts](https://solana.com/docs/rpc/http/getprogramaccounts), [Jupiter Quotes](https://developers.jup.ag/docs/api-reference/swap/v1/quote).
