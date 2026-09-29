# Solana Autonomous Trading Bot

Die zuvor fehlenden DexScreener-, GeckoTerminal- und Raydium-Clients sind auf dem Feature-Branch implementiert. Datenqualitätsprüfungen, Provider-Health, begrenzte Historie und frische Ausführungsquotes sind integriert. [Audit, Datenfluss und Betrieb](docs/DATA-INTEGRATION.md) · [Testergebnisse und Grenzen](docs/DATA-ENGINEERING-REPORT.md).

```bash
npm run typecheck
npm test
npm run build
npm run data:check  # nur öffentliche APIs, keine Wallet oder Transaktionen
```

Die Strategiegewichte und `RISK_*`-Limits bleiben unverändert. Marktwert ist erforderlich, FDV ersetzt ihn nicht. Bei fehlenden Quotes bleiben Positionen verwaltet; neue Einstiege warten auf eine gültige Bewertung. Die optionalen `DATA_*`-Einstellungen stehen in `.env.example`.


Modularer Node.js/TypeScript-Bot für Solana mit zwei parallel laufenden Strategien, Dry-Run-Modus, RPC-Failover und PM2-Deployment.

> **Risiko-Hinweis:** Dies ist Software, keine Finanzberatung. Memecoin-Trading kann zum Totalverlust führen. Starte ausschließlich im Simulationsmodus, prüfe die Ergebnisse über Tage/Wochen und nutze für LIVE eine **separate Hot-Wallet** mit begrenztem Guthaben – niemals deine Haupt-Phantom-Wallet.

## Architektur

```
src/
├── index.ts                       Bootstrap, Signal-Handling, PM2-Ready
├── config/config.ts               .env-Validierung (zod), Sicherheitsverriegelung LIVE
├── core/
│   ├── types.ts                   Domänentypen, Strategy-Interface
│   ├── engine.ts                  Scheduler (scan/manage je Strategie), Timeouts, Backoff, Heartbeat
│   ├── portfolio.ts               Positionen, PnL, virtuelles Konto, atomare Persistenz
│   ├── risk-manager.ts            Limits, Tagesverlust, Circuit Breaker
│   └── journal.ts                 Trade-Journal (Terminal + JSONL)
├── rpc/connection-manager.ts      Multi-RPC, Rate-Limit, Failover, Health-Checks
├── execution/
│   ├── executor.ts                TradeExecutor-Interface + Basis (Quotes, Priority-Fees)
│   ├── live-executor.ts           Signieren, Simulieren, Senden, Fill aus Tx-Meta
│   ├── simulated-executor.ts      Paper-Trading mit echten Quotes, Latenz & Slippage
│   ├── jupiter-client.ts          Jupiter Swap API v1
│   ├── tx-sender.ts               Senden + Bestätigen (Blockhash-sicher, Rebroadcast)
│   └── token-accounts.ts          Token-Konten auflisten/schließen (Rent-Rückholung)
├── data/                          DexScreener, GeckoTerminal, Raydium API-Clients
├── analysis/                      Indikatoren, Support, Wash-Trading, Smart Money, Token-Sicherheit
├── strategies/
│   ├── base-strategy.ts           Ein-/Ausstieg, Slippage-Eskalation, Exits, Bewertung
│   ├── suck-up-the-rent/          Roundtrip-Arb + LP-Fee-Simulation + Rent-Reclaimer
│   └── reversal-sniper/           Umkehr-Score aus Support, Momentum, Volumenqualität, Akkumulation
├── dashboard/                     Dashboard-Server (Watcher + SSE), Datenvertrag, Adapter
└── scripts/test-connection.ts     Isolierter Verbindungstest
dashboard/index.html               Browser-Oberfläche (Tailwind, SVG-Charts)
```

## Strategien

**SuckUpTheRent** besteht aus drei isolierten Sub-Modulen. Die Roundtrip-Arbitrage quotet High-Velocity-Pools (1h-Volumen / Liquidität) über Jupiter in beide Richtungen und handelt nur, wenn SOL→Token→SOL nach allen Gebühren den Mindest-Edge übertrifft; beide Legs werden innerhalb von Sekunden ausgeführt (Max-Hold 90 s, Stop 3 %). Die LP-Fee-Simulation bildet Liquiditätsbereitstellung in Raydium-Standard-Pools mit echten Fee-APRs und Preisen ab und berechnet Fee-Ertrag, Impermanent Loss und die delta-neutral gehedgte PnL (`Fees − V·(√r−1)²/2`). Sie läuft **immer als Paper-Simulation**, weil sich Memecoins praktisch nicht shorten lassen. Der Rent-Reclaimer schließt leere Token-Konten (≈ 0,002 SOL je Konto).

