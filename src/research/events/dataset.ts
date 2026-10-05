import { contentId, sha256Hex } from '../core/canonical';
import { computeStats, matches, timeOrder, type EventFilter, type StoreStats } from './store';
import type { ResearchEvent } from './types';

/**
 * A dataset is a fixed set of events. Its version is the hash of exactly which events are in it (and how they were
 * selected), so "dataset ds_…" always means the same rows. New data means a new version, which is also the only way to
 * get an unused holdout (experiments/registry).
 */
export interface DatasetManifest {
  dataset_version: string;
  description: string;
  created_at: number;
  /** The selection, as data (EventFilter without functions). */
  filter: EventFilter;
  excluded_tokens: string[];
  event_count: number;
  token_count: number;
  first_timestamp: number | null;
  last_timestamp: number | null;
  content_hash: string;
  stats: StoreStats;
}

export function buildDataset(events: readonly ResearchEvent[], o: { description: string; createdAt: number; filter?: EventFilter; excludeTokens?: readonly string[] }):
  { manifest: DatasetManifest; events: ResearchEvent[] } {
  const filter = o.filter ?? {}, excluded = [...new Set(o.excludeTokens ?? [])].sort();
  const selected = events.filter(e => matches(e, filter) && !(e.token && excluded.includes(e.token))).sort(timeOrder);
  const ids = [...new Set(selected.map(e => e.event_id))].sort();
  const content_hash = sha256Hex(ids.join('\n'));
  const stats = computeStats(selected);
  return {
    events: selected,
    manifest: {
      dataset_version: contentId('ds', { content_hash, filter, excluded }), description: o.description, created_at: o.createdAt, filter, excluded_tokens: excluded,
      event_count: selected.length, token_count: new Set(selected.map(e => e.token).filter(t => t && !t.startsWith('REF:'))).size,
      first_timestamp: stats.firstTimestamp, last_timestamp: stats.lastTimestamp, content_hash, stats,
    },
  };
}
