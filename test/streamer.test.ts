import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadStreamer } from "../src/streamer.js";

const example = JSON.parse(readFileSync("stream.example.json", "utf8")) as Record<string, unknown>;
const now = new Date("2026-10-19T10:00:00Z");
const load = (over: Record<string, unknown>) => loadStreamer({ ...example, ...over }, now);

describe("stream.json", () => {
  it("loads the example in minor units", () => {
    const s = loadStreamer(example, now);
    expect(s).toMatchObject({ id: "pixelfox", currency: "EUR", presets: [200, 500, 1000, 2500], min: 100, max: 50000, tiers: { medium: 1000, big: 5000 } });
    expect(s.goal).toMatchObject({ label: "new mic", target: 20000, since: now.toISOString() });
  });
  it("rejects bad values", () => {
    for (const bad of [{ id: "Pixel Fox" }, { currency: "XXX" }, { presets: [] }, { presets: [0.5] }, { presets: [1000] }, { tiers: { medium: 50, big: 10 } }, { min: 0 }, { nameMax: 2 }, { messageMax: 900 }, { goal: { label: "", emoji: "🎤", target: 1 } }]) {
      expect(() => load(bad), JSON.stringify(bad)).toThrow();
    }
  });
});
