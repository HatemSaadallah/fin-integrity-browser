import { describe, it, expect, vi, afterEach } from "vitest";
import { FinIntegrityBrowser, RejectedEventsError, SecretKeyError, init, getClient } from "../src/index";
import type { ClientEvent } from "../src/index";

/** Collects batches a flush would deliver. */
function capture() {
  const sent: ClientEvent[][] = [];
  return { sent, transport: (b: ClientEvent[]) => { sent.push(b); }, flat: () => sent.flat() };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FinIntegrityBrowser", () => {
  it("startCheckout returns a trace id and emits checkout_started", () => {
    const fi = new FinIntegrityBrowser({ transport: () => {} });
    const traceId = fi.startCheckout({ reference: "order_1" });
    expect(traceId).toMatch(/^fi_txn_/);
    const events = fi.inspect();
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("checkout_started");
    expect(events[0].reference).toBe("order_1");
    expect(events[0].trace_id).toBe(traceId);
  });

  it("tags breadcrumbs with a configured environment", () => {
    const fi = new FinIntegrityBrowser({ transport: () => {}, environment: "staging" });
    fi.breadcrumb("checkout_started");
    expect(fi.inspect()[0].environment).toBe("staging");
  });

  it("omits environment when unset (server defaults to production)", () => {
    const fi = new FinIntegrityBrowser({ transport: () => {} });
    fi.breadcrumb("checkout_started");
    expect(fi.inspect()[0].environment).toBeUndefined();
  });

  it("drops an invalid environment rather than sending a bad tag", () => {
    const fi = new FinIntegrityBrowser({ transport: () => {}, environment: "bad env" });
    fi.breadcrumb("checkout_started");
    expect(fi.inspect()[0].environment).toBeUndefined();
  });

  it("breadcrumbs share the current trace id", () => {
    const fi = new FinIntegrityBrowser({ transport: () => {} });
    const traceId = fi.startCheckout();
    fi.breadcrumb("redirect_to_processor");
    fi.breadcrumb("client_confirmed", { last4: "4242" });
    const events = fi.inspect();
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.trace_id))).toEqual(new Set([traceId]));
    expect(events[2].data).toEqual({ last4: "4242" });
  });

  it("flush delivers the batch through the transport and never throws", async () => {
    const t = capture();
    const fi = new FinIntegrityBrowser({ transport: t.transport });
    fi.breadcrumb("checkout_started");
    await fi.flush();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toHaveLength(1);
  });

  it("is fail-open: a throwing transport does not propagate", async () => {
    const errors: unknown[] = [];
    const fi = new FinIntegrityBrowser({
      transport: () => { throw new Error("network down"); },
      onError: (e) => errors.push(e),
    });
    fi.breadcrumb("x");
    await expect(fi.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe("trace id", () => {
  it("mints unique ids", () => {
    const fi = new FinIntegrityBrowser({ transport: () => {} });
    const ids = new Set(Array.from({ length: 500 }, () => new FinIntegrityBrowser({ transport: () => {} }).trace()));
    expect(ids.size).toBe(500);
    expect(fi.trace()).toMatch(/^fi_txn_[0-9a-f]{32}$/);
  });

  it("a second startCheckout starts a new trace and does not leak the previous one", () => {
    const fi = new FinIntegrityBrowser({ transport: () => {} });
    const first = fi.startCheckout({ reference: "order_1" });
    fi.breadcrumb("card_entered");
    const second = fi.startCheckout({ reference: "order_2" });
    fi.breadcrumb("card_entered");

    expect(second).not.toBe(first);
    expect(fi.trace()).toBe(second);
    const byTrace = (id: string) => fi.inspect().filter((e) => e.trace_id === id).map((e) => e.name);
    // The first attempt's breadcrumbs stay on the first trace — they are not
    // retroactively rewritten, and nothing from it bleeds into the second.
    expect(byTrace(first)).toEqual(["checkout_started", "card_entered"]);
    expect(byTrace(second)).toEqual(["checkout_started", "card_entered"]);
  });

  it("honours a caller-supplied trace id (backend originated the trace)", () => {
    const fi = new FinIntegrityBrowser({ transport: () => {} });
    const id = fi.startCheckout({ traceId: "fi_txn_from_backend" });
    expect(id).toBe("fi_txn_from_backend");
    expect(fi.inspect()[0].trace_id).toBe("fi_txn_from_backend");
  });

  it("breadcrumbs before any startCheckout get an implicit trace, which startCheckout then supersedes", () => {
    const fi = new FinIntegrityBrowser({ transport: () => {} });
    fi.breadcrumb("page_view");
    const implicit = fi.inspect()[0].trace_id;
    expect(implicit).toMatch(/^fi_txn_/);
    const checkout = fi.startCheckout();
    expect(checkout).not.toBe(implicit); // pre-checkout crumbs are not part of the checkout trace
  });

  it("the trace survives across flushes", async () => {
    const t = capture();
    const fi = new FinIntegrityBrowser({ transport: t.transport });
    const traceId = fi.startCheckout();
    await fi.flush();
    fi.breadcrumb("processor_returned");
    await fi.flush();
    expect(t.sent).toHaveLength(2);
    expect(t.flat().map((e) => e.trace_id)).toEqual([traceId, traceId]);
    expect(fi.trace()).toBe(traceId);
  });
});

describe("fail-open contract", () => {
  it("survives junk config without throwing into the page", () => {
    expect(() => new FinIntegrityBrowser(null as never)).not.toThrow();
    expect(() => new FinIntegrityBrowser("nonsense" as never)).not.toThrow();
    expect(() => new FinIntegrityBrowser({ flushMs: -1, onError: "not a function" as never })).not.toThrow();
    expect(() => new FinIntegrityBrowser({ transport: "nope" as never }).breadcrumb("x")).not.toThrow();
    expect(new FinIntegrityBrowser(null as never).startCheckout()).toMatch(/^fi_txn_/);
  });

  it("an onError that itself throws does not reach the page", async () => {
    const fi = new FinIntegrityBrowser({
      transport: () => { throw new Error("network down"); },
      onError: () => { throw new Error("bad handler"); },
    });
    fi.breadcrumb("x");
    await expect(fi.flush()).resolves.toBeUndefined();
  });

  it("a rejecting async transport is caught", async () => {
    const errors: unknown[] = [];
    const fi = new FinIntegrityBrowser({
      transport: async () => { throw new Error("fetch rejected"); },
      onError: (e) => errors.push(e),
    });
    fi.breadcrumb("x");
    await expect(fi.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("a nameless breadcrumb is rejected here, not silently skipped by ingest", () => {
    const errors: unknown[] = [];
    const fi = new FinIntegrityBrowser({ transport: () => {}, onError: (e) => errors.push(e) });
    expect(() => fi.breadcrumb("")).not.toThrow();
    expect(() => fi.breadcrumb(undefined as never)).not.toThrow();
    expect(fi.inspect()).toHaveLength(0); // never queued — ingest would drop it inside a 200
    expect(errors).toHaveLength(2);
  });

  it("a circular payload keeps its breadcrumb and does not poison the rest of the batch", async () => {
    const errors: unknown[] = [];
    const t = capture();
    const fi = new FinIntegrityBrowser({ transport: t.transport, onError: (e) => errors.push(e) });
    const circular: Record<string, unknown> = { order: "o1" };
    circular.self = circular;
    const traceId = fi.startCheckout();
    expect(() => fi.breadcrumb("client_confirmed", circular)).not.toThrow();
    fi.breadcrumb("done");
    await fi.flush();

    const delivered = t.flat();
    expect(delivered).toHaveLength(3); // the good crumbs still went out
    expect(delivered[1].data).toEqual({ _fi_unserializable: true });
    expect(delivered.every((e) => e.trace_id === traceId)).toBe(true);
    expect(() => JSON.stringify({ events: delivered })).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it("tolerates null/odd breadcrumb args", () => {
    const fi = new FinIntegrityBrowser({ transport: () => {} });
    expect(() => fi.breadcrumb("a", null as never)).not.toThrow();
    expect(() => fi.breadcrumb("b", undefined, null as never)).not.toThrow();
    expect(() => fi.startCheckout(null as never)).not.toThrow();
    expect(fi.inspect().map((e) => e.name)).toEqual(["a", "b", "checkout_started"]);
  });

  it("no fetch in the environment fails open", async () => {
    const errors: unknown[] = [];
    vi.stubGlobal("fetch", undefined);
    const fi = new FinIntegrityBrowser({ publicKey: "fi_pk_test_1", onError: (e) => errors.push(e) });
    fi.breadcrumb("x");
    await expect(fi.flush()).resolves.toBeUndefined();
    expect(String(errors[0])).toContain("no fetch");
  });

  it("a rejecting fetch fails open", async () => {
    const errors: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("NetworkError")));
    const fi = new FinIntegrityBrowser({ publicKey: "fi_pk_test_1", onError: (e) => errors.push(e) });
    fi.breadcrumb("x");
    await expect(fi.flush()).resolves.toBeUndefined();
    expect(String(errors[0])).toContain("NetworkError");
  });
});

describe("publishable key handling", () => {
  it("sends a publishable key as a bearer token to /v1/client-events", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ accepted: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const fi = new FinIntegrityBrowser({ publicKey: "fi_pk_test_abc", endpoint: "https://ingest.example.com/" });
    fi.startCheckout({ reference: "order_1" });
    await fi.flush();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ingest.example.com/v1/client-events"); // trailing slash collapsed
    expect(opts.headers.authorization).toBe("Bearer fi_pk_test_abc");
    expect(opts.keepalive).toBe(true);
  });

  it("REFUSES a secret key: never transmits it, disables delivery, still does not throw", async () => {
    const errors: unknown[] = [];
    const fetchMock = vi.fn().mockResolvedValue(json({ accepted: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    let fi!: FinIntegrityBrowser;
    expect(() => { fi = new FinIntegrityBrowser({ publicKey: "fi_sk_live_supersecret", onError: (e) => errors.push(e) }); })
      .not.toThrow();
    expect(errors[0]).toBeInstanceOf(SecretKeyError);

    const traceId = fi.startCheckout({ reference: "order_1" });
    expect(traceId).toMatch(/^fi_txn_/); // the page keeps working
    await expect(fi.flush()).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled(); // the secret never left the page
    expect(errors.some((e) => e instanceof SecretKeyError)).toBe(true);
    expect(JSON.stringify(errors)).not.toContain("supersecret");
    expect(errors.map(String).join(" ")).not.toContain("supersecret");
  });

  it("a secret key does not disable the trace id itself", () => {
    const fi = new FinIntegrityBrowser({ publicKey: "fi_sk_live_x", onError: () => {} });
    fi.breadcrumb("card_entered");
    expect(fi.inspect()).toHaveLength(1);
    expect(fi.trace()).toMatch(/^fi_txn_/);
  });
});

describe("delivery and the 200-is-not-success trap", () => {
  it("surfaces per-event rejections hidden inside a 200 (accepted < sent)", async () => {
    const errors: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ accepted: 1 })));
    const fi = new FinIntegrityBrowser({ publicKey: "fi_pk_test_1", onError: (e) => errors.push(e) });
    fi.startCheckout();
    fi.breadcrumb("client_confirmed");
    fi.breadcrumb("done");
    await fi.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RejectedEventsError);
    expect((errors[0] as RejectedEventsError).batchSize).toBe(3);
    expect(String(errors[0])).toContain("accepted 1/3");
  });

  it("a fully accepted 200 reports nothing", async () => {
    const errors: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ accepted: 2 })));
    const fi = new FinIntegrityBrowser({ publicKey: "fi_pk_test_1", onError: (e) => errors.push(e) });
    fi.startCheckout();
    fi.breadcrumb("done");
    await fi.flush();
    expect(errors).toEqual([]);
  });

  it("surfaces a `results` rejection body inside a 200", async () => {
    const errors: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      results: [
        { event_id: "e1", status: "accepted" },
        { event_id: "e2", status: "rejected", error: "missing trace_id" },
      ],
    })));
    const fi = new FinIntegrityBrowser({ publicKey: "fi_pk_test_1", onError: (e) => errors.push(e) });
    fi.startCheckout();
    fi.breadcrumb("done");
    await fi.flush();

    expect(errors[0]).toBeInstanceOf(RejectedEventsError);
    expect((errors[0] as RejectedEventsError).rejected).toEqual([{ event_id: "e2", error: "missing trace_id" }]);
  });

  it("an unparseable 200 body is not treated as a rejection", async () => {
    const errors: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("OK", { status: 200 })));
    const fi = new FinIntegrityBrowser({ publicKey: "fi_pk_test_1", onError: (e) => errors.push(e) });
    fi.breadcrumb("x");
    await fi.flush();
    expect(errors).toEqual([]);
  });

  it("a non-2xx (revoked key) is reported instead of being read as success", async () => {
    const errors: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "invalid or revoked publishable key" }, 401)));
    const fi = new FinIntegrityBrowser({ publicKey: "fi_pk_test_revoked", onError: (e) => errors.push(e) });
    fi.startCheckout();
    await expect(fi.flush()).resolves.toBeUndefined();
    expect(String(errors[0])).toContain("401");
    expect(String(errors[0])).toContain("revoked");
  });

  it("emits the envelope ingestClientEvents accepts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ accepted: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const fi = new FinIntegrityBrowser({ publicKey: "fi_pk_test_1" });
    const traceId = fi.startCheckout({ reference: "order_1", data: { cart: 3 } });
    await fi.flush();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events[0]).toEqual({
      trace_id: traceId,
      name: "checkout_started",
      reference: "order_1",
      data: { cart: 3 },
      occurred_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
    // ingest skips any event lacking trace_id or name — neither may be empty.
    expect(body.events.every((e: ClientEvent) => e.trace_id && e.name)).toBe(true);
  });
});

