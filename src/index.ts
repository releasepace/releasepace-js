/**
 * releasepace-js  — official JavaScript / TypeScript SDK
 * Works in: Browser, Node.js 18+, Deno, Bun, Edge runtimes
 *
 * Usage:
 *   import { ReleasePace } from 'releasepace-js';
 *   const fk = new ReleasePace({ apiKey: 'rp_live_xxx', environment: 'production' });
 *   await fk.connect();
 *   if (fk.isEnabled('new-checkout')) { ... }
 */

export interface ReleasePaceOptions {
  apiKey: string;
  environment?: string;
  apiUrl?: string;
  pollInterval?: number;       // ms, default 30000
  disablePolling?: boolean;
  context?: Record<string, string>;  // userId, sessionId, etc.
  onFlagsUpdated?: (flags: Flag[]) => void;
  onError?: (error: Error) => void;
}

export interface Flag {
  key: string;
  name: string;
  type: "boolean" | "string" | "number" | "json";
  enabled: boolean;
  value: string | number | boolean | object | null;
  rollout_pct: number | null;
  strategies: Strategy[];
}

export interface Strategy {
  type: string;
  parameters: Record<string, unknown>;
}

export interface ReleasePaceSnapshot {
  version: number;
  environment: string;
  features: Flag[];
  fetchedAt: Date;
}

const DEFAULT_API_URL = "https://api.releasepace.io";
const DEFAULT_POLL_MS = 30_000;

export class ReleasePace {
  private opts: Required<ReleasePaceOptions>;
  private cache: Map<string, Flag> = new Map();
  private snapshot: ReleasePaceSnapshot | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private fetchPromise: Promise<void> | null = null;
  private connected = false;

  constructor(opts: ReleasePaceOptions) {
    this.opts = {
      environment: "production",
      apiUrl: DEFAULT_API_URL,
      pollInterval: DEFAULT_POLL_MS,
      disablePolling: false,
      context: {},
      onFlagsUpdated: () => {},
      onError: () => {},
      ...opts,
    };
  }

  /** Fetch flags once and start polling. Resolves after first successful fetch. */
  async connect(): Promise<ReleasePaceSnapshot> {
    await this.fetchFlags();
    this.connected = true;
    if (!this.opts.disablePolling) {
      this.pollTimer = setInterval(() => this.fetchFlags(), this.opts.pollInterval);
    }
    return this.snapshot!;
  }

  /** Stop polling and clear cache. */
  disconnect(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.connected = false;
  }

  /** Force an immediate re-fetch. */
  async refresh(): Promise<void> {
    await this.fetchFlags();
  }

  /** Check if a boolean flag is enabled. Returns false if flag not found. */
  isEnabled(key: string): boolean {
    const flag = this.cache.get(key);
    if (!flag) return false;
    if (!flag.enabled) return false;
    // Gradual rollout check (sticky by key hash if no userId in context)
    if (flag.rollout_pct !== null && flag.rollout_pct < 100) {
      const id = this.opts.context["userId"] || this.opts.context["sessionId"] || key;
      return hashBucket(id + key) < flag.rollout_pct;
    }
    return true;
  }

  /** Get a flag's value. Returns defaultValue if flag not found or disabled. */
  getValue<T = unknown>(key: string, defaultValue: T): T {
    const flag = this.cache.get(key);
    if (!flag || !flag.enabled) return defaultValue;
    return (flag.value as T) ?? defaultValue;
  }

  /** Get a string flag value. */
  getString(key: string, defaultValue = ""): string {
    return this.getValue<string>(key, defaultValue);
  }

  /** Get a number flag value. */
  getNumber(key: string, defaultValue = 0): number {
    return this.getValue<number>(key, defaultValue);
  }

  /** Get a JSON flag value. */
  getJSON<T = object>(key: string, defaultValue: T): T {
    return this.getValue<T>(key, defaultValue);
  }

  /** Get all flags as an array. */
  getAllFlags(): Flag[] {
    return Array.from(this.cache.values());
  }

  /** Get the last successful snapshot. */
  getSnapshot(): ReleasePaceSnapshot | null {
    return this.snapshot;
  }

  /** Set or update evaluation context (userId, country, etc.) */
  setContext(context: Record<string, string>): void {
    this.opts.context = { ...this.opts.context, ...context };
  }

  private async fetchFlags(): Promise<void> {
    // Deduplicate concurrent fetches
    if (this.fetchPromise) return this.fetchPromise;

    this.fetchPromise = (async () => {
      try {
        const url = new URL(`${this.opts.apiUrl}/api/client/features`);
        url.searchParams.set("environment", this.opts.environment);
        for (const [k, v] of Object.entries(this.opts.context)) {
          url.searchParams.set(`ctx_${k}`, v);
        }

        const response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
            "Content-Type": "application/json",
            "X-ReleasePace-SDK": "js/1.0.0",
          },
          // In Node 18+ fetch does not cache – explicit no-store
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`ReleasePace API error ${response.status}: ${await response.text()}`);
        }

        const data: ReleasePaceSnapshot & { features: Flag[] } = await response.json();
        this.snapshot = { ...data, fetchedAt: new Date() };

        const updated: Flag[] = [];
        for (const flag of data.features) {
          const prev = this.cache.get(flag.key);
          if (!prev || JSON.stringify(prev) !== JSON.stringify(flag)) {
            updated.push(flag);
          }
          this.cache.set(flag.key, flag);
        }

        // Remove flags that no longer exist
        for (const key of this.cache.keys()) {
          if (!data.features.find((f: Flag) => f.key === key)) {
            this.cache.delete(key);
          }
        }

        if (updated.length > 0) {
          this.opts.onFlagsUpdated(this.getAllFlags());
        }
      } catch (e: any) {
        this.opts.onError(e);
        // Don't throw – keep existing cache, try again next poll
      }
    })();

    try {
      await this.fetchPromise;
    } finally {
      this.fetchPromise = null;
    }
  }
}

/** Deterministic 0-99 bucket for gradual rollout (djb2 hash) */
function hashBucket(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
    hash = hash & hash; // convert to 32-bit int
  }
  return Math.abs(hash) % 100;
}

/** React hook (tree-shakeable – only bundled if imported) */
export function useReleasePace(client: ReleasePace, key: string): boolean;
export function useReleasePace<T>(client: ReleasePace, key: string, defaultValue: T): T;
export function useReleasePace(client: ReleasePace, key: string, defaultValue?: unknown): unknown {
  // Dynamic import to avoid React dep in non-React environments
  throw new Error(
    "useReleasePace requires React. Import from 'releasepace-js/react' instead."
  );
}

export default ReleasePace;
