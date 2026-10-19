import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { confirmedFor, deliver, world } from "./helpers.js";

let w: Awaited<ReturnType<typeof world>>;
afterEach(() => w?.close());

const ev = (event: string, t: { orderId: string; paymentRequestId: string | null }, extra: Record<string, unknown> = {}) => ({ event, data: { orderId: t.orderId, paymentRequestId: t.paymentRequestId, ...extra } });

describe("webhook", () => {
  it("rejects bad or old signatures and bad JSON", async () => {
    w = await world();
    const { tip } = await w.tip();
    const body = confirmedFor(tip());
    expect((await deliver(w.url, body, { secret: "wrong" })).status).toBe(401);
    expect((await deliver(w.url, body, { t: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    expect((await deliver(w.url, null, { raw: "{nope" })).status).toBe(400);
    expect(tip().status).toBe("open");
    expect(w.store.alerts()).toHaveLength(0);
  });
  it("a confirmed exact payment queues one alert; a retry with the same delivery id is a duplicate", async () => {
    w = await world();
    const { tip } = await w.tip("1000", "neon_owl", "gg");
    const body = confirmedFor(tip());
    const r1 = await deliver(w.url, body, { deliveryId: "d-1" });
    expect(await r1.json()).toMatchObject({ ok: true, outcome: "paid" });
    const r2 = await deliver(w.url, body, { deliveryId: "d-1" });
    expect(await r2.json()).toEqual({ ok: true, duplicate: true });
    // the same body under a new delivery id is also a duplicate (body hash)
    expect(await (await deliver(w.url, body, { deliveryId: "d-2" })).json()).toEqual({ ok: true, duplicate: true });
    // a second confirmation for the same tip: still one alert
    expect(await (await deliver(w.url, confirmedFor(tip(), { txId: "other" }))).json()).toMatchObject({ outcome: "already_paid" });
    expect(w.store.alerts()).toHaveLength(1);
    expect(w.store.alerts()[0]).toMatchObject({ state: "queued", tier: "medium", name: "neon_owl" });
  });
  it("wrong amount, coin, network or orderId → flagged for review, never on stream", async () => {
    w = await world();
    const cases = [{ fiatAmount: 4.99 }, { sentCurrency: "ETH", network: "Arbitrum" }, { status: "Pending" }, { amountSats: 0 }, { fiatCurrency: "USD" }];
    for (const over of cases) {
      const { tip } = await w.tip();
      await deliver(w.url, confirmedFor(tip(), over));
      expect(tip().status, JSON.stringify(over)).toBe("flagged");
      expect(tip().problems?.length).toBeGreaterThan(0);
    }
    expect(w.store.alerts()).toHaveLength(0);
    expect(w.jar.review()).toHaveLength(cases.length);
    const other = await deliver(w.url, confirmedFor({ orderId: "tip-zzzzzzzzzzzz", paymentRequestId: "pr-x", amount: 500, currency: "EUR" }));
    expect(await other.json()).toMatchObject({ outcome: "unknown_tip" });
  });
  it("expired and declined pay links make no alert; a late payment is held for the streamer", async () => {
    w = await world();
    const a = await w.tip();
    await deliver(w.url, ev("payment_request.expired", a.tip()));
    expect(a.tip().status).toBe("expired");
    const b = await w.tip();
    await deliver(w.url, ev("draft.amount_mismatch", b.tip()));
    expect(b.tip().status).toBe("review");
    await deliver(w.url, ev("draft.mismatch_rejected", b.tip()));
    expect(b.tip().status).toBe("declined");
    expect(w.store.alerts()).toHaveLength(0);
    await deliver(w.url, confirmedFor(a.tip()));
    expect(a.tip().paid?.late).toBe(true);
    expect(w.store.alerts()[0]!.state).toBe("held");
  });
  it("seen, then accepted mismatch, then confirmed: paid", async () => {
    w = await world();
    const { tip } = await w.tip();
    await deliver(w.url, ev("draft.seen", tip()));
    expect(tip().status).toBe("seen");
    await deliver(w.url, ev("draft.mismatch_accepted", tip()));
    expect(tip().status).toBe("accepted");
    await deliver(w.url, confirmedFor(tip()));
    expect(tip().status).toBe("paid");
  });
  it("dedupe and alerts survive a restart (file store)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tips-")), "tips.json");
    w = await world({ DATA_FILE: file });
    const { tip } = await w.tip();
    const body = confirmedFor(tip());
    await deliver(w.url, body, { deliveryId: "d-restart" });
    await w.close();
    w = await world({ DATA_FILE: file });
    expect(await (await deliver(w.url, body, { deliveryId: "d-restart" })).json()).toEqual({ ok: true, duplicate: true });
    expect(w.store.alerts()).toHaveLength(1);
  });
  it("a store write failure answers 500 so send21 retries, and nothing is half-applied", async () => {
    w = await world();
    const { tip } = await w.tip();
    const orig = w.store.transaction.bind(w.store);
    w.store.transaction = () => {
      throw new Error("disk full");
    };
    expect((await deliver(w.url, confirmedFor(tip()), { deliveryId: "d-x" })).status).toBe(500);
    w.store.transaction = orig;
    expect(await (await deliver(w.url, confirmedFor(tip()), { deliveryId: "d-x" })).json()).toMatchObject({ outcome: "paid" });
  });
  it("the local sweep expires a pay link nobody paid", async () => {
    w = await world();
    const { tip } = await w.tip();
    w.clock.now = Date.parse(tip().expiresAt!) + 14 * 60_000;
    w.sweep();
    expect(tip().status).toBe("open");
    w.clock.now += 2 * 60_000;
    w.sweep();
    expect(tip().status).toBe("expired");
  });
});
