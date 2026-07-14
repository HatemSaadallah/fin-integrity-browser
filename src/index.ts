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
}

export interface BrowserConfig {
  /** Publishable key (fi_pk_live_… / fi_pk_test_…). Safe to expose in the browser. */
  publicKey?: string;
  /** Ingest base URL. `/v1/client-events` is appended. */
  endpoint?: string;
  /** Flush interval in ms. Default 3000. */
  flushMs?: number;
  /** Log transport activity. Default false. */
  debug?: boolean;
  /** Called on any internal error. The SDK never throws. */
  onError?: (err: unknown) => void;
  /** Override delivery (tests). Receives the batch that would be sent. */
  transport?: (batch: ClientEvent[]) => void | Promise<void>;
}

const DEFAULT_ENDPOINT = "https://ingest.fin-integrity.com";

export class FinIntegrityBrowser {
  private readonly publicKey: string;
  private readonly endpoint: string;
  private readonly debug: boolean;
  private readonly onError: (err: unknown) => void;
  private readonly customTransport?: BrowserConfig["transport"];
  private queue: ClientEvent[] = [];
  private sent: ClientEvent[] = [];
  private currentTrace?: string;
  private timer?: ReturnType<typeof setInterval>;

  constructor(config: BrowserConfig = {}) {
    this.publicKey = config.publicKey ?? "";
    this.endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    this.debug = config.debug ?? false;
    this.onError = config.onError ?? ((e) => { if (this.debug) console.warn("[fin-integrity]", e); });
    this.customTransport = config.transport;

    const flushMs = config.flushMs ?? 3000;
    if (typeof setInterval === "function") {
      this.timer = setInterval(() => void this.flush(), flushMs);
      // Node-only nicety: don't keep the event loop alive (no-op in browsers).
      const t = this.timer as unknown as { unref?: () => void };
      if (t && typeof t.unref === "function") t.unref();
    }
    // Drain on page hide so in-flight breadcrumbs aren't lost on navigation.
    if (typeof addEventListener === "function") {
      const drain = () => void this.flush();
      addEventListener("pagehide", drain);
      addEventListener("visibilitychange", () => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") drain();
      });
    }
  }

  /**
   * Begin a traced checkout. Returns the trace id — attach it to your payment
   * (e.g. Stripe `metadata.trace_id`) and pass it to your backend `record()` so
   * every side of the transaction shares it. Emits a `checkout_started` breadcrumb.
   */
  startCheckout(opts: { reference?: string; traceId?: string; data?: Record<string, unknown> } = {}): string {
    this.currentTrace = opts.traceId ?? newTraceId();
    this.breadcrumb("checkout_started", opts.data, { reference: opts.reference });
    return this.currentTrace;
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
      const trace_id = opts.traceId ?? this.trace();
      this.queue.push({
        trace_id,
        name,
        ...(opts.reference != null ? { reference: opts.reference } : {}),
        ...(data != null ? { data } : {}),
        occurred_at: new Date().toISOString(),
      });
    } catch (err) {
      this.onError(err); // fail-open
    }
  }

  /** Send queued breadcrumbs now. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      if (this.customTransport) {
        await this.customTransport(batch);
      } else {
        await this.send(batch);
      }
      this.sent.push(...batch);
    } catch (err) {
      this.onError(err); // fail-open: breadcrumbs are best-effort
    }
  }

  private async send(batch: ClientEvent[]): Promise<void> {
    const url = this.endpoint.replace(/\/+$/, "") + "/v1/client-events";
    const body = JSON.stringify({ events: batch });
    if (typeof fetch === "function") {
      await fetch(url, {
        method: "POST",
        keepalive: true, // survives page navigation
        headers: { "content-type": "application/json", authorization: `Bearer ${this.publicKey}` },
        body,
      });
    } else {
      throw new Error("no fetch available to deliver client events");
    }
  }

  /** Breadcrumbs captured so far (tests / debugging). */
  inspect(): ClientEvent[] {
    return [...this.sent, ...this.queue];
  }
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
