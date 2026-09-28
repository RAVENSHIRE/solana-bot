import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { get } from "node:http";
import { mkdtemp, writeFile, rename, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { emptyState, type StreamSnapshot } from "../shared/state";

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test(
  "HTTP serves snapshots and SSE updates/replay; blocks nonlocal origins and writes",
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(path.resolve(".http-test-"));
    const file = path.join(dir, "state.json");
    const state = emptyState("SIMULATION");
    await writeFile(file, JSON.stringify(state));
    const port = await freePort();
    const process = spawn(
      globalThis.process.execPath,
      ["--import", "tsx", "server/index.ts"],
      {
        env: {
          ...globalThis.process.env,
          DASHBOARD_PORT: String(port),
          BOT_STATE_FILE: file,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const controller = new AbortController();
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Server startup timeout")),
          5000,
        );
        process.stdout.on("data", (data) => {
          if (String(data).includes("Dashboard:")) {
            clearTimeout(timer);
            resolve();
          }
        });
        process.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Server exited ${code}`));
        });
        process.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const url = `http://127.0.0.1:${port}`;
      const response = await fetch(`${url}/api/state`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "ready");
      assert.equal(
        (await fetch(`${url}/api/state`, { method: "POST" })).status,
        405,
      );
      assert.equal(
        (
          await fetch(`${url}/api/state`, {
            headers: { Origin: "https://example.com" },
          })
        ).status,
        403,
      );
      const hostStatus = await new Promise<number | undefined>(
        (resolve, reject) => {
          get(
            `${url}/api/state`,
            { headers: { Host: `evil.example:${port}` } },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          ).on("error", reject);
        },
      );
      assert.equal(hostStatus, 403);
      const events = await fetch(`${url}/api/events`, {
        signal: controller.signal,
      });
      assert.match(events.headers.get("content-type")!, /text\/event-stream/);
      const reader = events.body!.getReader();
      let buffer = "";
      const nextState = async (): Promise<StreamSnapshot> => {
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary >= 0) {
            const message = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = message
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (data) return JSON.parse(data.slice(6));
          } else {
            const value = await reader.read();
            if (value.done) throw new Error("SSE closed prematurely");
            buffer += new TextDecoder().decode(value.value);
          }
        }
      };
      assert.equal((await nextState()).state?.metrics.total_trades, null);
      state.metrics.total_trades = 7;
      state.equity_curve = Array.from({ length: 2000 }, (_, i) => ({
        timestamp: new Date(1700000000000 + i * 1000).toISOString(),
        equity_usd: i,
      }));
      await writeFile(file + ".tmp", JSON.stringify(state));
      await rename(file + ".tmp", file);
      assert.equal((await nextState()).state?.metrics.total_trades, 7);
      const reconnected = await fetch(`${url}/api/events`, {
        signal: controller.signal,
      });
      const replayReader = reconnected.body!.getReader();
      let replay = "";
      while (!replay.includes("event: state"))
        replay += new TextDecoder().decode((await replayReader.read()).value);
      assert.match(replay, /"total_trades":7/);
      await replayReader.cancel();
      await reader.cancel();
    } finally {
      controller.abort();
      if (process.exitCode === null && process.signalCode === null) {
        const exit = once(process, "exit");
        process.kill("SIGTERM");
        await exit;
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);
