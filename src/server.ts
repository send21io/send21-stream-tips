import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import QRCode from "qrcode";
import { fiatDecimals } from "./currencies.js";
import { ID, keyOk, publicAlert, type Change, type Jar } from "./jar.js";
import { dashboardPage, errorPage, loginPage, mockPayPage, overlayPage, statusPage, tipPage } from "./pages.js";
import { friendlyError, type createMockClient } from "./send21.js";
import { Store } from "./store.js";
import { signV2, verifySignatureV2 } from "./verify.js";

export interface AppDeps {
  jar: Jar;
  secret: string;
  streamerToken: string;
  overlayKey: string;
  publicUrl: string;
  log?: (line: string) => void;
  mockSend21?: { client: ReturnType<typeof createMockClient>; selfUrl: string };
  trustProxy?: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, HERE.includes(`${sep}dist${sep}`) ? "../../public" : "../public");
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SESSION_MS = 12 * 3600_000;
const COOKIE = "s21_dash";

const qrSvg = async (text: string) =>
  `data:image/svg+xml;base64,${Buffer.from(await QRCode.toString(text, { type: "svg", margin: 1, width: 220, color: { dark: "#121317", light: "#ffffff" } })).toString("base64")}`;
const noStore = (res: Response) => res.set("Cache-Control", "no-store");

/** `burst` requests per `everyMs` per IP, refilled smoothly. */
export function rateLimit(burst: number, everyMs: number, mock: boolean) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (req: Request, res: Response, next: () => void) => {
    const key = req.ip ?? "?";
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) * burst) / everyMs);
    b.at = now;
    if (b.tokens < 1) {
      res.set("Retry-After", String(Math.ceil(everyMs / 1000))).status(429).type("html").send(errorPage("🐢 slow down, try again in a minute", mock));
      return;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 10_000) buckets.clear();
    next();
  };
}

