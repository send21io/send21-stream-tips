import { afterEach, describe, expect, it } from "vitest";
import { confirmedFor, deliver, KEY, world } from "./helpers.js";

let w: Awaited<ReturnType<typeof world>>;
afterEach(() => w?.close());

describe("tip page", () => {
  it("renders presets, goal and a strict CSP", async () => {
    w = await world();
    const r = await w.get("/t/pixelfox");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await r.text();
    expect(html).toContain("Tip PixelFox");
    expect(html).toMatch(/€2\.00|€2/);
    expect(html).not.toMatch(/<script>|style="/);
    expect((await w.get("/t/nobody")).status).toBe(404);
    expect((await w.get("/")).headers.get("location")).toBe("/t/pixelfox");
  });
  it("custom amounts, errors keep the form, cross-site posts are refused", async () => {
    w = await world();
    const ok = await w.post("/t/pixelfox/tip", { amount: "custom", customAmount: "7.5", name: "a", message: "" });
    expect(ok.status).toBe(303);
    const id = ok.headers.get("location")!.split("/")[2]!;
    expect(w.store.tip(id)!.amount).toBe(750);
    const bad = await w.post("/t/pixelfox/tip", { amount: "custom", customAmount: "9999", name: "keep_me", message: "" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("keep_me");
    expect((await w.post("/t/pixelfox/tip", { amount: "500" }, { origin: "https://evil.example" })).status).toBe(403);
  });
  it("escapes the viewer's name and message everywhere", async () => {
    w = await world();
    const { page, tip } = await w.tip("500", `"&'x`, "it's \"fine\" & ok");
    const html = await (await w.get(page)).text();
    expect(html).toContain("&#34;&#38;&#39;x");
    expect(html).not.toContain(`"&'x`);
    await deliver(w.url, confirmedFor(tip()));
    const cookie = await w.login();
    const dash = await (await w.get("/dashboard", { headers: { cookie } })).text();
    expect(dash).toContain("it&#39;s &#34;fine&#34; &#38; ok");
  });
  it("status page needs the key; status JSON follows the webhook", async () => {
    w = await world();
    const { page, id, tip } = await w.tip();
    expect((await w.get(`/p/${id}/${"A".repeat(43)}`)).status).toBe(404);
    expect(await (await w.get(`${page}/status`)).json()).toEqual({ status: "open" });
    await deliver(w.url, confirmedFor(tip()));
    expect(await (await w.get(`${page}/status`)).json()).toEqual({ status: "paid" });
  });
});

describe("overlay", () => {
  it("needs the secret key", async () => {
    w = await world();
    expect((await w.get("/overlay/wrong-key")).status).toBe(404);
    expect((await w.get("/overlay/wrong-key/stream")).status).toBe(404);
    expect((await fetch(`${w.url}/overlay/wrong-key/next`, { method: "POST" })).status).toBe(404);
    const r = await w.get(`/overlay/${KEY}?top=1`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('data-top="1"');
  });
  it("next → ack: each alert exactly once, also across a reconnect", async () => {
    w = await world();
    const { tip } = await w.tip("5000", "big_spender", "🎉");
    await deliver(w.url, confirmedFor(tip()));
    const first = (await w.ov("/next")) as { alert: { seq: number; tier: string; name: string } };
    expect(first.alert).toMatchObject({ tier: "big", name: "big_spender" });
    expect(await w.ov("/next")).toEqual({ alert: null }); // reload mid-alert: not doubled
    expect(await w.ov("/ack", { seq: first.alert.seq })).toEqual({ ok: true, state: "shown" });
    expect(await w.ov("/ack", { seq: first.alert.seq })).toEqual({ ok: true, state: "shown" });
    expect(await w.ov("/next")).toEqual({ alert: null });
    expect(await w.ov("/ack", { seq: 999 })).toMatchObject({ error: expect.any(String) });
  });
  it("state has the goal and top tippers; SSE says wake when an alert is queued", async () => {
    w = await world();
    const ac = new AbortController();
    const res = await fetch(`${w.url}/overlay/${KEY}/stream`, { signal: ac.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const until = async (re: RegExp) => {
      while (!re.test(buf)) buf += dec.decode((await reader.read()).value);
    };
    await until(/event: wake/);
    buf = "";
    const { tip } = await w.tip("1000", "neon_owl");
    await deliver(w.url, confirmedFor(tip()));
    await until(/event: wake/);
    expect(buf).toMatch(/event: state\ndata: .*"raised":1000/);
    ac.abort();
    const s = (await (await w.get(`/overlay/${KEY}/state`)).json()) as { goal: { percent: number }; top: unknown[] };
    expect(s.goal.percent).toBe(5);
    expect(s.top).toEqual([{ name: "neon_owl", total: 1000 }]);
  });
});

describe("dashboard", () => {
  it("needs the token; wrong token and cross-site posts fail", async () => {
    w = await world();
    expect(await (await w.get("/dashboard")).text()).toContain("STREAMER_TOKEN");
    expect((await w.post("/dashboard/login", { token: "nope" })).status).toBe(401);
    expect((await w.post("/dashboard/test", { tier: "big" })).status).toBe(403);
    const cookie = await w.login();
    expect(cookie).toMatch(/^s21_dash=\d{13}\./);
    expect((await w.post("/dashboard/test", { tier: "big" }, { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(w.store.alerts()).toHaveLength(0);
    expect((await w.post("/dashboard/test", { tier: "big" }, { cookie })).status).toBe(303);
    expect(w.store.alerts()[0]).toMatchObject({ test: true, tier: "big" });
    const forged = cookie.replace(/\.(.)/, (_m, c: string) => `.${c === "A" ? "B" : "A"}`);
    expect((await w.post("/dashboard/test", {}, { cookie: forged })).status).toBe(403);
  });
  it("moderation, skip, replay, goal from the dashboard", async () => {
    w = await world();
    const cookie = await w.login();
    await w.post("/dashboard/moderation", { on: "1" }, { cookie });
    const { tip } = await w.tip("500", "x", "hold me");
    await deliver(w.url, confirmedFor(tip()));
    const seq = w.store.alerts()[0]!.seq;
    expect(w.store.alerts()[0]!.state).toBe("held");
    expect(await w.ov("/next")).toEqual({ alert: null });
    expect((await w.post(`/dashboard/alerts/${seq}/approve`, {}, { cookie })).status).toBe(303);
    expect(((await w.ov("/next")) as { alert: { seq: number } }).alert.seq).toBe(seq);
    await w.ov("/ack", { seq });
    await w.post(`/dashboard/alerts/${seq}/replay`, {}, { cookie });
    expect(w.store.alerts()[0]!.state).toBe("queued");
    await w.post(`/dashboard/alerts/${seq}/skip`, {}, { cookie });
    expect(w.store.alerts()[0]!.state).toBe("skipped");
    await w.post("/dashboard/goal", { emoji: "📷", label: "new cam", target: "300", reset: "1" }, { cookie });
    expect(w.jar.goalProgress()).toMatchObject({ label: "new cam", target: 30000 });
    expect((await w.post("/dashboard/goal", { emoji: "📷", label: "", target: "x" }, { cookie })).status).toBe(400);
  });
  it("🧪 mock: send test tip runs the whole loop through a signed webhook", async () => {
    w = await world();
    const cookie = await w.login();
    expect((await w.post("/dashboard/mock-tip", {}, { cookie })).status).toBe(303);
    const [t] = w.store.tips();
    expect(t!.status).toBe("paid");
    expect(w.store.alerts()[0]).toMatchObject({ state: "queued", test: false, tipId: t!.id });
    expect(w.logs.join("\n")).toMatch(/draft\.confirmed .*paid → alert #1 queued/);
    const html = await (await w.get("/dashboard", { headers: { cookie } })).text();
    expect(html).toContain(`/overlay/${KEY}`);
  });
  it("live mode has no demo login and no mock routes", async () => {
    w = await world({ SEND21_API_KEY: "s21_test_unused", SEND21_WEBHOOK_SECRET: "x", STREAM_FILE: "test/stream.live.json" });
    expect((await w.get("/dashboard/demo")).status).toBe(404);
    const cookie = await w.login();
    expect((await w.post("/dashboard/mock-tip", {}, { cookie })).status).toBe(404);
  });
});
