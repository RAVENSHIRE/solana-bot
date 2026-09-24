/**
 * PM2-Konfiguration für den 24/7-Betrieb auf einem Ubuntu-VPS.
 *
 *   npm run build && pm2 start ecosystem.config.js
 *   pm2 save && pm2 startup   (Autostart nach Reboot)
 *
 * Wichtige Mechanismen:
 *  - max_memory_restart   → automatischer Neustart bei Memory-Leaks (RSS > 512 MB)
 *  - --max-old-space-size → V8-Heap-Limit knapp darunter, damit PM2 vor dem OOM-Killer greift
 *  - exp_backoff_restart_delay → Crash-Recovery mit exponentiellem Backoff (100 ms … 15 s)
 *  - min_uptime / max_restarts → erkennt Crash-Schleifen
 *  - stop_exit_codes [78] → bei Konfigurationsfehlern KEIN Endlos-Neustart
 *  - wait_ready + kill_timeout → geordneter Start (process.send('ready')) und Shutdown
 *    (laufende Trades abwarten, Zustand persistieren)
 */
module.exports = {
  apps: [
    {
      name: 'solana-bot',
      script: './dist/index.js',
      cwd: __dirname,
      exec_mode: 'fork', // Zustand & Nonce-freie Signaturen: niemals mehrere Instanzen!
      instances: 1,
      autorestart: true,
      watch: false,

      node_args: ['--max-old-space-size=460', '--enable-source-maps', '--disable-warning=DEP0040'],
      max_memory_restart: '512M',

      exp_backoff_restart_delay: 100,
      max_restarts: 50,
      min_uptime: '60s',
      stop_exit_codes: [78],

      wait_ready: true,
      listen_timeout: 60000,
      kill_timeout: 30000,
      shutdown_with_message: false,

      // Optional: täglicher präventiver Neustart um 04:00 UTC (offene Positionen bleiben erhalten)
      // cron_restart: '0 4 * * *',

      time: false, // Zeitstempel liefert der eigene Logger
      merge_logs: true,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',

      env: {
        NODE_ENV: 'production',
        // Farbcodes sind in Logdateien störend
        LOG_COLOR: 'false',
      },
    },
  ],
};
