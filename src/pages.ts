import { coinFor, fiatDecimals, formatFiat } from "./currencies.js";
import { type Jar, toMajor } from "./jar.js";
import type { Alert, PayOption, Tip } from "./types.js";

// Server-rendered pages. Every dynamic value goes through esc(). No inline
// script or style (CSP 'self'): scripts are /tip.js, /status.js, /overlay.js, /dashboard.js.

export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const money = (minor: number, currency: string) => formatFiat(toMajor(minor, currency), currency);

export function layout(title: string, body: string, opts: { script?: string; mock?: boolean; cls?: string; foot?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/tips.css">${opts.script ? `<script src="${esc(opts.script)}" defer></script>` : ""}</head>
<body${opts.cls ? ` class="${esc(opts.cls)}"` : ""}>${opts.cls === "overlay" ? body : `<main class="wrap">${body}</main>`}
${opts.foot === false ? "" : `<footer class="foot">${opts.mock ? "🧪 mock mode · no real money · " : ""}🔒 non-custodial · tips with <a href="https://send21.io">send21</a></footer>`}</body></html>`;
}

const chips = (options: PayOption[]) =>
  `<ul class="coins">${[...new Map(options.map((o) => { const c = coinFor(o.currency, o.network, o.method); return [c?.id ?? o.currency, c] as const; })).values()]
    .map((c) => (c ? `<li>${c.emoji} ${esc(c.label)}</li>` : ""))
    .join("")}</ul>`;

export function tipPage(jar: Jar, mock: boolean, error?: string, prev: { name?: string; message?: string } = {}): string {
  const s = jar.streamer;
  const g = jar.goalProgress();
  return layout(
    `tip ${s.name}`,
    `<article class="card tipcard" data-tip data-currency="${esc(s.currency)}" data-dec="${fiatDecimals(s.currency)}" data-min="${s.min}" data-max="${s.max}" data-medium="${s.tiers.medium}" data-big="${s.tiers.big}">
<div class="streamer"><span class="avatar">${esc(s.emoji)}</span><div><p class="kicker">🔴 live</p><h1>Tip ${esc(s.name)}</h1></div></div>
<div class="goal mini"><p>${esc(g.emoji)} ${esc(g.label)} <b>${g.percent}%</b></p><div class="bar"><i class="fill p${Math.round(g.percent / 5) * 5}"></i></div></div>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/t/${esc(s.id)}/tip" class="stack" id="tipform">
<div class="amounts">${s.presets.map((p, i) => `<label class="amt"><input type="radio" name="amount" value="${p}"${i === 1 ? " checked" : ""}><span>${esc(money(p, s.currency))}</span></label>`).join("")}<label class="amt"><input type="radio" name="amount" value="custom"><span>✏️</span></label></div>
<div class="custom" id="custom" hidden><input type="number" name="customAmount" id="customAmount" min="${toMajor(s.min, s.currency)}" max="${toMajor(s.max, s.currency)}" step="0.01" placeholder="${esc(toMajor(s.min, s.currency))}–${esc(toMajor(s.max, s.currency))}" aria-label="custom amount"><span>${esc(s.currency)}</span></div>
<p class="tierhint" id="tierhint">🔔 small alert</p>
<input name="name" maxlength="${s.nameMax}" placeholder="your name on stream" aria-label="display name" autocomplete="nickname" value="${esc(prev.name ?? "")}">
${s.messageMax ? `<textarea name="message" maxlength="${s.messageMax}" rows="3" placeholder="say something nice 💬" aria-label="message">${esc(prev.message ?? "")}</textarea><p class="count"><span id="left">${s.messageMax}</span> left · no links</p>` : ""}
<button class="cta" id="go">💜 Tip</button>
</form>
${chips(jar.cfg.options)}
<p class="small">👛 no account · pay from your own wallet · your alert shows once the payment confirms</p>
</article>`,
    { script: "/tip.js", mock },
  );
}

const TSTATUS: Record<string, [string, string]> = {
  open: ["⏳", "waiting for your payment"],
  seen: ["👀", "payment on its way"],
  review: ["⚠️", "a different amount arrived · the streamer is checking"],
  accepted: ["👍", "accepted · confirming"],
  paid: ["✅", "thanks! your alert is in the queue"],
  declined: ["↩️", "declined · no alert"],
  unresolved: ["🚩", "the streamer is checking this payment"],
  expired: ["⌛", "this pay link expired · no alert"],
  flagged: ["🚩", "this payment did not match · no alert"],
};

export function statusPage(jar: Jar, t: Tip, o: { qr: string | null; mock: boolean }): string {
  const s = jar.streamer;
  const [icon, text] = TSTATUS[t.status] ?? ["•", t.status];
  const open = ["open", "seen"].includes(t.status) && t.payUrl;
  return layout(
    `tip ${s.name}`,
    `<article class="card center" data-status="${esc(t.status)}">
<p class="kicker">${esc(s.emoji)} tip for ${esc(s.name)}</p>
<p class="price">${esc(money(t.amount, t.currency))}</p>
<p class="small">💬 <b>${esc(t.name)}</b>${t.message ? `: ${esc(t.message)}` : ""}</p>
<p class="pill s-${esc(t.status)}" id="status">${icon} ${esc(text)}</p>
${open && o.qr ? `<img class="qr" src="${o.qr}" alt="QR code of the pay link" width="220" height="220">` : ""}
${open ? `<a class="cta" href="${esc(t.payUrl)}" target="_blank" rel="noopener noreferrer">💳 Pay ${esc(money(t.amount, t.currency))}</a>${chips(t.options)}<p class="small">🔖 keep this tab open: it updates by itself</p>` : ""}
${["paid"].includes(t.status) ? `<p class="huge pop">💜</p>` : ""}
${["expired", "declined", "flagged"].includes(t.status) ? `<a class="cta ghost" href="/t/${esc(s.id)}">🔁 tip again</a>` : ""}
</article>`,
    { script: "/status.js", mock: o.mock },
  );
}

/** OBS browser source: transparent, no footer. Alerts, goal bar and top tippers are drawn by /overlay.js. */
export function overlayPage(jar: Jar, opts: { goal: boolean; top: boolean; sound: boolean }): string {
  return layout(
    "overlay",
    `<div class="stage" data-currency="${esc(jar.streamer.currency)}" data-dec="${fiatDecimals(jar.streamer.currency)}" data-goal="${opts.goal ? 1 : 0}" data-top="${opts.top ? 1 : 0}" data-sound="${opts.sound ? 1 : 0}">
<div class="alert-slot" id="slot" aria-live="polite"></div>
<div class="confetti" id="confetti" aria-hidden="true"></div>
<aside class="top-tippers" id="top" hidden><p class="tt-head">🏆 top today</p><ol id="topList"></ol></aside>
<div class="goal big-goal" id="goal" hidden><p><span id="goalLabel"></span> <b id="goalPct"></b></p><div class="bar"><i class="fill" id="goalFill"></i></div><p class="goal-sub" id="goalSub"></p></div>
</div>`,
    { script: "/overlay.js", cls: "overlay", foot: false },
  );
}

const ICON: Record<string, string> = { held: "🛡️", queued: "⏳", shown: "✅", skipped: "⏭️" };
const TICON: Record<string, string> = { open: "⏳", seen: "👀", review: "⚠️", accepted: "👍", paid: "✅", declined: "↩️", unresolved: "🚩", expired: "⌛", flagged: "🚩" };
const TIER: Record<string, string> = { small: "🔔", medium: "🔥", big: "🎉" };

export function dashboardPage(jar: Jar, o: { mock: boolean; overlayUrl: string }): string {
  const s = jar.streamer;
  const cur = s.currency;
  const today = jar.today();
  const g = jar.goalProgress();
  const alerts = jar.store.alerts();
  const queue = alerts.filter((a) => a.state === "held" || a.state === "queued");
  const done = alerts.filter((a) => a.state === "shown" || a.state === "skipped").reverse().slice(0, 12);
  const review = jar.review();
  const mod = jar.moderation();
  const act = (a: Alert, action: string, label: string) => `<form method="post" action="/dashboard/alerts/${a.seq}/${action}"><button class="mini-btn ${action}">${label}</button></form>`;
  const line = (a: Alert, buttons: string) =>
    `<li class="row"><span class="ic">${ICON[a.state]}</span><div><b>${TIER[a.tier]} ${esc(money(a.amount, a.currency))} · ${esc(a.name)}</b>${a.test ? '<span class="tag">test</span>' : ""}${a.message ? `<span class="sub">💬 ${esc(a.message)}</span>` : ""}</div><div class="btns">${buttons}</div></li>`;
  return layout(
    "dashboard",
    `<header class="hero left"><p class="kicker">🎛️ dashboard</p><h1>${esc(s.emoji)} ${esc(s.name)}</h1></header>
<ul class="stats"><li><b>${esc(money(today.total, cur))}</b><span>💜 today · ${today.count} tips</span></li><li><b>${g.percent}%</b><span>${esc(g.emoji)} ${esc(g.label)}</span></li><li><b>${queue.length}</b><span>⏳ in queue</span></li><li class="${review.length ? "warn" : ""}"><b>${review.length}</b><span>🚩 to review</span></li></ul>
<div class="toolbar">
<form method="post" action="/dashboard/moderation"><input type="hidden" name="on" value="${mod ? "0" : "1"}"><button class="toggle ${mod ? "on" : ""}">🛡️ moderation ${mod ? "ON" : "off"}</button></form>
<form method="post" action="/dashboard/test" class="inline"><button class="mini-btn" name="tier" value="small">🔔 test</button><button class="mini-btn" name="tier" value="medium">🔥 test</button><button class="mini-btn" name="tier" value="big">🎉 test</button></form>
${o.mock ? `<form method="post" action="/dashboard/mock-tip"><button class="mini-btn mock">🧪 send test tip</button></form>` : ""}
</div>
<div class="cols"><section>
<h2>⏳ Queue</h2>
<ul class="list">${queue.map((a) => line(a, a.state === "held" ? act(a, "approve", "✅ show") + act(a, "hide", "🙈 no msg") + act(a, "skip", "⏭️") : act(a, "skip", "⏭️ skip"))).join("") || '<li class="row sub">queue is empty</li>'}</ul>
<h2>✅ Shown</h2>
<ul class="list">${done.map((a) => line(a, act(a, "replay", "🔁 replay"))).join("") || '<li class="row sub">nothing yet</li>'}</ul>
</section><section>
${review.length ? `<h2>🚩 Review · never on stream</h2><ul class="list">${review.map((t) => `<li class="row flag"><div><b>${TICON[t.status]} ${esc(money(t.amount, t.currency))} · ${esc(t.name)}</b> <code>${esc(t.orderId)}</code><ul class="problems">${(t.problems ?? []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div><span class="sub">${t.status === "review" ? "decide on send21" : "check by hand"}</span></li>`).join("")}</ul>` : ""}
<h2>🎯 Goal</h2>
<form method="post" action="/dashboard/goal" class="goalform"><input name="emoji" value="${esc(g.emoji)}" aria-label="goal emoji" maxlength="8"><input name="label" value="${esc(g.label)}" aria-label="goal label" maxlength="24"><input name="target" type="number" min="1" step="1" value="${toMajor(g.target, cur)}" aria-label="goal target"><label class="chk"><input type="checkbox" name="reset" value="1"> restart</label><button class="mini-btn">💾</button></form>
<h2>📺 OBS browser source</h2>
<p class="secret"><code id="ovl">${esc(o.overlayUrl)}</code></p>
<p class="small">1920×1080 · add <code>?top=1</code> for top tippers, <code>?goal=0</code> to hide the goal · keep this URL secret</p>
<h2>💜 Today's tips</h2>
<ul class="list">${jar.store.tips().filter((t) => t.createdAt.startsWith(jar.now().toISOString().slice(0, 10))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 15).map((t) => `<li class="row"><span class="ic">${TICON[t.status] ?? "•"}</span><div><b>${esc(money(t.amount, t.currency))}</b><span class="sub"> · ${esc(t.name)} · ${t.status}${t.paid?.late ? " · late" : ""}</span></div><time>${esc(t.createdAt.slice(11, 16))} UTC</time></li>`).join("") || '<li class="row sub">no tips yet</li>'}</ul>
</section></div>
<p class="small"><a href="/dashboard/logout">log out</a></p>`,
    { script: "/dashboard.js", mock: o.mock, cls: "dash" },
  );
}

export function loginPage(mock: boolean, error?: string): string {
  return layout(
    "dashboard",
    `<article class="card center"><p class="huge">🎛️</p><h1>Dashboard</h1>${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/dashboard/login" class="stack"><input type="password" name="token" placeholder="STREAMER_TOKEN" aria-label="token" autocomplete="current-password" required><button class="cta">Open</button></form>
${mock ? `<p class="small"><a href="/dashboard/demo">🧪 one-click demo login</a></p>` : ""}</article>`,
    { mock },
  );
}

export function mockPayPage(entry: { fiatAmount: number; fiatCurrency: string; memo: string; options: PayOption[] }, token: string): string {
  const t = esc(token);
  const coins = entry.options.map((o, i) => `<option value="${i}">${esc(`${o.currency.toUpperCase()} · ${o.method ?? o.network}`)}</option>`).join("");
  const actions = [
    ["seen", "👀 start paying"],
    ["paid", "✅ pay"],
    ["short", "⚠️ pay 5% short"],
    ["reject", "↩️ streamer declines the short pay"],
    ["wrong", "🚩 pay a wrong coin"],
    ["expire", "⌛ let it expire"],
  ];
  return layout(
    "mock pay · send21",
    `<article class="card center"><p class="pill">🧪 mock send21 · no real money</p><p class="price">${esc(formatFiat(entry.fiatAmount, entry.fiatCurrency))}</p><p class="small">${esc(entry.memo)}</p>
${actions.map(([a, l]) => `<form class="mockrow" method="post" action="/mock/pay/${t}/${a}"><select name="coin" aria-label="coin">${coins}</select><button>${l}</button></form>`).join("")}
<p class="small">↩️ then go back to the tip tab</p></article>`,
    { mock: true },
  );
}

export function errorPage(msg: string, mock: boolean): string {
  return layout("oops", `<article class="card center"><p class="huge">😵</p><p>${esc(msg)}</p><a class="cta ghost" href="/">↩️ back</a></article>`, { mock });
}
