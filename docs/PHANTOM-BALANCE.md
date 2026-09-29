# Phantom-Balance im lokalen Dashboard

Dashboard: `http://localhost:3000`. Der Bereich **Wallet balance** steht getrennt von den simulierten Handelskennzahlen. Native SOL sowie finanzierte SPL- und Token-2022-Konten werden über den bestehenden Mainnet-RPC gelesen. Die Anzeige aktualisiert sich alle 15 Sekunden. Preise kommen aus dem bestehenden DexScreener-Client; dadurch kann die USD-Schätzung von der Anzeige in Phantom abweichen. Stake-Konten, andere Chains, NFTs ohne handelbare Preisquelle und DeFi-Positionen sind kein vollständiger Phantom-Gesamtportfoliowert.

**Connect Phantom** im Browser mit der Phantom-Erweiterung übernimmt dessen ausgewählte öffentliche Solana-Adresse. Eine einmalig freizugebende Verbindung fragt keine Signatur an. Bereits freigegebene Verbindungen werden mit `onlyIfTrusted` wiederhergestellt; Account-Wechsel aktualisieren den Monitor. Der Monitor kann weder signieren noch senden und ändert nicht die Wallet des Trading-Executors.

Ohne Browser-Verbindung zeigt der Monitor die konfigurierte öffentliche Adresse mit entsprechendem Hinweis. Für diese Anzeige werden nur `RPC_ENDPOINTS` und `WALLET_PUBLIC_KEY` aus der lokalen Konfiguration verwendet; kein Wallet-Privatschlüssel wird geparst. RPC-Zugangsdaten bleiben im Server.

Die lokale Datei `data/wallet-monitor.json` kann `address` und `plannedStartUsd` enthalten. Auf Raven steht das geplante Startkapital entsprechend der aktuellen Planung auf **10 USD**. Das ist eine Planung, kein künstlich auf $10 gesetzter Saldo und keine Erhöhung der Kauf- oder Verlustlimits. Das vorhandene $5-Micro-Profil behält seine eigenen Ausführungslimits, bis ein geändertes Handelsprofil ausdrücklich festgelegt wird.

Fehlende Tokenpreise bleiben `--`; dann wird nur ein ausdrücklich als **subtotal** gekennzeichneter Teilwert angezeigt. Ein Ausfall eines Token-RPC verhindert eine vollständige Portfoliobewertung. Ein Ausfall der Preisquelle löscht nicht die gemessenen Tokenmengen. Ein fehlgeschlagener Balance-Refresh wird als Fehler angezeigt statt als neuer Nullsaldo.

Die Wallet-API ist wie das Dashboard nur an Loopback gebunden und akzeptiert ausschließlich lesende HTTP-Methoden. `GET /api/wallet?address=<öffentliche Solana-Adresse>` liest diese Adresse; ohne Parameter gilt die lokale Voreinstellung. Kein neuer Provider, keine zusätzliche Kontoeröffnung und kein SDK-App-ID sind für diese reine Browser-Erweiterungsverbindung erforderlich.

Referenz: https://docs.phantom.com/solana/establishing-a-connection
