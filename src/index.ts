/**
 * @fin-integrity/browser — frontend tracing SDK.
 *
 * Generates a trace id for a checkout and emits lightweight breadcrumbs from the
 * browser, authenticated by a PUBLISHABLE key (safe to ship in client JS). The
 * same trace id is attached to the backend processor/ledger records so the whole
 * transaction journey — frontend → processor → ledger → db — joins by one id.
 *
 * Fail-open: never throws into your checkout. No PII: send ids and outcomes,
 * never card numbers.
 */

export interface ClientEvent {
  trace_id: string;
  name: string;
  reference?: string;
  data?: Record<string, unknown>;
  occurred_at: string;
  environment?: string;
}

export interface BrowserConfig {
  /** Publishable key (fi_pk_live_… / fi_pk_test_…). Safe to expose in the browser. */
  publicKey?: string;
  /** Ingest base URL. `/v1/client-events` is appended. */
  endpoint?: string;
  /** Environment these breadcrumbs belong to (Sentry-style). Keeps a staging
   *  frontend's breadcrumbs out of production. Server defaults to "production". */
  environment?: string;
  /** Flush interval in ms. Default 3000. */
  flushMs?: number;
  /** Max breadcrumbs per HTTP request. Default 100 (ingest hard-caps at 500). */
  maxBatchSize?: number;
  /** Max breadcrumbs held in memory. Oldest are dropped past this. Default 1000. */
  maxQueueSize?: number;
  /** Log transport activity. Default false. */
  debug?: boolean;
  /** Called on any internal error. The SDK never throws. */
  onError?: (err: unknown) => void;
  /** Override delivery (tests). Receives the batch that would be sent. */
  transport?: (batch: ClientEvent[]) => void | Promise<void>;
}

const DEFAULT_ENDPOINT = "https://ingest.fin-integrity.com";
/** Cap on retained delivered breadcrumbs — inspect() is a debugging aid, not a log. */
const SENT_HISTORY_LIMIT = 500;

/** A key that must never leave the server was handed to the browser SDK. */
export class SecretKeyError extends Error {
  constructor() {
    super(
      "fin-integrity: a SECRET key (fi_sk_…) was passed to the browser SDK. It has NOT been sent " +
        "anywhere, and client events are disabled. Secret keys must never ship in client JS — " +
        "rotate this key and use a publishable key (fi_pk_…) here.",
    );
    this.name = "SecretKeyError";
  }
}

/** Per-event rejections hiding inside an HTTP 200. Surfaced via onError, never thrown into the page. */
export class RejectedEventsError extends Error {
  constructor(
    readonly rejected: RejectedEvent[],
    readonly batchSize: number,
  ) {
    const detail = rejected.map((r) => `${r.event_id}: ${r.error}`).join("; ");
    super(`fin-integrity: ingest rejected ${rejected.length}/${batchSize} client event(s) — ${detail}`);
    this.name = "RejectedEventsError";
  }
}

export interface RejectedEvent {
  event_id: string;
  error: string;
}

export class FinIntegrityBrowser {
  private readonly publicKey: string;
  private readonly endpoint: string;
  private readonly environment?: string;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly debug: boolean;
  private readonly onError: (err: unknown) => void;
  private readonly customTransport?: BrowserConfig["transport"];
  /** Set when config is unusable for delivery (e.g. a secret key). Queueing stays alive. */
  private readonly deliveryDisabled?: Error;
  private queue: ClientEvent[] = [];
  private sent: ClientEvent[] = [];
  private dropped = 0;
  private currentTrace?: string;
  private timer?: ReturnType<typeof setInterval>;
  private listeners: Array<() => void> = [];

