/**
 * Research platform CLI (docs/research/ARCHITECTURE.md). Read-only towards the desk: it never signs, trades, or reads a
 * key or .env (except RESEARCH_API_TOKENS for `serve`). Dependency-free, so it also runs from the compiled
 * dist-research/ on a research machine without npm install.
 *
 *   import          --store DIR [--desk data-desk] [--cache data-desk/backtest-cache]
 *                   [--observer data-desk/research --from ISO --to ISO (--sol-store DIR | --sol-usd N)]
 *   verify          --store DIR
 *   stats           --store DIR[,DIR…]
 *   why             --store DIR[,DIR…] --token MINT --from ISO --to ISO
 *   features | strategies | cases
 *   backtest        --store DIR[,DIR…] --strategy ID [--mode AVAILABLE|OBSERVED] [--from ISO --to ISO] [--seed N] [--include-known-cases] [--out FILE]
 *   experiment      --store DIR[,DIR…] --registry DIR --strategy ID --hypothesis TEXT --trials N [--split 0.5,0.2,0.3] [--no-holdout] [--actor NAME]
 *   collect-regime  --store DIR [--every-min 5] [--once]
 *   serve           --store DIR[,DIR…] --registry DIR --hypotheses DIR [--port 8790]   (RESEARCH_API_TOKENS=role:id:token,…)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CATALOG, DESK_LIKE, ExperimentRegistry, FileEventStore, HypothesisBook, KNOWN_CASES, MultiStoreReader, RESEARCH_DEFAULT_LIMITS, ResearchApi, StrategyRegistry,
  backtestCacheInputs, buildDataset, codeVersion, computeRegime, deskArtifactInputs, explainMissingAlert, knownCaseTokens, observerInputs, parsePrincipals,
  referencePriceEvents, regimeKey, runBacktest, runExperiment, standardRegistry, startServer, timeSplit, verifyStore, type EventInput, type ResearchEvent,
} from '../research/platform';

const args = process.argv.slice(2), command = args[0] ?? 'help';
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name: string) => args.includes(`--${name}`);
const need = (name: string) => { const v = opt(name); if (!v) throw new Error(`--${name} is required`); return v; };
const when = (name: string) => { const v = need(name), t = Date.parse(v); if (!Number.isFinite(t)) throw new Error(`--${name}: not a date`); return t; };
const dirs = () => (opt('store') ?? 'data-research/store').split(',').map(d => path.resolve(d.trim())).filter(Boolean);
const print = (v: unknown) => process.stdout.write(JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x), 2) + '\n');
const repo = path.resolve(__dirname, '..', '..').replace(/[\\/]dist-research$/, '');

async function load(): Promise<ResearchEvent[]> { return new MultiStoreReader(dirs()).query(); }
function registries() {
  const features = standardRegistry(), strategies = new StrategyRegistry(features);
  for (const s of CATALOG) strategies.register(s);
  return { features, strategies };
}
const limits = { ...RESEARCH_DEFAULT_LIMITS, maxDailyLossUsd: 1e9, maxDrawdownUsd: 1e9 };

async function main(): Promise<void> {
  switch (command) {
    case 'import': {
      const store = await FileEventStore.open(path.resolve(need('store')));
      try {
        const batches: Array<[string, EventInput[], unknown]> = [];
        if (opt('desk')) { const r = await deskArtifactInputs(path.resolve(opt('desk')!)); batches.push(['desk', r.inputs, r.report]); }
        if (opt('cache')) { const r = await backtestCacheInputs(path.resolve(opt('cache')!)); batches.push(['backtest-cache', r.inputs, r.report]); }
        if (opt('observer')) {
          let solUsd: ((ts: number) => number | null) | undefined, constant = false;
          if (opt('sol-store')) {
            const sol = (await new MultiStoreReader([path.resolve(opt('sol-store')!)]).query({ tokens: ['REF:SOL'], types: ['MarketSnapshot'] }))
              .map(e => ({ t: e.timestamp, p: e.payload.price_usd as number })).sort((a, b) => a.t - b.t);
            solUsd = ts => { let best: number | null = null; for (const x of sol) { if (x.t > ts) break; if (ts - x.t <= 3_600_000) best = x.p; } return best; };
          } else if (opt('sol-usd')) { const p = Number(opt('sol-usd')); if (!(p > 0)) throw new Error('--sol-usd must be > 0'); solUsd = () => p; constant = true; }
          const r = await observerInputs(path.resolve(opt('observer')!), { from: when('from'), to: when('to'), solUsd });
          const inputs = constant ? r.inputs.map(i => ('amount_usd' in i.payload || i.event_type === 'Candle'
            ? { ...i, quality_issues: [...(i.quality_issues ?? []), { issue: 'USD_FROM_CONSTANT_SOL_PRICE', status: 'UNVERIFIED' as const }] } : i)) : r.inputs;
          batches.push(['observer', inputs, r.report]);
        }
        if (!batches.length) throw new Error('nothing to import: give --desk, --cache and/or --observer');
        for (const [name, inputs, report] of batches) {
          let appended = 0, duplicates = 0, conflicts = 0;
          for (let i = 0; i < inputs.length; i += 5_000) for (const r of await store.append(inputs.slice(i, i + 5_000))) {
            if (r.status === 'APPENDED') appended++; else if (r.status === 'DUPLICATE') duplicates++; else conflicts++;
          }
          print({ source: name, report, appended, duplicates, conflicts });
        }
      } finally { await store.close(); }
      return;
    }
    case 'verify': { const r = await verifyStore(path.resolve(need('store'))); print(r); if (!r.ok) process.exitCode = 2; return; }
    case 'stats': print(await new MultiStoreReader(dirs()).stats()); return;
    case 'why': print(explainMissingAlert(await load(), { token: need('token'), from: when('from'), to: when('to') })); return;
    case 'features': print(registries().features.list().map(({ compute: _c, ...f }) => f)); return;
    case 'strategies': print(registries().strategies.list()); return;
    case 'cases': print(KNOWN_CASES); return;
    case 'backtest': {
      const { features, strategies } = registries(), events = await load(), ds = buildDataset(events, { description: 'cli backtest', createdAt: Date.now() });
      const strategy = strategies.get(need('strategy')), mode = (opt('mode') ?? 'AVAILABLE') as 'AVAILABLE' | 'OBSERVED';
      const cases = flag('include-known-cases') ? [] : knownCaseTokens(new Set(events.map(e => e.token).filter((t): t is string => !!t)));
      const r = runBacktest(ds.events, { strategy, features, execution: DESK_LIKE, risk: limits, mode, seed: Number(opt('seed') ?? 1), datasetVersion: ds.manifest.dataset_version,
        codeVersion: codeVersion(repo), excludeTokens: cases, regime: v => regimeKey(computeRegime(v)),
        period: opt('from') || opt('to') ? { from: opt('from') ? when('from') : -Infinity, to: opt('to') ? when('to') : Infinity } : undefined });
      const { trades, ...rest } = r;
      print({ ...rest, trades: trades.length, dataset: ds.manifest.dataset_version });
      if (opt('out')) await fs.writeFile(path.resolve(opt('out')!), JSON.stringify(r, null, 2));
      return;
    }
    case 'experiment': {
      const { features, strategies } = registries(), events = await load(), ds = buildDataset(events, { description: 'cli experiment', createdAt: Date.now() });
      const registry = await ExperimentRegistry.open(path.resolve(need('registry')));
      try {
        const weights = (opt('split') ?? '0.5,0.2,0.3').split(',').map(Number);
        const [training, validation, test] = timeSplit(ds.manifest.first_timestamp ?? 0, (ds.manifest.last_timestamp ?? 0) + 1, weights);
        const tokens = new Set(events.map(e => e.token).filter((t): t is string => !!t));
        const run = await runExperiment(registry, { hypothesis: need('hypothesis'), config: { strategy: strategies.get(need('strategy')), features, execution: DESK_LIKE, risk: limits,
          mode: (opt('mode') ?? 'AVAILABLE') as 'AVAILABLE' | 'OBSERVED', seed: Number(opt('seed') ?? 1), codeVersion: codeVersion(repo), regime: v => regimeKey(computeRegime(v)) },
          dataset: ds.manifest, events: ds.events, periods: { training: training!, validation: validation!, test: test! }, trials: Number(need('trials')),
          knownCases: knownCaseTokens(tokens), actor: opt('actor') ?? 'cli', now: Date.now, openHoldout: !flag('no-holdout') });
        print(run.record);
      } finally { await registry.close(); }
      return;
    }
    case 'collect-regime': {
      const store = await FileEventStore.open(path.resolve(need('store'))), every = Number(opt('every-min') ?? 5) * 60_000;
      let stop = false; process.once('SIGINT', () => { stop = true; }); process.once('SIGTERM', () => { stop = true; });
      try {
        do {
          try { const r = await store.append(await referencePriceEvents(fetch, Date.now())); print({ at: new Date().toISOString(), appended: r.filter(x => x.status !== 'DUPLICATE').length }); }
          catch (error) { process.stderr.write(`regime collection failed: ${error instanceof Error ? error.message : String(error)}\n`); }
          if (flag('once')) break;
          for (let waited = 0; waited < every && !stop; waited += 1_000) await new Promise(r => setTimeout(r, 1_000));
        } while (!stop);
      } finally { await store.close(); }
      return;
    }
    case 'serve': {
      const { features, strategies } = registries(), events = await load();
      const experiments = await ExperimentRegistry.open(path.resolve(opt('registry') ?? 'data-research/experiments'));
      const hypotheses = await HypothesisBook.open(path.resolve(opt('hypotheses') ?? 'data-research/hypotheses'));
      const audit = await FileEventStore.open(path.resolve(opt('audit') ?? 'data-research/audit'));
      const api = new ResearchApi({ events, features, strategies, experiments, hypotheses, execution: DESK_LIKE, risk: limits, audit, now: Date.now, codeVersion: codeVersion(repo) });
      const server = await startServer(api, { port: Number(opt('port') ?? 8790), principals: parsePrincipals(process.env.RESEARCH_API_TOKENS) });
      process.stdout.write(`research API on http://127.0.0.1:${opt('port') ?? 8790} · ${events.length} events loaded\n`);
      const close = () => { server.close(); void Promise.all([experiments.close(), hypotheses.close(), audit.close()]).finally(() => process.exit(0)); };
      process.once('SIGINT', close); process.once('SIGTERM', close);
      return;
    }
    default:
      process.stdout.write(`usage: research-platform <import|verify|stats|why|features|strategies|cases|backtest|experiment|collect-regime|serve> [options]\n`
        + 'See the header of src/scripts/research-platform.ts and docs/research/ARCHITECTURE.md.\n');
  }
}

main().catch(error => { process.stderr.write(`research-platform ${command} failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