describe("queue and batching", () => {
  it("chunks a batch below the ingest request cap", async () => {
    const t = capture();
    const fi = new FinIntegrityBrowser({ transport: t.transport, maxBatchSize: 10 });
    for (let i = 0; i < 25; i++) fi.breadcrumb(`step_${i}`);
    await fi.flush();
    expect(t.sent.map((b) => b.length)).toEqual([10, 10, 5]);
    expect(t.flat()).toHaveLength(25); // nothing lost in the chunking
  });

  it("caps the queue, drops oldest, and reports the drop rather than hiding it", async () => {
    const errors: unknown[] = [];
    const t = capture();
    const fi = new FinIntegrityBrowser({ transport: t.transport, maxQueueSize: 5, onError: (e) => errors.push(e) });
    for (let i = 0; i < 8; i++) fi.breadcrumb(`step_${i}`);
    expect(fi.droppedCount()).toBe(3);
    await fi.flush();
    expect(t.flat().map((e) => e.name)).toEqual(["step_3", "step_4", "step_5", "step_6", "step_7"]);
    expect(String(errors[0])).toContain("dropped 3");
  });

  it("does not grow memory without bound on a long-lived page", async () => {
    const fi = new FinIntegrityBrowser({ transport: () => {} });
    for (let i = 0; i < 1200; i++) {
      fi.breadcrumb(`step_${i}`);
      await fi.flush();
    }
    expect(fi.inspect().length).toBeLessThanOrEqual(500);
  });

  it("concurrent flushes do not deliver the same breadcrumb twice", async () => {
    const t = capture();
    const fi = new FinIntegrityBrowser({
      transport: async (b) => { await new Promise((r) => setTimeout(r, 5)); t.sent.push(b); },
    });
    fi.startCheckout();
    fi.breadcrumb("client_confirmed");
    await Promise.all([fi.flush(), fi.flush(), fi.flush()]);
    expect(t.flat()).toHaveLength(2);
    expect(t.flat().map((e) => e.name)).toEqual(["checkout_started", "client_confirmed"]);
  });

  it("flushing an empty queue is a no-op", async () => {
    const t = capture();
    const fi = new FinIntegrityBrowser({ transport: t.transport });
    await fi.flush();
    fi.breadcrumb("x");
    await fi.flush();
    await fi.flush();
    expect(t.sent).toHaveLength(1);
  });

  it("a failed flush drops the batch but never does so silently", async () => {
    // Breadcrumbs are best-effort by contract (same as the node SDK): a failed
    // batch is not retried. It must always reach onError, never vanish quietly.
    const errors: unknown[] = [];
    let fail = true;
    const t = capture();
    const fi = new FinIntegrityBrowser({
      transport: (b) => { if (fail) throw new Error("offline"); t.sent.push(b); },
      onError: (e) => errors.push(e),
    });
    fi.breadcrumb("lost_one");
    await fi.flush();
    expect(errors).toHaveLength(1);

    fail = false;
    fi.breadcrumb("next_one");
    await fi.flush();
    expect(t.flat().map((e) => e.name)).toEqual(["next_one"]); // dropped, not retried
  });

  it("one failing chunk does not stop later chunks", async () => {
    const t = capture();
    let n = 0;
    const fi = new FinIntegrityBrowser({
      transport: (b) => { if (n++ === 0) throw new Error("blip"); t.sent.push(b); },
      maxBatchSize: 2,
      onError: () => {},
    });
    for (let i = 0; i < 6; i++) fi.breadcrumb(`step_${i}`);
    await fi.flush();
    expect(t.flat().map((e) => e.name)).toEqual(["step_2", "step_3", "step_4", "step_5"]);
  });
});

