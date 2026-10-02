/**
 * The research platform's public surface (dependency-free: node built-ins only). See docs/research/ARCHITECTURE.md.
 *
 *   events      immutable, versioned observations and their store
 *   pit         point-in-time views and leakage tests
 *   features    versioned feature registry and the standard features
 *   strategy    immutable strategy versions and the catalog
 *   execution   theoretical vs executable trades
 *   risk        limits and the kill switch
 *   backtest    point-in-time backtests and research designs
 *   experiments pre-registered experiments with a sealed holdout
 *   regime      market regime at a decision time
 *   alerts      evidence snapshots of alerts
 *   observability  health and "why did I not get an alert?"
 *   curiosity   observations, hypotheses and known cases
 *   api         capability-scoped tools for agents (no trading)
 *   ingest      desk artifacts, backtest cache and observer ledger → events
 */
export * from './core/canonical';
export * from './core/stats';
export * from './core/random';
export * from './core/append-log';
export * from './core/version';
export * from './events/types';
export * from './events/factory';
export * from './events/store';
export * from './events/dataset';
export * from './pit/view';
export * from './pit/leakage';
export * from './features/registry';
export * from './features/library';
export * from './strategy/versioning';
export * from './strategy/catalog';
export * from './execution/model';
export * from './risk/engine';
export * from './backtest/engine';
export * from './backtest/analysis';
export * from './backtest/synthetic';
export * from './experiments/registry';
export * from './experiments/runner';
export * from './regime/regime';
export * from './alerts/evidence';
export * from './observability/health';
export * from './observability/why';
export * from './curiosity/cases';
export * from './curiosity/hypothesis';
export * from './api/tools';
export * from './api/server';
export * from './ingest/desk-artifacts';
export * from './ingest/backtest-cache';
export * from './ingest/observer-ledger';
export * from './integration/desk-recorder';
