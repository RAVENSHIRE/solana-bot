import { AsyncLocalStorage } from 'node:async_hooks';
import type { Category } from './data-types';

export const requestScope = new AsyncLocalStorage<{ category: Category; strategy?: string; signal?: AbortSignal }>();
export const priority = (): number => ({ execution: 0, position: 1, analysis: 2, discovery: 3, history: 4 })[requestScope.getStore()?.category ?? 'analysis'];
export function checkTask(): void { requestScope.getStore()?.signal?.throwIfAborted(); }
/** Reserve a request slot for position/execution work. Running requests are never interrupted. */
export class RequestGate {
  private active = 0; private ordinary = 0;
  private readonly pending: Array<{ rank: number; run: () => void }> = [];
  constructor(private readonly max = 4) { if (!Number.isInteger(max) || max < 1) throw new Error('Invalid concurrency'); }
  async run<T>(work: () => Promise<T>, rank = priority()): Promise<T> {
    const scope = requestScope.getStore();
    return new Promise<T>((resolve, reject) => {
      if (this.pending.length >= 256) { reject(new Error('Request queue capacity exceeded')); return; }
      const start = () => {
        this.active++; if (rank >= 2) this.ordinary++;
        void Promise.resolve().then(() => requestScope.run(scope ?? { category: 'analysis' }, work)).then(resolve, reject).finally(() => { this.active--; if (rank >= 2) this.ordinary--; this.drain(); });
      };
      this.pending.push({ rank, run: start }); this.drain();
    });
  }
  private drain(): void {
    this.pending.sort((a, b) => a.rank - b.rank);
    while (this.active < this.max) {
      const index = this.pending.findIndex(p => p.rank < 2 || this.ordinary < Math.max(1, this.max - 1));
      if (index < 0) break;
      this.pending.splice(index, 1)[0]!.run();
    }
  }
}