export function createApp(deps: AppDeps): Express {
  const { jar, secret, publicUrl, log = console.log, mockSend21, trustProxy = false } = deps;
  const mock = !!mockSend21;
  const { store } = jar;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  app.use((_req, res, next) => {
    res.set({ "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    next();
  });
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, send21: mock ? "mock" : "live" });
  });
  const sweep = () => store.transaction((d) => jar.sweep(d));

  // ---------- overlay push (SSE) ----------
  const clients = new Set<Response>();
  const push = (event: string, data: unknown) => {
    for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const overlayState = () => ({ goal: jar.goalProgress(), top: jar.topTippers() });
  jar.onChange = (c: Change) => {
    if (c.kind === "skip") push("skip", { seq: c.seq });
    else if (c.kind === "goal") push("state", overlayState());
    else push("wake", {});
  };

  // ---------- send21 webhook ----------
  app.post("/webhooks/send21", express.raw({ type: () => true, limit: "64kb" }), (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const deliveryId = req.get("x-send21-delivery");
    if (!verifySignatureV2(raw, req.get("x-send21-signature-v2"), deliveryId, secret)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    let body: { event?: unknown; data?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch {
      res.status(400).json({ error: "invalid json" });
      return;
    }
    const eventKey = createHash("sha256").update(raw).digest("hex");
    let applied: ReturnType<Jar["applyEvent"]> | null;
    try {
      applied = store.transaction((d) => (Store.remember(d, deliveryId as string, eventKey) ? jar.applyEvent(d, body) : null));
    } catch (err) {
      log(`webhook: store write failed, send21 will retry: ${(err as Error).message}`);
      res.status(500).json({ error: "try again" });
      return;
    }
    if (applied === null) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    log(`webhook ${String(body.event)} ${deliveryId}: ${applied.outcome}${applied.alert ? ` → alert #${applied.alert.seq} ${applied.alert.state}` : ""}`);
    if (applied.alert) {
      push("state", overlayState());
      if (applied.alert.state === "queued") push("wake", {});
    }
    res.status(200).json({ ok: true, outcome: applied.outcome });
  });

  const form = express.urlencoded({ extended: false, limit: "2kb" });
  const sameSite = (req: Request) => {
    const site = req.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return false;
    // Treat a missing Origin, or the opaque "null" string, as OK: Sec-Fetch-Site already
    // blocks cross-site. Some browsers (and Playwright) send Origin: null on same-origin POSTs.
    const origin = req.get("origin");
    if (!origin || origin === "null") return true;
    return origin === new URL(publicUrl).origin || origin === `${req.protocol}://${req.get("host")}`;
  };

  // ---------- viewers ----------
  app.get("/", (_req, res) => {
    res.redirect(302, `/t/${jar.streamer.id}`);
  });
  app.get("/t/:streamer", (req, res) => {
    if (String(req.params.streamer) !== jar.streamer.id) {
      res.status(404).type("html").send(errorPage("🤷 unknown streamer", mock));
      return;
    }
    noStore(res).type("html").send(tipPage(jar, mock));
  });
  app.post("/t/:streamer/tip", rateLimit(10, 60_000, mock), form, async (req, res) => {
    if (String(req.params.streamer) !== jar.streamer.id) {
      res.status(404).type("html").send(errorPage("🤷 unknown streamer", mock));
      return;
    }
    if (!sameSite(req)) {
      res.status(403).type("html").send(errorPage("🙅 cross-site request", mock));
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const amount = b.amount === "custom" || b.amount === undefined ? Math.round(Number(b.customAmount) * 10 ** fiatDecimals(jar.streamer.currency)) : Number(b.amount);
    const prev = { name: typeof b.name === "string" ? b.name.slice(0, 40) : "", message: typeof b.message === "string" ? b.message.slice(0, 300) : "" };
    try {
      const r = await jar.create({ amount, name: b.name, message: b.message });
      if (!r.ok) {
        res.status(r.status ?? 400).type("html").send(tipPage(jar, mock, r.error, prev));
        return;
      }
      log(`tip ${r.tip.id}: pay link for ${r.tip.amount} ${r.tip.currency}`);
      res.redirect(303, `/p/${r.tip.id}/${r.key}`);
    } catch (err) {
      log(`pay link failed: ${(err as Error).message}`);
      res.status(502).type("html").send(tipPage(jar, mock, friendlyError(err), prev));
    }
  });
  const tipOf = (req: Request, res: Response) => {
    const id = String(req.params.id);
    const t = ID.test(id) ? store.tip(id) : undefined;
    if (!t || !keyOk(String(req.params.key), t.keyHash)) {
      noStore(res).status(404).type("html").send(errorPage("🤷 unknown tip", mock));
      return null;
    }
    return t;
  };
  app.get("/p/:id/:key", async (req, res) => {
    sweep();
    const t = tipOf(req, res);
    if (!t) return;
    const qr = t.payUrl && ["open", "seen"].includes(t.status) ? await qrSvg(t.payUrl) : null;
    noStore(res).type("html").send(statusPage(jar, t, { qr, mock }));
  });
  app.get("/p/:id/:key/status", (req, res) => {
    sweep();
    const t = tipOf(req, res);
    if (t) noStore(res).json({ status: t.status });
  });

  // ---------- OBS overlay ----------
  const overlayOk = (req: Request, res: Response) => {
    const a = Buffer.from(createHash("sha256").update(String(req.params.key)).digest());
    const b = Buffer.from(createHash("sha256").update(deps.overlayKey).digest());
    if (!timingSafeEqual(a, b)) {
      res.status(404).type("text").send("not found");
      return false;
    }
    noStore(res);
    return true;
  };
  app.get("/overlay/:key", (req, res) => {
    if (!overlayOk(req, res)) return;
    res.type("html").send(overlayPage(jar, { goal: req.query.goal !== "0", top: req.query.top === "1", sound: req.query.sound !== "0" }));
  });
  app.get("/overlay/:key/state", (req, res) => {
    if (overlayOk(req, res)) res.json(overlayState());
  });
  app.post("/overlay/:key/next", (req, res) => {
    if (!overlayOk(req, res)) return;
    const a = jar.next();
    res.json({ alert: a ? publicAlert(a) : null });
  });
  app.post("/overlay/:key/ack", express.json({ limit: "1kb" }), (req, res) => {
    if (!overlayOk(req, res)) return;
    const r = jar.ack((req.body as { seq?: unknown })?.seq);
    if (!r.ok) {
      res.status(r.status ?? 400).json({ error: r.error });
      return;
    }
    res.json({ ok: true, state: r.alert.state });
  });
  app.get("/overlay/:key/stream", (req, res) => {
    if (!overlayOk(req, res)) return;
    if (clients.size >= 20) {
      res.status(429).end();
      return;
    }
    res.set({ "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(overlayState())}\n\nevent: wake\ndata: {}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  // ---------- streamer dashboard ----------
  const key = createHmac("sha256", deps.streamerToken).update("dashboard-session").digest();
  const sign = (exp: string) => createHmac("sha256", key).update(exp).digest("base64url");
  const authed = (req: Request) => {
    const raw = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.get("cookie") ?? "")?.[1] ?? "";
    const [exp, sig] = raw.split(".");
    if (!exp || !sig || !/^\d{13}$/.test(exp) || Number(exp) < Date.now()) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(sign(exp));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const login = (res: Response) => {
    const exp = String(Date.now() + SESSION_MS);
    res.cookie(COOKIE, `${exp}.${sign(exp)}`, { httpOnly: true, sameSite: "strict", secure: publicUrl.startsWith("https://"), path: "/dashboard", maxAge: SESSION_MS });
  };
  const tokenEq = (got: unknown) => timingSafeEqual(createHmac("sha256", key).update(String(got ?? "")).digest(), createHmac("sha256", key).update(deps.streamerToken).digest());
  const guard = (req: Request, res: Response) => {
    if (!authed(req) || !sameSite(req)) {
      res.status(403).type("html").send(loginPage(mock, "🔐 log in again"));
      return false;
    }
    return true;
  };
  const back = (res: Response) => res.redirect(303, "/dashboard");

  app.get("/dashboard", (req, res) => {
    if (authed(req)) sweep();
    noStore(res)
      .type("html")
      .send(authed(req) ? dashboardPage(jar, { mock, overlayUrl: `${publicUrl}/overlay/${deps.overlayKey}` }) : loginPage(mock));
  });
  app.post("/dashboard/login", rateLimit(5, 60_000, mock), form, (req, res) => {
    if (!sameSite(req) || !tokenEq((req.body as { token?: unknown })?.token)) {
      res.status(401).type("html").send(loginPage(mock, "🙅 wrong token"));
      return;
    }
    login(res);
    back(res);
  });
  if (mock) {
    app.get("/dashboard/demo", (_req, res) => {
      login(res);
      back(res);
    });
  }
  app.get("/dashboard/logout", (_req, res) => {
    res.clearCookie(COOKIE, { path: "/dashboard" });
    back(res);
  });
  app.post("/dashboard/moderation", form, (req, res) => {
    if (!guard(req, res)) return;
    jar.setModeration((req.body as { on?: string })?.on === "1");
    back(res);
  });
  app.post("/dashboard/test", form, (req, res) => {
    if (!guard(req, res)) return;
    jar.testAlert((req.body as { tier?: string })?.tier);
    back(res);
  });
  app.post("/dashboard/goal", form, (req, res) => {
    if (!guard(req, res)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = jar.setGoal({ label: b.label, emoji: b.emoji, target: b.target, reset: b.reset === "1" });
    if (!r.ok) {
      res.status(r.status ?? 400).type("html").send(errorPage(r.error, mock));
      return;
    }
    back(res);
  });
  app.post("/dashboard/alerts/:seq/:action", form, (req, res) => {
    if (!guard(req, res)) return;
    const r = jar.moderate(String(req.params.seq), String(req.params.action));
    if (!r.ok) {
      res.status(r.status ?? 400).type("html").send(errorPage(r.error, mock));
      return;
    }
    back(res);
  });
  if (mockSend21) {
    // 🧪 A real round trip in mock mode: tip → mock pay link → signed webhook → alert.
    app.post("/dashboard/mock-tip", form, async (req, res) => {
      if (!guard(req, res)) return;
      const names = ["neon_owl", "lagless", "gg_mango", "pixelpal", "turbo_kiwi"];
      const s = jar.streamer;
      const amount = s.presets[Math.floor(Math.random() * s.presets.length)]!;
      const r = await jar.create({ amount, name: names[Math.floor(Math.random() * names.length)], message: "🧪 test tip from the mock wallet" });
      if (r.ok) await mockDeliver(secret, mockSend21, r.tip.payUrl!.split("/").pop()!, "paid");
      back(res);
    });
    mountMockPay(app, secret, mockSend21);
  }
  app.use(express.static(PUBLIC_DIR, { index: false }));
  return app;
}

// ---------- mock send21 ----------

function mountMockPay(app: Express, secret: string, mock: NonNullable<AppDeps["mockSend21"]>): void {
  const { client } = mock;
  app.get("/mock/pay/:token", (req, res) => {
    const entry = client.requests.get(String(req.params.token));
    if (!entry) {
      res.status(404).type("html").send(errorPage("🤷 unknown pay link", true));
      return;
    }
    res.type("html").send(mockPayPage(entry.body, String(req.params.token)));
  });
  app.post("/mock/pay/:token/:action", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    const entry = client.requests.get(String(req.params.token));
    if (!entry) {
      res.status(404).type("html").send(errorPage("🤷 unknown pay link", true));
      return;
    }
    const { r, body } = await mockDeliver(secret, mock, String(req.params.token), String(req.params.action), Number((req.body as { coin?: string })?.coin ?? 0));
    res.type("html").send(mockPayPage(entry.body, String(req.params.token)).replace('<p class="small">↩️', `<p class="pill">${r.ok ? "📨 sent" : "❌"} ${body.event}</p><p class="small">↩️`));
  });
}

/** Send a correctly signed delivery for a mock pay link to our own webhook. */
async function mockDeliver(secret: string, mock: NonNullable<AppDeps["mockSend21"]>, token: string, action: string, coin = 0) {
  const entry = mock.client.requests.get(token)!;
  const body = mockEvent(entry, coin, action);
  const raw = JSON.stringify(body);
  const deliveryId = randomUUID();
  const r = await fetch(`${mock.selfUrl}/webhooks/send21`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-send21-event": body.event, "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(raw, deliveryId, Math.floor(Date.now() / 1000), secret) },
    body: raw,
  });
  return { r, body };
}

type MockEntry = NonNullable<ReturnType<ReturnType<typeof createMockClient>["requests"]["get"]>>;

export function mockEvent(entry: MockEntry, coin: number, action: string) {
  const option = entry.body.options[coin] ?? entry.body.options[0]!;
  const units = option.currency === "Btc" ? 1e8 : option.currency === "Sol" || option.currency === "Eth" ? 1e9 : 1e6;
  const price = option.currency === "Btc" ? 60000 : option.currency === "Eth" ? 3000 : option.currency === "Sol" ? 150 : 1;
  const amountSats = Math.max(1, Math.round((entry.body.fiatAmount / price) * units));
  const base = {
    draftId: randomUUID(),
    paymentRequestId: entry.response.id,
    orderId: entry.body.orderId,
    sentCurrency: option.currency.toUpperCase(),
    network: option.network,
    fiatCurrency: entry.body.fiatCurrency,
    fiatAmount: entry.body.fiatAmount,
    amountSats,
    sentAmount: (amountSats / units).toFixed(Math.log10(units)),
    occurredAt: new Date().toISOString(),
  };
  const confirmed = { event: "draft.confirmed", data: { ...base, status: "Confirmed", txId: `mock-${randomUUID()}`, confirmations: 1 } };
  switch (action) {
    case "paid":
      return confirmed;
    case "wrong":
      return { ...confirmed, data: { ...confirmed.data, sentCurrency: "ETH", network: "Arbitrum" } };
    case "seen":
      return { event: "draft.seen", data: { ...base, status: "Seen", txId: `mock-${randomUUID()}`, confirmations: 0 } };
    case "short":
      return { event: "draft.amount_mismatch", data: { ...base, status: "AwaitingPayment", reviewState: "pending", receivedAmountSats: Math.round(amountSats * 0.95) } };
    case "reject":
      return { event: "draft.mismatch_rejected", data: { ...base, status: "AwaitingPayment", reviewState: "rejected", receivedAmountSats: Math.round(amountSats * 0.95) } };
    default:
      return { event: "payment_request.expired", data: { paymentRequestId: entry.response.id, orderId: entry.body.orderId, opened: true, quoteRequested: false } };
  }
}
