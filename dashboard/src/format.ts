export type Value = number | null | undefined;
export const present = (v: Value): v is number =>
  typeof v === "number" && Number.isFinite(v);
export const numeric = (v: Value, digits = 0) =>
  present(v)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(
        v,
      )
    : "--";
export const money = (v: Value) =>
  present(v)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(v)
    : "--";
export const price = (v: Value) =>
  !present(v)
    ? "--"
    : v !== 0 && Math.abs(v) < 0.000001
      ? `$${v.toExponential(4)}`
      : new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 2,
          maximumFractionDigits: Math.abs(v) < 1 ? 8 : 2,
        }).format(v);
export const percent = (v: Value) => (present(v) ? `${numeric(v, 2)}%` : "--");
export const duration = (v: Value) =>
  !present(v)
    ? "--"
    : v < 60
      ? `${numeric(v, 1)}s`
      : v < 3600
        ? `${numeric(v / 60, 1)}m`
        : `${numeric(v / 3600, 1)}h`;
export const time = (v?: string | null) =>
  !v
    ? "--"
    : /^\d{2}:\d{2}:\d{2}$/.test(v)
      ? v
      : Number.isFinite(Date.parse(v))
        ? new Date(v).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
        : "--";
export const tone = (v: Value) =>
  !present(v) || v === 0 ? "" : v > 0 ? "positive" : "negative";
export const short = (v?: string | null) =>
  v ? (v.length > 18 ? `${v.slice(0, 6)}…${v.slice(-5)}` : v) : "--";
