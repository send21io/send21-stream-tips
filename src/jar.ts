import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fiatDecimals } from "./currencies.js";
import { makeFilter } from "./filter.js";
import type { Send21Client } from "./send21.js";
import type { Store, StoreData } from "./store.js";
import type { Alert, Goal, PayOption, Streamer, Tier, Tip, TipStatus } from "./types.js";

// The tip jar, without HTTP: tips, send21 pay links, webhooks, the alert queue.

export interface JarConfig {
  options: PayOption[];
  /** Pay link life on send21 (hours, documented minimum 1). */
  expiryHours: number;
  shortfallPercent: number;
  blockedWords: string[];
}

export const ORDER_ID = /^tip-([a-z0-9]{12})$/;
export const ID = /^[a-z0-9]{12}$/;
/** An overlay holds an alert this long before another poll may get it again (it never acked). */
export const LEASE_MS = 30_000;
const EXPIRY_GRACE_MS = 15 * 60_000;
const ALERT_KEEP_MS = 7 * 24 * 3600_000;

const newId = () => {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(12), (b) => abc[b % 36]).join("");
};
export const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");
export function keyOk(k: string, hash: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(k)) return false;
  const a = Buffer.from(hashKey(k), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
export const toMajor = (minor: number, currency: string) => minor / 10 ** fiatDecimals(currency);

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status?: number };
export type Change = { kind: "wake" } | { kind: "skip"; seq: number } | { kind: "goal" };

export class Jar {
  readonly check: ReturnType<typeof makeFilter>;
  /** Called after a committed change the overlay should hear about (SSE). */
  onChange: (c: Change) => void = () => {};

  constructor(
    readonly streamer: Streamer,
    readonly store: Store,
    private readonly send21: Send21Client,
    readonly cfg: JarConfig,
    readonly now: () => Date = () => new Date(),
  ) {
    this.check = makeFilter(cfg.blockedWords);
    // The goal from stream.json is the starting goal. It is saved on first start
    // so a restart does not reset its progress; change it later on the dashboard.
    if (!store.read((d) => d.settings.goal)) {
      store.transaction((d) => {
        d.settings.goal = { ...streamer.goal, since: this.now().toISOString() };
      });
    }
  }

  tierOf(amount: number): Tier {
    return amount >= this.streamer.tiers.big ? "big" : amount >= this.streamer.tiers.medium ? "medium" : "small";
  }

  goal(): Goal {
    return this.store.read((d) => d.settings.goal) ?? this.streamer.goal;
  }

  moderation(): boolean {
    return this.store.read((d) => d.settings.moderation);
  }

