import { isFiat, parseTotal, toMinor } from "./currencies.js";
import { cleanText, isEmoji } from "./sanitize.js";
import type { Streamer } from "./types.js";

// stream.json: one streamer per deployment.
//   { "id", "name", "emoji", "currency", "presets": [2, 5, 10, 20], "min": 1, "max": 500,
//     "tiers": { "medium": 10, "big": 50 }, "goal": { "label", "emoji", "target" },
//     "nameMax": 24, "messageMax": 140 }

const ID = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export function loadStreamer(raw: unknown, now = new Date()): Streamer {
  const fail = (msg: string): never => {
    throw new Error(`stream.json: ${msg}`);
  };
  const s = (raw ?? {}) as Record<string, unknown>;
  const id = String(s.id ?? "");
  if (!ID.test(id)) fail("id: a-z, 0-9, _ and -, 2–32");
  const name = cleanText(s.name, 32) ?? fail("name: plain text, max 32");
  const emoji = isEmoji(s.emoji) ? s.emoji : fail("emoji must be one emoji");
  const currency = String(s.currency ?? "").toUpperCase();
  if (!isFiat(currency)) fail(`currency "${String(s.currency)}" is not supported`);
  const money = (v: unknown, what: string): number => {
    const r = parseTotal(v, currency, 10_000);
    if (!r.ok) fail(`${what}: ${r.error}`);
    return toMinor((r as { amount: number }).amount, currency);
  };
  const min = money(s.min ?? 1, "min");
  const max = money(s.max ?? 500, "max");
  if (min > max) fail("min is above max");
  if (!Array.isArray(s.presets) || !s.presets.length || s.presets.length > 6) fail("presets: 1–6 amounts");
  const presets = (s.presets as unknown[]).map((p, i) => money(p, `presets[${i}]`));
  if (presets.some((p) => p < min || p > max)) fail("presets must be between min and max");
  const t = (s.tiers ?? {}) as Record<string, unknown>;
  const tiers = { medium: money(t.medium ?? 10, "tiers.medium"), big: money(t.big ?? 50, "tiers.big") };
  if (tiers.medium >= tiers.big) fail("tiers.medium must be below tiers.big");
  const g = (s.goal ?? {}) as Record<string, unknown>;
  const goal = {
    label: cleanText(g.label ?? "goal", 24) ?? fail("goal.label: plain text, max 24"),
    emoji: g.emoji === undefined ? "🎯" : isEmoji(g.emoji) ? g.emoji : fail("goal.emoji must be one emoji"),
    target: money(g.target ?? 100, "goal.target"),
    since: now.toISOString(),
  };
  const nameMax = Number(s.nameMax ?? 24);
  const messageMax = Number(s.messageMax ?? 140);
  if (!Number.isInteger(nameMax) || nameMax < 3 || nameMax > 40) fail("nameMax: 3…40");
  if (!Number.isInteger(messageMax) || messageMax < 0 || messageMax > 300) fail("messageMax: 0…300");
  return { id, name, emoji, currency, presets, min, max, tiers, goal, nameMax, messageMax };
}