  constructor(config: BrowserConfig = {}) {
    // A misconfigured call must not throw on a checkout page, so tolerate junk.
    const cfg: BrowserConfig = config != null && typeof config === "object" ? config : {};
    this.debug = cfg.debug ?? false;
    this.onError = typeof cfg.onError === "function"
      ? (e) => { try { cfg.onError!(e); } catch { /* an onError that throws is still not the page's problem */ } }
      : (e) => { if (this.debug) console.warn("[fin-integrity]", e); };

    const key = typeof cfg.publicKey === "string" ? cfg.publicKey.trim() : "";
    if (key.startsWith("fi_sk_")) {
      // Never retain it: it must not reach a header, a log, or a stack trace.
      this.publicKey = "";
      this.deliveryDisabled = new SecretKeyError();
      this.onError(this.deliveryDisabled);
    } else {
      this.publicKey = key;
    }

    this.endpoint = typeof cfg.endpoint === "string" && cfg.endpoint ? cfg.endpoint : DEFAULT_ENDPOINT;
    this.environment = cleanEnvironment(cfg.environment);
    this.maxBatchSize = positiveInt(cfg.maxBatchSize, 100);
    this.maxQueueSize = positiveInt(cfg.maxQueueSize, 1000);
    this.customTransport = typeof cfg.transport === "function" ? cfg.transport : undefined;

    const flushMs = positiveInt(cfg.flushMs, 3000);
    if (typeof setInterval === "function") {
      this.timer = setInterval(() => void this.flush(), flushMs);
      // Node-only nicety: don't keep the event loop alive (no-op in browsers).
      const t = this.timer as unknown as { unref?: () => void };
      if (t && typeof t.unref === "function") t.unref();
    }
    // Drain on page hide so in-flight breadcrumbs aren't lost on navigation.
    if (typeof addEventListener === "function") {
      const drain = () => void this.flush();
      const onVisibility = () => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") drain();
      };
      addEventListener("pagehide", drain);
      addEventListener("visibilitychange", onVisibility);
      this.listeners.push(
        () => removeEventListener("pagehide", drain),
        () => removeEventListener("visibilitychange", onVisibility),
      );
    }
  }

  /**
   * Begin a traced checkout. Returns the trace id — attach it to your payment
   * (e.g. Stripe `metadata.trace_id`) and pass it to your backend `record()` so
   * every side of the transaction shares it. Emits a `checkout_started` breadcrumb.
   */
  startCheckout(opts: { reference?: string; traceId?: string; data?: Record<string, unknown> } = {}): string {
    try {
      const o = opts != null && typeof opts === "object" ? opts : {};
      this.currentTrace = typeof o.traceId === "string" && o.traceId ? o.traceId : newTraceId();
      this.breadcrumb("checkout_started", o.data, { reference: o.reference });
      return this.currentTrace;
    } catch (err) {
      this.onError(err); // fail-open — a trace id is still owed to the caller
      this.currentTrace = this.currentTrace ?? newTraceId();
      return this.currentTrace;
    }
  }

  /** The current trace id (creates one if none exists yet). */
  trace(): string {
    if (!this.currentTrace) this.currentTrace = newTraceId();
    return this.currentTrace;
  }

  /** Record a breadcrumb against the current (or a given) trace. */
  breadcrumb(
    name: string,
    data?: Record<string, unknown>,
    opts: { traceId?: string; reference?: string } = {},
  ): void {
    try {
      const o = opts != null && typeof opts === "object" ? opts : {};
      // Ingest silently skips breadcrumbs without a name, so a nameless one would
      // vanish server-side with a 200. Reject it here where it can be reported.
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("fin-integrity: breadcrumb name must be a non-empty string");
      }
      const trace_id = typeof o.traceId === "string" && o.traceId ? o.traceId : this.trace();
      this.enqueue({
        trace_id,
        name,
        ...(o.reference != null ? { reference: String(o.reference) } : {}),
        ...(data != null ? { data: safeData(data, this.onError) } : {}),
        occurred_at: new Date().toISOString(),
        ...(this.environment != null ? { environment: this.environment } : {}),
      });
    } catch (err) {
      this.onError(err); // fail-open
    }
  }

  private enqueue(ev: ClientEvent): void {
    // A hostile or looping page must not grow this queue without bound.
    while (this.queue.length >= this.maxQueueSize) {
      this.queue.shift(); // drop-oldest
      this.dropped++;
    }
    this.queue.push(ev);
  }

  /** Breadcrumbs dropped because the queue was full (never silent — also reported via onError). */
  droppedCount(): number {
    return this.dropped;
  }

  /** Send queued breadcrumbs now. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    if (this.dropped > 0) {
      const n = this.dropped;
      this.dropped = 0;
      this.onError(new Error(`fin-integrity: dropped ${n} breadcrumb(s) — queue full (maxQueueSize)`));
    }
    // Splice first: a concurrent flush must not send the same batch twice.
    const pending = this.queue.splice(0, this.queue.length);
    // Ingest hard-caps a request at 500 events and `keepalive` bodies are capped
    // at 64KB, so an oversized batch would be rejected whole. Chunk instead.
    for (let i = 0; i < pending.length; i += this.maxBatchSize) {
      const batch = pending.slice(i, i + this.maxBatchSize);
      try {
        if (this.customTransport) {
          await this.customTransport(batch);
        } else {
          await this.send(batch);
        }
        this.remember(batch);
      } catch (err) {
        this.onError(err); // fail-open: breadcrumbs are best-effort, the batch is dropped
      }
    }
  }

  private remember(batch: ClientEvent[]): void {
    this.sent.push(...batch);
    if (this.sent.length > SENT_HISTORY_LIMIT) {
      this.sent.splice(0, this.sent.length - SENT_HISTORY_LIMIT);
    }
  }

  private async send(batch: ClientEvent[]): Promise<void> {
    if (this.deliveryDisabled) throw this.deliveryDisabled;
    const url = this.endpoint.replace(/\/+$/, "") + "/v1/client-events";
    const body = JSON.stringify({ events: batch });
    if (typeof fetch !== "function") {
      throw new Error("no fetch available to deliver client events");
    }
    const res = await fetch(url, {
      method: "POST",
      keepalive: true, // survives page navigation
      headers: { "content-type": "application/json", authorization: `Bearer ${this.publicKey}` },
      body,
    });
    if (!res.ok) {
      // Ignoring the status hides a revoked key or a bad payload behind a
      // success log while every breadcrumb goes nowhere.
      throw new Error(`fin-integrity ingest ${res.status}: ${await safeText(res)}`);
    }
    // A 200 means the batch was received, NOT that every breadcrumb was stored:
    // ingest validates per event and skips the ones it can't use. Treating 200 as
    // total success hides dropped money-adjacent events behind a success log.
    const rejected = await rejectedFrom(res, batch);
    if (rejected.length > 0) throw new RejectedEventsError(rejected, batch.length);
    if (this.debug) console.log(`[fin-integrity] delivered ${batch.length} client event(s)`);
  }

  /** Drain and stop the client (timers + page listeners). Call before discarding it. */
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const off of this.listeners.splice(0, this.listeners.length)) {
      try { off(); } catch { /* fail-open */ }
    }
    await this.flush();
  }

  /** Breadcrumbs captured so far (tests / debugging). */
  inspect(): ClientEvent[] {
    return [...this.sent, ...this.queue];
  }
}

