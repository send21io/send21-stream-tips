// Viewer text: names and messages. Length-limited, no links, no markup, a
// small profanity mask. Pages and the overlay still HTML-escape (or use
// textContent) on output: this filter is not the XSS defence.

// C0/C1 controls, zero-width characters and bidi overrides (used for spoofing).
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u200e-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const URL_LIKE = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\s*(?:\.|\(dot\)|\[dot\])\s*(?:com|io|gg|tv|xyz|net|org|app|link|me|ly|co|ru|to|be)\b|discord\s*\.\s*gg)/i;
/** A short starter list. Add your own words with BLOCKED_WORDS=word1,word2. */
export const DEFAULT_BLOCKED = ["fuck", "shit", "bitch", "cunt", "asshole", "dick", "bastard", "slut", "whore", "wanker"];
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

export type TextCheck = { ok: true; text: string; masked: boolean } | { ok: false; error: string };

export function makeFilter(extra: string[] = []) {
  const words = [...new Set([...DEFAULT_BLOCKED, ...extra.map((w) => w.trim().toLowerCase()).filter((w) => /^[a-z]{3,20}$/.test(w))])];
  // a letter may repeat and be separated by . _ - * or spaces: "f.u.c.k", "fuuuck", "sh1t"
  // Whole words only (plus common endings), so "Scunthorpe" and "dickens" stay untouched.
  const alt = (c: string) => [c, ...Object.keys(LEET).filter((k) => LEET[k] === c)].map((k) => (/[a-z0-9]/.test(k) ? k : `\\${k}`)).join("");
  const body = words.map((w) => [...w].map((c) => `[${alt(c)}]+`).join("[\\s._*-]*")).join("|");
  const pattern = new RegExp(`(?<![a-z0-9])(?:${body})(?:s|es|ed|er|ers|ing|in|y)?(?![a-z0-9])`, "gi");
  return function check(raw: unknown, max: number, what: "name" | "message"): TextCheck {
    if (raw !== undefined && typeof raw !== "string") return { ok: false, error: `🙃 ${what}: text only` };
    const s = (raw ?? "").normalize("NFC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
    if ([...s].length > max) return { ok: false, error: `✂️ ${what}: max ${max} characters` };
    if (URL_LIKE.test(s)) return { ok: false, error: `🔗 no links in the ${what}` };
    if (/[<>]/.test(s)) return { ok: false, error: `🙃 ${what}: no < or >` };
    let masked = false;
    const text = s.replace(pattern, (m) => {
      masked = true;
      return "♥".repeat(Math.min(m.length, 6));
    });
    return { ok: true, text, masked };
  };
}