**ReversalSniper** entdeckt Tokens über DexScreener-Boosts/-Profile, GeckoTerminal-Trending und eine Watchlist, filtert auf starken Abverkauf mit Mindestliquidität und bewertet Kandidaten mit einem Score von 0–100: Support-Zonen & höhere Tiefs (25), RSI-Wende/Divergenz/EMA9-Reclaim (20), Verkäufer-Erschöpfung (10), Volumenqualität aus Einzel-Trades inkl. Wash-Trading-Erkennung (20) und Akkumulations-Cluster bzw. bekannte Smart-Money-Wallets (25). Vor jedem Kauf erfolgt eine On-Chain-Prüfung des Mints (Freeze-/Mint-Authority, gefährliche Token-2022-Extensions). Der Stop-Loss wird dynamisch knapp unter den Support gelegt; zusätzlich gibt es Take-Profit, Trailing-Stop, Max-Hold und einen Support-Bruch-Exit.

## Setup-Guide Ubuntu-VPS (22.04 / 24.04)

### 1. System vorbereiten

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essential ufw

# Zeitsynchronisation (wichtig für Logs & Tagesgrenzen)
sudo timedatectl set-ntp true

# Eigener Benutzer ohne Root-Rechte für den Bot
sudo adduser --disabled-password --gecos "" solbot
sudo usermod -aG sudo solbot   # optional, nur für die Einrichtung

# Firewall: nur SSH eingehend
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw enable
```

Empfehlung: SSH nur per Key (`PasswordAuthentication no` in `/etc/ssh/sshd_config`) und `fail2ban` installieren.

### 2. Node.js 22 LTS installieren

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v22.x
npm -v
```

### 3. PM2 installieren

```bash
sudo npm install -g pm2
```

### 4. Projekt klonen und bauen

```bash
sudo su - solbot
git clone <DEIN_REPO_URL> solana-bot
cd solana-bot
npm ci            # exakt nach package-lock.json (beim allerersten Mal ggf. npm install)
npm run build     # TypeScript → dist/
```

### 5. Konfiguration

```bash
cp .env.example .env
chmod 600 .env    # nur der Besitzer darf lesen – der Bot warnt sonst beim Start
nano .env
```