  /** 💜 New tip: amount (minor units), name, message → one pay link. No alert until it is paid. */
  async create(input: { amount: unknown; name: unknown; message: unknown }): Promise<Result<{ tip: Tip; key: string }>> {
    const st = this.streamer;
    const amount = Number(input.amount);
    if (!Number.isSafeInteger(amount) || amount < st.min || amount > st.max) return { ok: false, error: "💸 pick an amount between the min and the max", status: 400 };
    const name = this.check(input.name, st.nameMax, "name");
    if (!name.ok) return { ok: false, error: name.error, status: 400 };
    const message = this.check(input.message, st.messageMax, "message");
    if (!message.ok) return { ok: false, error: message.error, status: 400 };
    const key = randomBytes(32).toString("base64url");
    const id = newId();
    const nowIso = this.now().toISOString();
    const tip: Tip = {
      id,
      orderId: `tip-${id}`,
      amount,
      currency: st.currency,
      name: name.text || "anon",
      message: message.text,
      options: this.cfg.options,
      status: "open",
      paymentRequestId: null,
      payUrl: null,
      expiresAt: null,
      keyHash: hashKey(key),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.store.transaction((d) => {
      d.tips[id] = tip;
    });
    try {
      const pr = await this.send21.createPaymentRequest(
        {
          fiatCurrency: tip.currency,
          fiatAmount: toMajor(amount, tip.currency),
          orderId: tip.orderId,
          memo: `${st.emoji} tip for ${st.name}`.slice(0, 140),
          options: tip.options,
          expiryHours: this.cfg.expiryHours,
          declineNote: "No alert was shown. Send a new tip from the tip page.",
          reuseOpenForOrder: true,
          ...(this.cfg.shortfallPercent > 0 ? { shortfallPolicy: { absorbUpToPercent: this.cfg.shortfallPercent, absorbedBy: "receiver" as const } } : {}),
        },
        tip.orderId,
      );
      const saved = this.store.transaction((d) => {
        d.tips[id] = { ...d.tips[id]!, paymentRequestId: pr.id, payUrl: this.send21.payUrl(pr.payPath), expiresAt: pr.expiresAt ?? null, updatedAt: this.now().toISOString() };
        return d.tips[id]!;
      });
      return { ok: true, tip: saved, key };
    } catch (err) {
      this.store.transaction((d) => {
        delete d.tips[id];
      });
      throw err;
    }
  }

  private addAlert(d: StoreData, a: Omit<Alert, "seq" | "createdAt" | "queuedAt">): Alert {
    const seq = d.nextSeq++;
    const nowIso = this.now().toISOString();
    d.alerts[String(seq)] = { ...a, seq, createdAt: nowIso, queuedAt: nowIso };
    return d.alerts[String(seq)]!;
  }

  /** 🧪 A test alert: no money, not counted anywhere. */
  testAlert(tier: unknown): Alert {
    const t: Tier = tier === "big" || tier === "medium" ? tier : "small";
    const amount = t === "big" ? this.streamer.tiers.big : t === "medium" ? this.streamer.tiers.medium : this.streamer.min;
    const a = this.store.transaction((d) => this.addAlert(d, { tipId: null, test: true, name: "test", message: "🧪 this is a test alert", amount, currency: this.streamer.currency, tier: t, state: "queued" }));
    this.onChange({ kind: "wake" });
    return a;
  }

  // ---------- the overlay ----------

  /** The next alert to play, leased to this overlay for LEASE_MS. Null when none. */
  next(): Alert | null {
    const now = this.now().getTime();
    return this.store.transaction((d) => {
      const a = Object.values(d.alerts)
        .filter((x) => x.state === "queued" && (x.leaseUntil ?? 0) <= now)
        .sort((x, y) => x.queuedAt.localeCompare(y.queuedAt) || x.seq - y.seq)[0];
      if (!a) return null;
      d.alerts[String(a.seq)] = { ...a, leaseUntil: now + LEASE_MS };
      return d.alerts[String(a.seq)]!;
    });
  }

  /** The overlay finished playing `seq`. Idempotent: a second ack changes nothing. */
  ack(seq: unknown): Result<{ alert: Alert }> {
    return this.store.transaction((d) => {
      const a = d.alerts[String(Number(seq))];
      if (!a) return { ok: false, error: "unknown alert", status: 404 };
      if (a.state === "queued") d.alerts[String(a.seq)] = { ...a, state: "shown", shownAt: this.now().toISOString(), leaseUntil: undefined };
      return { ok: true, alert: d.alerts[String(a.seq)]! };
    });
  }

  // ---------- dashboard ----------

  moderate(seq: unknown, action: string): Result<{ alert: Alert }> {
    const r = this.store.transaction((d): Result<{ alert: Alert }> => {
      const a = d.alerts[String(Number(seq))];
      if (!a) return { ok: false, error: "unknown alert", status: 404 };
      const nowIso = this.now().toISOString();
      const set = (patch: Partial<Alert>) => {
        d.alerts[String(a.seq)] = { ...a, ...patch };
        return { ok: true as const, alert: d.alerts[String(a.seq)]! };
      };
      switch (action) {
        case "approve":
          return a.state === "held" ? set({ state: "queued", queuedAt: nowIso }) : { ok: false, error: "not held", status: 409 };
        case "hide": // show the amount, drop the message
          return a.state === "held" ? set({ state: "queued", queuedAt: nowIso, message: "" }) : { ok: false, error: "not held", status: 409 };
        case "skip":
          return ["held", "queued"].includes(a.state) ? set({ state: "skipped", leaseUntil: undefined }) : { ok: false, error: `cannot skip a ${a.state} alert`, status: 409 };
        case "replay":
          return ["shown", "skipped"].includes(a.state) ? set({ state: "queued", queuedAt: nowIso, leaseUntil: undefined }) : { ok: false, error: `cannot replay a ${a.state} alert`, status: 409 };
        default:
          return { ok: false, error: "unknown action", status: 400 };
      }
    });
    if (r.ok) this.onChange(action === "skip" ? { kind: "skip", seq: r.alert.seq } : { kind: "wake" });
    return r;
  }

  setModeration(on: boolean): void {
    this.store.transaction((d) => {
      d.settings.moderation = on;
    });
  }

  setGoal(input: { label: unknown; emoji: unknown; target: unknown; reset?: unknown }): Result<{ goal: Goal }> {
    const label = this.check(input.label, 24, "name");
    if (!label.ok || !label.text) return { ok: false, error: "🎯 goal label: plain text, max 24", status: 400 };
    const emoji = typeof input.emoji === "string" && input.emoji.trim() ? input.emoji.trim() : "🎯";
    if (!/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]{0,8}$/u.test(emoji)) return { ok: false, error: "🎯 one emoji", status: 400 };
    const target = Math.round(Number(input.target) * 10 ** fiatDecimals(this.streamer.currency));
    if (!Number.isSafeInteger(target) || target < 1 || target > 10_000_000) return { ok: false, error: "🎯 target: a positive amount", status: 400 };
    const old = this.goal();
    const goal: Goal = { label: label.text, emoji, target, since: input.reset ? this.now().toISOString() : old.since };
    this.store.transaction((d) => {
      d.settings.goal = goal;
    });
    this.onChange({ kind: "goal" });
    return { ok: true, goal };
  }

