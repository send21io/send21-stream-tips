import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { buildJar } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { signV2 } from "../src/verify.js";

export const SECRET = "whsec_test_only_not_a_real_secret";
export const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const TOKEN = "streamer-token-for-tests-only-0123456789";
export const KEY = "overlay_key_for_tests_only_0123456789abcdef";
export const MONDAY_NOON = Date.parse("2026-10-19T10:00:00Z");

export function testConfig(env: Record<string, string> = {}): Config {
  return {
    ...loadConfig({ STREAM_FILE: "stream.example.json", DATA_FILE: ":memory:", PAY_LIGHTNING: "tips@wallet.example", PAY_OPTIONS: `usdc-sol:${SOL}`, STREAMER_TOKEN: TOKEN, OVERLAY_KEY: KEY, ...env }),
    webhookSecret: SECRET,
  };
}

export async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export async function world(env: Record<string, string> = {}, at = MONDAY_NOON) {
  const logs: string[] = [];
  const clock = { now: at };
  const cfg = testConfig(env);
  const w = buildJar(cfg, { log: (l) => logs.push(l), now: () => new Date(clock.now) });
  const server = await listen(w.app);
  if (w.mockPay) w.mockPay.selfUrl = server.url;
  const get = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { redirect: "manual", ...init });
  const post = (path: string, body: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    fetch(`${server.url}${path}`, { method: "POST", redirect: "manual", body: new URLSearchParams(body), headers });
  const ov = (p: string, body?: unknown) =>
    fetch(`${server.url}/overlay/${KEY}${p}`, body === undefined ? { method: "POST" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  /** A viewer tips → the tip status page path + the tip. */
  const tip = async (amount = "500", name = "neon_owl", message = "gg") => {
    const r = await post("/t/pixelfox/tip", { amount, name, message });
    if (r.status !== 303) throw new Error(`tip: ${r.status} ${await r.text()}`);
    const page = new URL(r.headers.get("location")!, server.url).pathname;
    const id = page.split("/")[2]!;
    return { page, id, tip: () => w.store.tip(id)! };
  };
  const login = async () => {
    const r = await post("/dashboard/login", { token: TOKEN });
    return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  return { ...w, ...server, cfg, logs, clock, get, post, ov, tip, login };
}

export function confirmedFor(t: { orderId: string; paymentRequestId: string | null; amount: number; currency: string }, over: Record<string, unknown> = {}) {
  const major = t.amount / 100;
  return {
    event: "draft.confirmed",
    data: {
      draftId: crypto.randomUUID(),
      status: "Confirmed",
      txId: "5hRk-sig",
      confirmations: 1,
      sentCurrency: "USDC",
      network: "Solana",
      amountSats: Math.round(major * 1e6),
      sentAmount: major.toFixed(6),
      fiatCurrency: t.currency,
      fiatAmount: major,
      paymentRequestId: t.paymentRequestId ?? undefined,
      orderId: t.orderId,
      occurredAt: new Date().toISOString(),
      ...over,
    },
  };
}

export function deliver(url: string, body: unknown, { deliveryId = crypto.randomUUID(), t = Math.floor(Date.now() / 1000), secret = SECRET, raw }: { deliveryId?: string; t?: number; secret?: string; raw?: string } = {}) {
  const payload = raw ?? JSON.stringify(body);
  return fetch(`${url}/webhooks/send21`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(payload, deliveryId, t, secret) },
    body: payload,
  });
}
