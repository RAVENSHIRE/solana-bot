import './polyfills';
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DeskPanel } from './Desk';
import { WalletPanel } from "./WalletPanel";
import { useTradingSession } from "./use-trading";
import "./styles.css";

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="6" height="6" rx="2" />
        <rect x="15" y="3" width="6" height="6" rx="2" />
        <rect x="3" y="15" width="6" height="6" rx="2" />
        <rect x="15" y="15" width="6" height="6" rx="2" />
      </>
    ),
    chart: (
      <>
        <path d="M4 3v15a2 2 0 0 0 2 2h15M6 15l4-6 4 3 6-8" />
      </>
    ),
    wallet: (
      <>
        <rect x="3" y="6" width="18" height="14" rx="3" />
        <path d="M4 6V4h13M16 11h5v5h-5z" />
      </>
    ),
    activity: (
      <>
        <path d="M3 12h4l3-7 4 14 3-7h4" />
        <rect x="2" y="2" width="20" height="20" rx="5" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 10 5-10 5L2 8zm-10 9 10 5 10-5M2 16l10 5 10-5" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7v1" />
      </>
    ),
    arrow: <path d="m14 6-6 6 6 6M8 12h13" />,
    target: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="4" />
      </>
    ),
    list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
    copy: (
      <>
        <rect x="8" y="8" width="12" height="13" rx="2" />
        <path d="M15 8V3H3v12h5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.chart}
    </svg>
  );
}

/** Sidebar targets: sections of the trading desk (ids set in Desk.tsx). */
const SECTIONS = [
  { id: 'desk-overview', label: 'Overview', icon: 'grid' },
  { id: 'desk-strategies', label: 'Strategies', icon: 'target' },
  { id: 'desk-candidates', label: 'Candidates', icon: 'list' },
  { id: 'desk-positions', label: 'Positions', icon: 'wallet' },
  { id: 'desk-trades', label: 'Trades', icon: 'layers' },
  { id: 'desk-telemetry', label: 'Telemetry', icon: 'activity' },
] as const;

function App() {
  const trading = useTradingSession();
  const [active, setActive] = useState<string>(SECTIONS[0].id);
  // Highlights the section in view, so the sidebar always shows where you are.
  useEffect(() => {
    const seen = new IntersectionObserver(entries => {
      const top = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActive(top.target.id);
    }, { rootMargin: '-10% 0px -70% 0px' });
    const watch = () => SECTIONS.forEach(s => { const el = document.getElementById(s.id); if (el) seen.observe(el); });
    watch();
    const retry = setInterval(watch, 2_000);
    return () => { clearInterval(retry); seen.disconnect(); };
  }, []);
  const go = (id: string) => { setActive(id); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const desk = trading.view?.desk;
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Dashboard navigation">
        <div className="brand" title="Solana trading desk"><span /><span /><span /><span /><span /><span /><span /></div>
        <nav>
          {SECTIONS.map(s => (
            <button key={s.id} title={s.label} aria-label={s.label} className={active === s.id ? 'selected' : ''} onClick={() => go(s.id)}>
              <Icon name={s.icon} />
            </button>
          ))}
        </nav>
      </aside>
      <div className="workspace">
        <div className="topbar">
          <div className="topbar-left">
            <Icon name="grid" size={16} />
            <span className="topbar-divider" />
            <span>Trading workspace</span>
          </div>
        </div>
        <main className="main">
          <header className="page-header">
            <div className="page-heading">
              <Icon name="arrow" size={19} />
              <h1>Solana trading desk</h1>
              <p>TEST and LIVE share one pipeline</p>
            </div>
            <div className="header-actions">
              <span className="mode">
                <Icon name="activity" size={16} />
                {!trading.online ? 'OFFLINE' : trading.view?.mode === 'LIVE' ? `LIVE${desk?.scanner ? ' · RUNNING' : ''}` : `TEST${desk?.scanner ? ' · RUNNING' : ''}`}
              </span>
            </div>
          </header>
          <div className="desk-workspace">
            <DeskPanel t={trading} />
            <WalletPanel address={trading.address} connected={trading.connected} />
          </div>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