  /** 🎯 Paid tips since the goal started. Test alerts never count. */
  goalProgress() {
    const g = this.goal();
    const raised = this.store.tips().filter((t) => t.status === "paid" && t.paid && t.paid.at >= g.since).reduce((n, t) => n + t.amount, 0);
    return { label: g.label, emoji: g.emoji, target: g.target, raised, percent: Math.min(100, Math.floor((raised / g.target) * 100)), currency: this.streamer.currency };
  }

  /** 🏆 Today's top tippers by display name. */
  topTippers(n = 3) {
    const day = this.now().toISOString().slice(0, 10);
    const by = new Map<string, { name: string; total: number }>();
    for (const t of this.store.tips()) {
      if (t.status !== "paid" || !t.paid?.at.startsWith(day) || t.name === "anon") continue;
      const k = t.name.toLowerCase();
      const row = by.get(k) ?? { name: t.name, total: 0 };
      row.total += t.amount;
      by.set(k, row);
    }
    return [...by.values()].sort((a, b) => b.total - a.total).slice(0, n);
  }

  today() {
    const day = this.now().toISOString().slice(0, 10);
    const paid = this.store.tips().filter((t) => t.status === "paid" && t.paid?.at.startsWith(day));
    return { count: paid.length, total: paid.reduce((n, t) => n + t.amount, 0) };
  }