/**
 * Rejected breadcrumbs reported inside a 200 body. Ingest answers `{accepted: n}`
 * and skips what it can't store; `{results:[…]}` is the richer shape the events
 * endpoint uses. Read both — an unparseable body means nothing to report.
 */
async function rejectedFrom(res: Response, batch: ClientEvent[]): Promise<RejectedEvent[]> {
  let body: {
    accepted?: unknown;
    results?: Array<{ event_id?: string; status?: string; error?: string }>;
  };
  try {
    body = await res.clone().json();
  } catch {
    return [];
  }
  if (Array.isArray(body?.results)) {
    return body.results
      .filter((r) => r?.status === "rejected")
      .map((r) => ({ event_id: r.event_id ?? "unknown", error: r.error ?? "unknown error" }));
  }
  if (typeof body?.accepted === "number" && body.accepted < batch.length) {
    const missing = batch.length - body.accepted;
    return [{
      event_id: batch.map((e) => e.trace_id).join(","),
      error: `ingest accepted ${body.accepted}/${batch.length}; ${missing} breadcrumb(s) were not stored`,
    }];
  }
  return [];
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Breadcrumb data crosses JSON. A circular or unserializable payload would throw
 * at send time and take the whole batch — including other traces — with it, so
 * it is caught here: keep the breadcrumb (the trace is what matters), drop data.
 */
function safeData(data: Record<string, unknown>, onError: (e: unknown) => void): Record<string, unknown> {
  try {
    JSON.stringify(data);
    return data;
  } catch (err) {
    onError(err);
    return { _fi_unserializable: true };
  }
}

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Sentry-style environment validation, matching the ingest server: trimmed;
 *  <=64 chars; no whitespace or forward slash; not "none". undefined if invalid. */
function cleanEnvironment(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v || v.length > 64 || /[\s/]/.test(v) || v.toLowerCase() === "none") return undefined;
  return v;
}

function newTraceId(): string {
  return "fi_txn_" + randomHex();
}

function randomHex(): string {
  const c: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  if (c?.getRandomValues) {
    const a = new Uint8Array(16);
    c.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Last-resort fallback (non-crypto). Never used in a real browser.
  return Date.now().toString(16) + Math.floor(Math.random() * 1e16).toString(16);
}

let current: FinIntegrityBrowser | undefined;

/** Create and configure the browser client (also stored as the module singleton). */
export function init(config?: BrowserConfig): FinIntegrityBrowser {
  current = new FinIntegrityBrowser(config);
  return current;
}

/** The client from the most recent init(). */
export function getClient(): FinIntegrityBrowser {
  if (!current) throw new Error("fin-integrity: call init() before getClient()");
  return current;
}
