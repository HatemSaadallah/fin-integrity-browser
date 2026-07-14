import { describe, it, expect } from "vitest";
import { FinIntegrityBrowser } from "../src/index";

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
    const sent: unknown[][] = [];
    const fi = new FinIntegrityBrowser({ transport: (b) => { sent.push(b); } });
    fi.breadcrumb("checkout_started");
    await fi.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
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