  review(): Tip[] {
    return this.store
      .tips()
      .filter((t) => ["flagged", "unresolved", "review"].includes(t.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** ⌛ local expiry after send21's expiry + grace. */
  sweep(d: StoreData, now = this.now()): number {
    let n = 0;
    for (const t of Object.values(d.tips)) {
      if (["open", "seen"].includes(t.status) && t.expiresAt && Date.parse(t.expiresAt) + EXPIRY_GRACE_MS < now.getTime()) {
        d.tips[t.id] = { ...t, status: "expired", updatedAt: now.toISOString() };
        n++;
      }
    }
    // 🧹 played or skipped alerts are kept a week for replay, then dropped
    for (const [k, a] of Object.entries(d.alerts)) {
      if ((a.state === "shown" || a.state === "skipped") && now.getTime() - Date.parse(a.shownAt ?? a.queuedAt) > ALERT_KEEP_MS) delete d.alerts[k];
    }
    return n;
  }

  // ---------- webhooks ----------

  applyEvent(d: StoreData, body: { event?: unknown; data?: unknown }): { outcome: Outcome; tip?: Tip; alert?: Alert } {
    const event = typeof body.event === "string" ? body.event : "";
    if (event === "test") return { outcome: "test" };
    const data = (body.data && typeof body.data === "object" ? body.data : {}) as DraftEventData;
    const m = typeof data.orderId === "string" ? ORDER_ID.exec(data.orderId) : null;
    if (data.orderId && !m) return { outcome: "unknown_tip" };
    const t = m ? d.tips[m[1]!] : Object.values(d.tips).find((x) => !!data.paymentRequestId && x.paymentRequestId === data.paymentRequestId);
    if (!t || !t.paymentRequestId || (data.paymentRequestId && data.paymentRequestId !== t.paymentRequestId)) return { outcome: "unknown_tip" };
    const nowIso = this.now().toISOString();
    const set = (status: TipStatus, extra: Partial<Tip> = {}) => {
      d.tips[t.id] = { ...t, ...extra, status, updatedAt: nowIso };
      return { outcome: status, tip: d.tips[t.id] };
    };
    const is = (...x: TipStatus[]) => x.includes(t.status);
    const same = { outcome: "unchanged" as const, tip: t };
    switch (event) {
      case "draft.confirmed": {
        if (t.status === "paid") return { outcome: "already_paid", tip: t };
        const problems = checkPaymentAgainstTip(data, t);
        if (problems.length) return set("flagged", { problems });
        const late = is("expired", "declined", "unresolved");
        const r = set("paid", { problems: undefined, paid: { currency: String(data.sentCurrency), network: String(data.network), txId: String(data.txId), late, at: nowIso } });
        // A late payment (after ⌛ or ↩️) is held for the streamer instead of popping up by surprise.
        const alert = this.addAlert(d, { tipId: t.id, test: false, name: t.name, message: t.message, amount: t.amount, currency: t.currency, tier: this.tierOf(t.amount), state: d.settings.moderation || late ? "held" : "queued" });
        return { ...r, alert };
      }
      case "draft.seen":
        return is("open") ? set("seen") : same;
      case "draft.amount_mismatch":
        return is("open", "seen", "expired") ? set("review", { problems: ["a different amount arrived: accept or decline it on send21"] }) : same;
      case "draft.mismatch_accepted":
        return is("paid", "declined") ? same : set("accepted", { problems: undefined });
      case "draft.mismatch_rejected":
        return is("paid") ? same : set("declined", { problems: undefined });
      case "draft.mismatch_unresolved":
        return is("open", "seen", "review", "accepted", "expired") ? set("unresolved", { problems: ["expired undecided: money arrived, nobody decided"] }) : same;
      case "draft.expired":
        if (data.reviewState === "unresolved") return is("open", "seen", "review", "accepted", "expired") ? set("unresolved", { problems: ["expired undecided: money arrived, nobody decided"] }) : same;
        return is("open", "seen") ? set("expired") : same;
      case "payment_request.expired":
        return is("open", "seen") ? set("expired") : same;
      default:
        return { outcome: "ignored", tip: t };
    }
  }
}

export type Outcome = "test" | "ignored" | "unknown_tip" | "unchanged" | "already_paid" | TipStatus;

export interface DraftEventData {
  status?: string;
  txId?: string;
  sentCurrency?: string;
  network?: string;
  amountSats?: number;
  receivedAmountSats?: number;
  fiatCurrency?: string;
  fiatAmount?: number;
  paymentRequestId?: string;
  orderId?: string;
  reviewState?: string;
}

const eq = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const isPosInt = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** A draft.confirmed must be exactly this tip. Empty = OK. */
export function checkPaymentAgainstTip(data: DraftEventData, t: Tip): string[] {
  const problems: string[] = [];
  if (data.orderId !== t.orderId) problems.push(`orderId ${data.orderId} != ${t.orderId}`);
  if (!t.paymentRequestId || data.paymentRequestId !== t.paymentRequestId) problems.push(`pay link ${data.paymentRequestId} != ${t.paymentRequestId}`);
  if (data.status !== "Confirmed") problems.push(`status ${data.status} != Confirmed`);
  if (!data.txId) problems.push("no txId");
  if (!eq(data.fiatCurrency, t.currency)) problems.push(`fiat ${data.fiatCurrency} != ${t.currency}`);
  const scale = 10 ** fiatDecimals(t.currency);
  if (typeof data.fiatAmount !== "number" || Math.round(data.fiatAmount * scale) !== t.amount) problems.push(`amount ${data.fiatAmount} != ${toMajor(t.amount, t.currency)}`);
  if (!isPosInt(data.amountSats)) problems.push("no amountSats");
  if (data.receivedAmountSats !== undefined && !isPosInt(data.receivedAmountSats)) problems.push("bad receivedAmountSats");
  if (!t.options.some((o) => eq(o.currency, data.sentCurrency) && eq(o.network, data.network))) problems.push(`asset ${data.sentCurrency} on ${data.network} was not offered`);
  return problems;
}

/** What the overlay may see. */
export const publicAlert = (a: Alert) => ({ seq: a.seq, name: a.name, message: a.message, amount: a.amount, currency: a.currency, tier: a.tier, test: a.test });
