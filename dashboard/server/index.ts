import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "./state-store";
import { DashboardStore } from "./dashboard-store";
import { adaptTelemetry } from "./telemetry-adapter";
import type { StreamSnapshot } from "../shared/state";
import { createWalletReader } from "./wallet";
import { TradingService, deskFactory, tradingEnvironment } from './trading';
import { deskCapital } from '../../src/desk/config';

const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.DASHBOARD_PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid DASHBOARD_PORT");
const statePath = process.env.BOT_STATE_FILE
  ? path.resolve(process.env.BOT_STATE_FILE)
  : path.resolve(root, "..", "data", "state-SIMULATION.json");
const telemetryPath = process.env.BOT_TELEMETRY_FILE
  ? path.resolve(process.env.BOT_TELEMETRY_FILE)
  : path.join(path.dirname(statePath), "dashboard-SIMULATION.json");
const store =
  process.env.BOT_STATE_FILE && !process.env.BOT_TELEMETRY_FILE
    ? new StateStore(statePath)
    : new DashboardStore(
        new StateStore(statePath),
        new StateStore(telemetryPath, 250, adaptTelemetry),
      );
await store.start();
const repo = path.resolve(root, '..');
const planned = await tradingEnvironment(repo).then(env => deskCapital(env).plannedStartingCapitalUsd).catch(() => null);
const walletReader = await createWalletReader(repo, planned).catch(() => null);
const trading = new TradingService(deskFactory(repo));
const dev = process.argv.includes("--dev");
const vite = dev
  ? await (
      await import("vite")
    ).createServer({
      root,
      server: { middlewareMode: true, hmr: false },
      appType: "spa",
    })
  : null;
const dist = path.join(root, "dist");
const clients = new Set<http.ServerResponse>();
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const server = http.createServer(async (req, res) => {
  // Loopback binding + Host/Origin checks keep portfolio data local, including against DNS rebinding.
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (
    !req.headers.host ||
    !allowed.has(req.headers.host) ||
    (req.headers.origin &&
      ![...allowed].some((host) => req.headers.origin === `http://${host}`))
  ) {
    res.writeHead(403).end("Local access only");
    return;
  }
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (await trading.handleRequest(req, res)) return;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === '/api/wallet') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') { res.writeHead(200).end(); return; }
    try {
      if (!walletReader) throw new Error('WALLET_CONFIG_UNAVAILABLE');
      const selected = new URL(req.url!, 'http://localhost').searchParams.get('address');
      // Resolve the read before sending headers; rejected RPC/address requests need an error status.
      const payload = JSON.stringify(await walletReader.read(selected));
      if (!res.destroyed) res.writeHead(200).end(payload);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const invalid = error instanceof Error && error.message === 'INVALID_ADDRESS';
      res.writeHead(invalid ? 400 : 503).end(JSON.stringify({
        balance: null, message: invalid ? 'Invalid Solana address.' : 'Wallet data unavailable. Check local RPC configuration and connectivity.',
      }));
    }
    return;
  }
  if (pathname === "/api/state") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(store.snapshot));
    return;
  }
  if (pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.flushHeaders();
    clients.add(res);
    res.write("retry: 1500\n\n");
    let blockedAt: number | null = null;
    let pending: StreamSnapshot | null = null;
    const send = (snapshot: StreamSnapshot) => {
      // A large write normally returns false. Wait for drain and retain only the latest update.
      if (blockedAt !== null) {
        pending = snapshot;
        return;
      }
      if (!res.write(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`))
        blockedAt = Date.now();
    };
    res.on("drain", () => {
      blockedAt = null;
      if (pending) {
        const next = pending;
        pending = null;
        send(next);
      }
    });
    const unsubscribe = store.subscribe(send);
    const timer = setInterval(() => {
      if (blockedAt !== null) {
        if (Date.now() - blockedAt > 30000) res.destroy();
      } else if (!res.write(": heartbeat\n\n")) blockedAt = Date.now();
    }, 15000);
    res.on("close", () => {
      clearInterval(timer);
      unsubscribe();
      pending = null;
      clients.delete(res);
    });
    return;
  }
  if (pathname.startsWith("/api/")) {
    res.writeHead(404).end();
    return;
  }
  if (vite) {
    vite.middlewares(req, res);
    return;
  }
  try {
    const relative =
      decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";
    let file = path.resolve(dist, relative);
    if (!file.startsWith(dist + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const exists = await stat(file).catch(() => null);
    if (!exists?.isFile()) {
      if (path.extname(relative)) {
        res.writeHead(404).end();
        return;
      }
      file = path.join(dist, "index.html");
    }
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Cache-Control": file.includes(`${path.sep}assets${path.sep}`)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res
      .writeHead(500)
      .end("Dashboard build unavailable. Run npm run build in dashboard/.");
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(
    `Dashboard: http://localhost:${port}\nCheckpoint: ${statePath}${store instanceof DashboardStore ? `\nRuntime telemetry: ${telemetryPath}` : ""}`,
  );
});
server.on("error", (error) => {
  console.error(error.message);
  void shutdown(1);
});
async function shutdown(code = 0) {
  await trading.close();
  store.stop();
  for (const client of clients) client.end();
  await vite?.close();
  server.close(() => process.exit(code));
  server.closeAllConnections();
}
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
