import { describe, expect, it } from "vitest";
import { Jar, LEASE_MS } from "../src/jar.js";
import { createMockClient } from "../src/send21.js";
import { loadStreamer } from "../src/streamer.js";
import { Store } from "../src/store.js";
import example from "../stream.example.json" with { type: "json" };
import { confirmedFor, MONDAY_NOON } from "./helpers.js";

function jar() {
  const clock = { now: MONDAY_NOON };
  const now = () => new Date(clock.now);
  const send21 = createMockClient("http://localhost:3000");
  const j = new Jar(loadStreamer(example, now()), new Store(":memory:"), send21, { options: [{ currency: "USDC", network: "Solana", address: "So1" }], expiryHours: 1, shortfallPercent: 0, blockedWords: [] }, now);
  const changes: string[] = [];
  j.onChange = (c) => changes.push(c.kind);
  const paid = async (amount = 500, name = "neon_owl", message = "gg") => {
    const r = await j.create({ amount, name, message });
    if (!r.ok) throw new Error(r.error);
    const out = j.store.transaction((d) => j.applyEvent(d, confirmedFor(j.store.tip(r.tip.id)!)));
    return { ...r, ...out };
  };
  return { j, clock, send21, changes, paid };
}

describe("tips", () => {
  it("one pay link per tip, Idempotency-Key = orderId = tip-<id>", async () => {
    const { j, send21 } = jar();
    const r = await j.create({ amount: 500, name: "neon_owl", message: "hi" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tip.orderId).toBe(`tip-${r.tip.id}`);
    const sent = [...send21.requests.values()];
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ fiatCurrency: "EUR", fiatAmount: 5, orderId: r.tip.orderId, reuseOpenForOrder: true, expiryHours: 1 });
    expect(r.tip.status).toBe("open");
    expect(j.store.alerts()).toHaveLength(0);
  });
  it("checks amount, name and message", async () => {
    const { j } = jar();
    expect((await j.create({ amount: 50, name: "", message: "" })).ok).toBe(false);
    expect((await j.create({ amount: 60000, name: "", message: "" })).ok).toBe(false);
    expect((await j.create({ amount: 250.5, name: "", message: "" })).ok).toBe(false);
    expect((await j.create({ amount: 500, name: "x".repeat(25), message: "" })).ok).toBe(false);
    expect((await j.create({ amount: 500, name: "a", message: "join evil.gg" })).ok).toBe(false);
    const anon = await j.create({ amount: 500, name: "", message: "" });
    expect(anon.ok && anon.tip.name).toBe("anon");
  });
  it("tiers: small < medium (10) <= big (50)", () => {
    const { j } = jar();
    expect([100, 999, 1000, 4999, 5000].map((a) => j.tierOf(a))).toEqual(["small", "small", "medium", "medium", "big"]);
  });
});

describe("alert queue: exactly once", () => {
  it("a paid tip queues one alert; next leases it, ack marks it shown, a second ack is a no-op", async () => {
    const { j, paid } = jar();
    const { alert } = await paid(2500);
    expect(alert).toMatchObject({ state: "queued", tier: "medium", amount: 2500 });
    const a = j.next()!;
    expect(a.seq).toBe(alert!.seq);
    expect(j.next()).toBeNull(); // leased: another overlay does not get it too
    expect(j.ack(a.seq).ok).toBe(true);
    expect(j.ack(a.seq).ok).toBe(true);
    expect(j.store.alerts()[0]!.state).toBe("shown");
    expect(j.next()).toBeNull();
  });
  it("an overlay that reloads before acking gets the alert again after the lease", async () => {
    const { j, clock, paid } = jar();
    await paid();
    const a = j.next()!;
    clock.now += LEASE_MS - 1;
    expect(j.next()).toBeNull();
    clock.now += 2;
    expect(j.next()!.seq).toBe(a.seq);
  });
  it("one at a time in order", async () => {
    const { j, paid } = jar();
    await paid(200, "a");
    await paid(5000, "b");
    const first = j.next()!;
    expect(first.name).toBe("a");
    j.ack(first.seq);
    expect(j.next()!.name).toBe("b");
  });
  it("moderation holds alerts until approved; hide drops the message; skip and replay", async () => {
    const { j, paid, changes } = jar();
    j.setModeration(true);
    const { alert } = await paid(500, "x", "hello chat");
    expect(alert!.state).toBe("held");
    expect(j.next()).toBeNull();
    expect(j.moderate(String(alert!.seq), "hide").ok).toBe(true);
    const shown = j.next()!;
    expect(shown.message).toBe("");
    j.ack(shown.seq);
    expect(j.moderate(String(shown.seq), "replay").ok).toBe(true);
    expect(j.next()!.seq).toBe(shown.seq);
    expect(j.moderate(String(shown.seq), "skip").ok).toBe(true);
    expect(j.next()).toBeNull();
    expect(j.moderate("999", "approve").ok).toBe(false);
    expect(j.moderate(String(shown.seq), "explode").ok).toBe(false);
    expect(changes).toContain("skip");
  });
  it("played alerts are dropped after a week", async () => {
    const { j, clock, paid } = jar();
    await paid();
    j.ack(j.next()!.seq);
    clock.now += 6 * 24 * 3600_000;
    j.store.transaction((d) => j.sweep(d));
    expect(j.store.alerts()).toHaveLength(1);
    clock.now += 2 * 24 * 3600_000;
    j.store.transaction((d) => j.sweep(d));
    expect(j.store.alerts()).toHaveLength(0);
  });
  it("test alerts do not count toward the goal, today or top tippers", () => {
    const { j } = jar();
    const a = j.testAlert("big");
    expect(a).toMatchObject({ test: true, tier: "big", state: "queued" });
    expect(j.goalProgress().raised).toBe(0);
    expect(j.today().count).toBe(0);
    expect(j.topTippers()).toEqual([]);
  });
});

describe("goal and top tippers", () => {
  it("goal counts paid tips since the goal started; reset starts over", async () => {
    const { j, clock, paid } = jar();
    await paid(5000);
    await paid(7400);
    expect(j.goalProgress()).toMatchObject({ raised: 12400, target: 20000, percent: 62 });
    clock.now += 1000;
    expect(j.setGoal({ label: "new cam", emoji: "📷", target: "300", reset: true }).ok).toBe(true);
    expect(j.goalProgress()).toMatchObject({ label: "new cam", raised: 0, target: 30000 });
    expect(j.setGoal({ label: "", emoji: "x", target: "1" }).ok).toBe(false);
  });
  it("top tippers are today's paid tips by name, anon left out", async () => {
    const { j, paid } = jar();
    await paid(500, "gg_mango");
    await paid(700, "lagless");
    await paid(400, "gg_mango");
    await paid(5000, "");
    expect(j.topTippers()).toEqual([
      { name: "gg_mango", total: 900 },
      { name: "lagless", total: 700 },
    ]);
  });
});
