import { StateStore } from "./state-store";
import type { StreamSnapshot } from "../shared/state";
import { adaptTelemetry } from "./telemetry-adapter";

/** Prefer the observer's feed; preserve its last valid state if it stops or becomes invalid. */
export class DashboardStore {
  private readonly listeners = new Set<(snapshot: StreamSnapshot) => void>();
  private unsubscribers: Array<() => void> = [];
  snapshot: StreamSnapshot;
  constructor(
    readonly checkpoint: StateStore,
    readonly telemetry: StateStore,
  ) {
    this.snapshot = checkpoint.snapshot;
  }
  async start() {
    this.unsubscribers = [
      this.checkpoint.subscribe(() => this.update()),
      this.telemetry.subscribe(() => this.update()),
    ];
    await Promise.all([this.checkpoint.start(), this.telemetry.start()]);
  }
  private update() {
    const runtime = this.telemetry.snapshot;
    let selected = this.checkpoint.snapshot;
    if (runtime.state && runtime.source === "runtime") {
      try {
        selected = {
          ...runtime,
          ...adaptTelemetry(this.telemetry.raw, this.checkpoint.raw),
          status:
            runtime.status !== "ready"
              ? runtime.status
              : this.checkpoint.snapshot.status,
          message: runtime.message ?? this.checkpoint.snapshot.message,
        };
      } catch {
        selected = {
          ...this.snapshot,
          status: "invalid",
          message:
            "Checkpoint and runtime telemetry could not be combined. Showing the last valid snapshot.",
        };
      }
    } else if (runtime.status === "invalid") {
      selected = {
        ...selected,
        status: "invalid",
        message:
          "The runtime telemetry file is invalid. Showing the available portfolio checkpoint.",
      };
    }
    this.snapshot = selected;
    for (const listener of this.listeners) listener(selected);
  }
  subscribe(listener: (snapshot: StreamSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }
  stop() {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.checkpoint.stop();
    this.telemetry.stop();
    this.listeners.clear();
  }
}
