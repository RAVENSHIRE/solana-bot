import { startTransition, useEffect, useState } from "react";
import type { StreamSnapshot } from "../shared/state";

export function useBotState() {
  const [snapshot, setSnapshot] = useState<StreamSnapshot>({
    state: null,
    status: "missing",
    source: null,
    updated_at: null,
    message: null,
  });
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const stream = new EventSource("/api/events");
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.addEventListener("state", (event) => {
      try {
        const next = JSON.parse((event as MessageEvent).data) as StreamSnapshot;
        startTransition(() => {
          setSnapshot(next);
          setConnected(true);
        });
      } catch {
        setConnected(false);
      }
    });
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stream.close();
      clearInterval(clock);
    };
  }, []);
  const age = snapshot.updated_at
    ? Math.max(0, (now - Date.parse(snapshot.updated_at)) / 1000)
    : null;
  const stale =
    age !== null &&
    age >
      Math.max(60, (snapshot.state?.meta.decision_cadence_seconds ?? 0) * 3);
  return { ...snapshot, connected, stale, age };
}