Pflichtwerte: `WALLET_PRIVATE_KEY`, `RPC_ENDPOINTS` (idealerweise ein bezahlter RPC wie Helius, QuickNode oder Triton) und `JUPITER_API_KEY` (kostenlos unter https://portal.jup.ag). `SIMULATION_MODE=true` bleibt zunächst gesetzt.

Private Key aus Phantom exportieren: *Einstellungen → Konten verwalten → Konto wählen → Privaten Schlüssel anzeigen*. Der base58-String wird direkt eingefügt. Der Bot entfernt den Key nach dem Laden aus `process.env`.

### 6. Verbindung testen

```bash
npm run test:connection
```

Das Skript prüft jeden RPC-Endpoint (Version, Slot-Latenz min/avg/p95, Blockhash-Latenz, Node-Verzögerung, Priority-Fee-Niveau), das SOL-Guthaben der Wallet und einen Jupiter-Test-Quote. Es sendet keine Transaktionen. Exit-Code 0 bedeutet: startklar.

### 7. Simulation starten (Dry-Run)

Im Vordergrund zum Beobachten:

```bash
npm run sim
```

Oder direkt als Dienst:

```bash
pm2 start ecosystem.config.js
pm2 logs solana-bot
```

Jeder (simulierte) Trade erscheint als strukturierte Zeile mit Timestamp, Modus, Strategie, Token, Aktion, Beträgen, Fees, Price-Impact, Slippage und PnL. Maschinenlesbar zusätzlich in `logs/trades-SIMULATION-YYYY-MM-DD.jsonl`, der Zustand liegt in `data/state-SIMULATION.json`.

### 8. Autostart nach Reboot

```bash
pm2 save
pm2 startup systemd -u solbot --hp /home/solbot
# den ausgegebenen sudo-Befehl kopieren und ausführen
```

### 9. Log-Rotation

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
```

Die täglichen Trade-Journale (`logs/trades-*.jsonl`) rotieren durch das Datum im Dateinamen von selbst. Alte Journale können z. B. per Cron aufgeräumt werden:

```bash
crontab -e
# 30 3 * * * find /home/solbot/solana-bot/logs -name 'trades-*.jsonl' -mtime +90 -delete
```

### 10. Betrieb & Updates

```bash
pm2 status
pm2 monit                     # CPU/RAM live
pm2 logs solana-bot --lines 200
pm2 reload ecosystem.config.js --update-env   # nach .env-Änderungen

# Update
git pull
npm ci
npm run build
pm2 reload ecosystem.config.js --update-env
```

Offene Positionen überstehen Neustarts: Beim Stoppen wartet der Bot auf laufende Transaktionen, speichert den Zustand atomar und verwaltet die Positionen nach dem Start weiter. Er verkauft beim Stoppen bewusst nichts automatisch.

### 11. Wechsel auf LIVE

Erst nach ausreichend langer, positiver Simulation (inklusive Fees und Slippage!):

```env
SIMULATION_MODE=false
LIVE_TRADING_CONFIRMED=I_UNDERSTAND_THE_RISKS
```

Klein anfangen (`RS_TRADE_SIZE_SOL`, `SUTR_ARB_SIZE_SOL`, `RISK_*`), dann `pm2 reload ecosystem.config.js --update-env`. Der LIVE-Zustand wird getrennt in `data/state-LIVE.json` geführt.

## Web-Dashboard

Das Dashboard ist ein eigener, schlanker Prozess. Er liest nur die Dateien im `STATE_DIR` und braucht weder Private Key noch RPC-Zugang:

- `state-{MODE}.json`: Positionen, abgeschlossene Trades, Statistik, virtuelles Konto (schreibt das Portfolio)
- `dashboard-{MODE}.json`: Entscheidungen, Watchlist, Kurs-Ticks, Equity-Kurve, RPC-Latenz, SOL/USD-Kurs (schreibt die Telemetrie des Bots)

Änderungen werden per Datei-Watcher erkannt und über Server-Sent Events sofort an den Browser gestreamt. Alle angezeigten Werte stammen aus diesen Dateien. Was der Bot nicht misst, erscheint als `--`. Der vollständige Datenvertrag steht in `src/dashboard/contract.ts`.

Lokal (auch Windows) in einem zweiten Terminal neben dem Bot:

```bash
npm run dashboard
```

Dann http://127.0.0.1:8787 öffnen. Port und Host lassen sich über `DASHBOARD_PORT` und `DASHBOARD_HOST` einstellen.

Auf dem VPS läuft das Dashboard als zweite PM2-App (`solana-bot-dashboard`, startet mit `pm2 start ecosystem.config.js`). Es lauscht nur auf 127.0.0.1 und hat keinen Login. Öffne es deshalb über einen SSH-Tunnel statt den Port freizugeben:

```bash
ssh -L 8787:127.0.0.1:8787 solbot@DEIN_SERVER
```

## Stabilitäts- und Sicherheitsmechanismen

Die Engine plant jede Strategie-Schleife selbst neu (keine Überlappung), bricht hängende Ticks per Timeout ab und reagiert auf Fehler mit exponentiellem Backoff statt Absturz. RPC-Aufrufe laufen über Token-Buckets je Endpoint, mit Retry, Failover und Cooldown für gestörte Knoten; signierte Transaktionen werden an alle Endpoints gesendet und bis zum Ablauf des Blockhashes nachverfolgt, damit kein „Geisterkauf“ unbemerkt landet. Konnte der Status einer Transaktion nicht ermittelt werden, prüft der Bot den On-Chain-Bestand und rekonstruiert die Position bei Bedarf; solche Fälle werden als Fehler geloggt und sollten im Explorer kontrolliert werden. Der Risk-Manager erzwingt Positionsgröße, Gesamt-Exposure, SOL-Reserve, Tagesverlust-Limit (UTC), Verlust-Cooldowns und einen Circuit Breaker nach mehreren fehlgeschlagenen Transaktionen in Folge. Konfigurationsfehler beenden den Prozess mit Exit-Code 78, den PM2 nicht neu startet.

## Grenzen (ehrlich)

Die Roundtrip-Arbitrage ist nicht atomar und konkurriert mit spezialisierten MEV-/Jito-Bundles. Positive Netto-Edges über denselben Aggregator sind selten; das Modul protokolliert deshalb die beste gemessene Edge, damit du die Realität in deinem Markt siehst. Die LP-Simulation modelliert Constant-Product-Pools und einen statischen Hedge; Funding-Kosten eines echten Shorts, Rebalancing und CLMM-Ranges sind nicht enthalten. Wash-Trading- und Smart-Money-Erkennung sind Heuristiken auf Basis der letzten ~300 Trades eines Pools. Die verwendeten Drittanbieter-APIs (Jupiter, DexScreener, GeckoTerminal, Raydium) können Limits, Formate oder Zugangsbedingungen jederzeit ändern.
