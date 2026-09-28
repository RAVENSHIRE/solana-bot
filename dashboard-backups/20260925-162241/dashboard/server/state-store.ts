import { watchFile, unwatchFile } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseState } from "./adapter";
import type { StreamSnapshot } from "../shared/state";

const MAX_BYTES = 16 * 1024 * 1024;
export class StateStore {
  snapshot: StreamSnapshot = {
    state: null,
    source: null,
    status: "missing",
    updated_at: null,
    message: "Waiting for the state file.",
  };
  private listeners = new Set<(snapshot: StreamSnapshot) => void>();
  private loading = false;
  private pending = false;
  private stopped = false;
  private fingerprint = "";
  constructor(
    readonly file: string,
    private readonly interval = 250,
  ) {}
  async start() {
    // Polling survives atomic rename, missing parent folders and network-mounted files.
    watchFile(
      this.file,
      { interval: this.interval, persistent: false },
      this.onChange,
    );
    await this.refresh();
  }
  private onChange = () => {
    void this.refresh();
  };
  subscribe(listener: (snapshot: StreamSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }
  stop() {
    this.stopped = true;
    unwatchFile(this.file, this.onChange);
    this.listeners.clear();
  }
  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.loading) {
      this.pending = true;
      return;
    }
    this.loading = true;
    try {
      const handle = await open(this.file, "r");
      let raw: string;
      let updated: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES)
          throw new Error(
            "State file exceeds the 16 MiB limit or is not a regular file.",
          );
        const buffer = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            offset,
            buffer.length - offset,
            offset,
          );
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== stat.size)
          throw new Error(
            "State file changed during read; waiting for the next complete write.",
          );
        raw = buffer.subarray(0, offset).toString("utf8");
        updated = stat.mtime.toISOString();
      } finally {
        await handle.close();
      }
      const hash = createHash("sha256")
        .update(raw)
        .update(updated)
        .digest("hex");
      if (hash === this.fingerprint && this.snapshot.status === "ready") return;
      const { state, source } = parseState(JSON.parse(raw));
      this.fingerprint = hash;
      this.publish({
        state,
        source,
        status: "ready",
        updated_at: updated,
        message: null,
      });
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      const message = missing
        ? "Waiting for the state file."
        : `State file is incomplete or does not match a supported schema. ${this.snapshot.state ? "Showing the last valid snapshot." : "No valid snapshot available yet."}`;
      if (
        this.snapshot.status !== (missing ? "missing" : "invalid") ||
        this.snapshot.message !== message
      )
        this.publish({
          ...this.snapshot,
          status: missing ? "missing" : "invalid",
          message,
        });
    } finally {
      this.loading = false;
      if (this.pending) {
        this.pending = false;
        await this.refresh();
      }
    }
  }
  private publish(snapshot: StreamSnapshot) {
    if (this.stopped) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