describe("page lifecycle", () => {
  it("drains on pagehide and when the page is hidden", async () => {
    const handlers: Record<string, Array<() => void>> = {};
    vi.stubGlobal("addEventListener", (ev: string, fn: () => void) => { (handlers[ev] ??= []).push(fn); });
    vi.stubGlobal("removeEventListener", () => {});
    vi.stubGlobal("document", { visibilityState: "visible" });

    const t = capture();
    const fi = new FinIntegrityBrowser({ transport: t.transport });
    fi.startCheckout();

    handlers.visibilitychange!.forEach((h) => h()); // still visible — nothing to drain
    await Promise.resolve();
    expect(t.sent).toHaveLength(0);

    vi.stubGlobal("document", { visibilityState: "hidden" });
    handlers.visibilitychange!.forEach((h) => h());
    await Promise.resolve();
    expect(t.flat().map((e) => e.name)).toEqual(["checkout_started"]);

    fi.breadcrumb("redirect_to_processor");
    handlers.pagehide!.forEach((h) => h()); // navigating away mid-checkout
    await Promise.resolve();
    expect(t.flat().map((e) => e.name)).toEqual(["checkout_started", "redirect_to_processor"]);
  });

  it("shutdown drains and detaches, leaving no timer or listener behind", async () => {
    const removed: string[] = [];
    vi.stubGlobal("addEventListener", () => {});
    vi.stubGlobal("removeEventListener", (ev: string) => { removed.push(ev); });

    const t = capture();
    const fi = new FinIntegrityBrowser({ transport: t.transport, flushMs: 1 });
    fi.breadcrumb("last_crumb");
    await fi.shutdown();

    expect(t.flat().map((e) => e.name)).toEqual(["last_crumb"]); // drained on the way out
    expect(new Set(removed)).toEqual(new Set(["pagehide", "visibilitychange"]));

    await new Promise((r) => setTimeout(r, 10));
    fi.breadcrumb("after_shutdown");
    await new Promise((r) => setTimeout(r, 10));
    expect(t.flat()).toHaveLength(1); // the interval is really gone
  });
});

describe("module singleton", () => {
  it("init replaces the current client and getClient returns it", () => {
    const a = init({ transport: () => {} });
    expect(getClient()).toBe(a);
    const b = init({ transport: () => {} });
    expect(getClient()).toBe(b);
    expect(b).not.toBe(a);
  });
});
