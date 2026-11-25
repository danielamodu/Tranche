export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  correlationId?: string;
  fields?: Record<string, unknown>;
}

const PRIVATE_KEY_RE = /\b0x[0-9a-fA-F]{64}\b/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/gi;
const SECRET_KEYS = new Set([
  "privatekey",
  "deployer_private_key",
  "apitoken",
  "agent_api_token",
  "secret",
  "password",
  "authorization",
  "x-agent-token",
  "rpc_api_key",
]);

export function redactSensitive(value: unknown, keyName?: string): unknown {
  if (keyName && SECRET_KEYS.has(keyName.toLowerCase())) {
    return "[REDACTED]";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return value.replace(BEARER_RE, "Bearer [REDACTED]").replace(PRIVATE_KEY_RE, (match) => {
      // Preserve tx hashes when key explicitly indicates a hash; redact otherwise
      if (keyName && /hash|tx/i.test(keyName)) return match;
      return "[REDACTED_HEX_64]";
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSensitive(v, k);
    }
    return out;
  }
  return value;
}

/**
 * Structured JSON logger with correlation IDs and automatic secret redaction.
 * Ensures private keys, Bearer tokens, and API credentials never leak into logs.
 */
export class StructuredLogger {
  private readonly sink: (entry: StructuredLogEntry) => void;
  private readonly entries: StructuredLogEntry[] = [];
  private readonly maxBuffer: number;

  constructor(options?: {
    sink?: (entry: StructuredLogEntry) => void;
    silent?: boolean;
    maxBuffer?: number;
  }) {
    this.maxBuffer = options?.maxBuffer ?? 500;
    this.sink =
      options?.sink ??
      ((entry) => {
        if (!options?.silent) {
          process.stdout.write(`${JSON.stringify(entry)}\n`);
        }
      });
  }

  log(level: LogLevel, event: string, fields?: Record<string, unknown>, correlationId?: string): void {
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      correlationId,
      fields: fields ? (redactSensitive(fields) as Record<string, unknown>) : undefined,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxBuffer) {
      this.entries.shift();
    }
    this.sink(entry);
  }

  info(event: string, fields?: Record<string, unknown>, correlationId?: string): void {
    this.log("info", event, fields, correlationId);
  }

  warn(event: string, fields?: Record<string, unknown>, correlationId?: string): void {
    this.log("warn", event, fields, correlationId);
  }

  error(event: string, fields?: Record<string, unknown>, correlationId?: string): void {
    this.log("error", event, fields, correlationId);
  }

  getRecentEntries(limit = 50): StructuredLogEntry[] {
    return this.entries.slice(-limit);
  }
}
