import { custom, type EIP1193RequestFn, type Transport } from "viem";

export interface RpcEndpointHealth {
  url: string;
  requests: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  cooldownUntilMs: number;
  lastError?: string;
  lastLatencyMs?: number;
}

export interface FailoverEvent {
  timestampIso: string;
  fromUrl: string;
  toUrl?: string;
  method: string;
  reason: string;
}

export interface RpcFailoverOptions {
  urls: readonly string[];
  timeoutMs?: number;
  cooldownMs?: number;
  now?: () => number;
  requester?: (url: string, method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  onFailover?: (ev: FailoverEvent) => void;
}

async function defaultJsonRpcRequest(
  url: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP_${res.status}:${res.statusText}`);
    }
    const payload = (await res.json()) as {
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    if (payload.error) {
      throw new Error(`RPC_${payload.error.code ?? "ERR"}:${payload.error.message ?? "unknown"}`);
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

export class FailoverRpcPool {
  readonly health: RpcEndpointHealth[];
  readonly events: FailoverEvent[] = [];
  private activeIndex = 0;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly requester: NonNullable<RpcFailoverOptions["requester"]>;
  private readonly onFailover?: (ev: FailoverEvent) => void;

  constructor(opts: RpcFailoverOptions) {
    if (opts.urls.length === 0) {
      throw new Error("FailoverRpcPool requires at least one RPC URL.");
    }
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.requester = opts.requester ?? defaultJsonRpcRequest;
    this.onFailover = opts.onFailover;
    this.health = opts.urls.map((url) => ({
      url,
      requests: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      cooldownUntilMs: 0,
    }));
  }

  getActiveUrl(): string {
    return this.health[this.activeIndex].url;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const tNow = this.now();
    const order: number[] = [];

    // Try active first, then healthy non-cooldown endpoints, then cooldown endpoints as last resort.
    for (let offset = 0; offset < this.health.length; offset++) {
      const idx = (this.activeIndex + offset) % this.health.length;
      if (this.health[idx].cooldownUntilMs <= tNow) order.push(idx);
    }
    for (let offset = 0; offset < this.health.length; offset++) {
      const idx = (this.activeIndex + offset) % this.health.length;
      if (this.health[idx].cooldownUntilMs > tNow) order.push(idx);
    }

    const errors: string[] = [];
    for (let i = 0; i < order.length; i++) {
      const idx = order[i];
      const ep = this.health[idx];
      ep.requests++;
      const t0 = this.now();
      try {
        const result = await this.requester(ep.url, method, params, this.timeoutMs);
        ep.successes++;
        ep.consecutiveFailures = 0;
        ep.cooldownUntilMs = 0;
        ep.lastLatencyMs = Math.max(0, this.now() - t0);
        if (idx !== this.activeIndex) {
          const prevUrl = this.health[this.activeIndex].url;
          this.activeIndex = idx;
          this.recordEvent({
            timestampIso: new Date(this.now()).toISOString(),
            fromUrl: prevUrl,
            toUrl: ep.url,
            method,
            reason: `Recovered/switched after error(s): ${errors.join(" | ")}`,
          });
        }
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ep.failures++;
        ep.consecutiveFailures++;
        ep.cooldownUntilMs = this.now() + this.cooldownMs;
        ep.lastError = msg;
        errors.push(`${ep.url} => ${msg}`);
        if (i === 0 && order.length > 1) {
          this.recordEvent({
            timestampIso: new Date(this.now()).toISOString(),
            fromUrl: ep.url,
            toUrl: this.health[order[1]].url,
            method,
            reason: msg,
          });
        }
      }
    }

    throw new Error(`All RPC endpoints failed for ${method}: ${errors.join("; ")}`);
  }

  toViemTransport(): Transport {
    return () =>
      custom({
        request: (async ({ method, params }) => {
          return this.request(method, params);
        }) as EIP1193RequestFn,
      })({});
  }

  private recordEvent(ev: FailoverEvent): void {
    this.events.push(ev);
    this.onFailover?.(ev);
  }
}
