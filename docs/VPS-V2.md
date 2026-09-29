# V2: Betrieb auf einem VPS

V1 benötigt eine offene Browser-Sitzung mit Phantom, gültige Freigaben und Heartbeats. Diese Architektur kann nicht durch das Verschieben des Node-Prozesses auf einen VPS automatisch 24/7 handeln. Auto-Confirm ist eine Wallet-Berechtigung im Browser, kein unbegrenzt verfügbarer Server-Signer.

Für V2 sind folgende getrennte Komponenten vorgesehen:

| Komponente | Aufgabe | Vor Freigabe zu klären |
|---|---|---|
| Market Worker | RPC/Quotes, Signal- und Kostenprüfung | Provider-Limits, Ausfallmetriken, Wiederholbarkeit |
| Execution Worker | Ein Auftrag bis Settlement, dauerhafte Absichten | Ein Leader pro Wallet, ausfallsichere Queue, Reconciliation |
| Signer Adapter | Nur autorisierte Transaktionen signieren | Dediziertes Budget-Wallet und vom Nutzer gewählter Server-/Remote-Signer; kein Export der persönlichen Phantom-Seed im Chat |
| Ledger | Unveränderliche Fills, Balance-Abgleich | Persistentes Volume/DB, Backups, Wiederanlauf nach Crash |
| Dashboard | Status, Profile, Stop und Audit | Anmeldung, TLS, CSRF, Rollen und private Netzwerkverbindung |

Der bestehende `TransactionSigner` trennt Wallet-Freigabe vom Executor. Die Guards bleiben bei einem späteren Adapterwechsel obligatorisch. Vor Deployment werden zuerst Ausfall-/Recovery-Tests und ein beobachteter kleiner Live-Pilot ausgewertet. Ein VPS-Neustart startet standardmäßig disarmed, bis Wiederanlauf- und Reconciliation-Regeln ausdrücklich festgelegt sind.

Noch nicht umgesetzt oder beauftragt: VPS-Konto, Hosting-Anbieter, Server-Signer, Cloud-Zugangsdaten, Remote-Deployment. Es wurde keine Infrastruktur erstellt und kein Key übertragen.
