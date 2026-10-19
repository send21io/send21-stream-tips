import { describe, expect, it } from "vitest";
import { makeFilter } from "../src/filter.js";

const check = makeFilter(["creeper"]);

describe("message filter", () => {
  it("masks blocked words, also leet and spaced out", () => {
    for (const bad of ["fuck", "FUCK", "f u c k", "fvck".replace("v", "u"), "sh1t", "a$$hole", "fucking", "sh!tty"]) {
      const r = check(`gg ${bad} yeah`, 140, "message");
      expect(r.ok && r.masked, bad).toBe(true);
      expect(r.ok && r.text).toContain("♥");
    }
    const extra = check("hey creeper", 140, "message");
    expect(extra.ok && extra.text).toBe("hey ♥♥♥♥♥♥");
  });
  it("keeps normal words that only contain a bad word's letters", () => {
    for (const ok of ["Scunthorpe ftw", "class act", "assassin build", "dickens fan"]) {
      const r = check(ok, 140, "message");
      expect(r.ok && r.text, ok).toBe(ok);
    }
  });
  it("rejects links in any disguise and HTML brackets", () => {
    for (const bad of ["go to evil.com", "https://x.y", "www.spam", "discord.gg/abc", "spam (dot) com", "<b>hi</b>", "bit . ly/x"]) {
      expect(check(bad, 140, "message").ok, bad).toBe(false);
    }
  });
  it("limits length after stripping invisible characters", () => {
    expect(check("a".repeat(141), 140, "message").ok).toBe(false);
    const r = check(`hi\u200b\u200b there\u202e`, 140, "message");
    expect(r.ok && r.text).toBe("hi there");
    expect(check(42, 140, "message").ok).toBe(false);
    expect(check(undefined, 140, "message")).toEqual({ ok: true, text: "", masked: false });
  });
});
