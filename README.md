# @fin-integrity/browser

Frontend tracing SDK for [**fin-integrity**](https://github.com/HatemSaadallah/fin-integrity-node) — trace a transaction from the browser all the way to your ledger.

The browser SDK generates a **trace id** for a checkout and emits lightweight breadcrumbs, authenticated by a **publishable key** (safe to ship in client JS). Attach the same trace id to your backend `record()` calls and every side of the transaction — frontend → processor → ledger → payout → db — joins by one id.

- Publishable-key auth (`fi_pk_…`) — no secrets in the browser
- Fail-open — never throws into your checkout
- Tiny, dependency-free, batched, flushes on page-hide via `fetch(keepalive)`
- No PII — send ids and outcomes, never card numbers

## Install

```bash
npm install @fin-integrity/browser
```

## Usage

```ts
import { init } from "@fin-integrity/browser";

const fi = init({ publicKey: "fi_pk_live_…" });

// 1) start a traced checkout — keep the trace id
const traceId = fi.startCheckout({ reference: "order_10432" });

// 2) attach it to the payment so the backend shares it
await stripe.confirmPayment({
  // …,
  metadata: { reference: "order_10432", trace_id: traceId },
});

// 3) breadcrumbs along the way
fi.breadcrumb("redirect_to_processor");
fi.breadcrumb("client_confirmed");
```

Then on your **backend**, pass the same trace id to [`@fin-integrity/node`](https://github.com/HatemSaadallah/fin-integrity-node) (or the Python SDK):

```ts
fi.processor.record({
  type: "payment", reference: "order_10432", external_id: "ch_123",
  amount: { minor: 4999, currency: "usd" },
  traceId,            // <-- same id as the browser
});
```

Now a single query by `trace_id` shows the whole journey:

```
client    checkout_started
processor payment  ch_123
ledger    payment  je_5001
payout    paid     po_777
```

## API

- `init(config) -> FinIntegrityBrowser` — create the client (also the module singleton; `getClient()` returns it).
- `fi.startCheckout({ reference?, traceId?, data? }) -> string` — begin a trace, emit `checkout_started`, return the trace id.
- `fi.trace() -> string` — the current trace id (creates one if needed).
- `fi.breadcrumb(name, data?, { traceId?, reference? })` — record a breadcrumb.
- `fi.flush()` — send queued breadcrumbs now (also runs on an interval and on page-hide).
- `fi.inspect()` — captured breadcrumbs, for tests.

**Config**: `publicKey`, `endpoint`, `flushMs` (default 3000), `debug`, `onError`, `transport` (test override).

## Security

Publishable keys are meant to be public — they can only write client breadcrumbs, never read data or ingest processor/ledger events. Never put a secret key (`fi_sk_…`) in the browser. Send transaction ids and outcomes, never card numbers.

## License

MIT © fin-integrity
