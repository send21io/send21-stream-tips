import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { KEY, SOL, TOKEN } from "./helpers.js";

const live = { SEND21_API_KEY: "s21_test_x", SEND21_WEBHOOK_SECRET: "whsec_x", STREAM_FILE: "test/stream.live.json", PAY_OPTIONS: `usdc-sol:${SOL}`, STREAMER_TOKEN: TOKEN, OVERLAY_KEY: KEY };

describe("config", () => {
  it("runs in mock mode with no keys at all", () => {
    const c = loadConfig({ STREAM_FILE: "stream.example.json" });
    expect(c.mock).toBe(true);
    expect(c.overlayKey).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(c.streamerToken.length).toBeGreaterThanOrEqual(24);
    expect(c.overlayKey).not.toBe(c.streamerToken);
  });
  it("wants real secrets in live mode", () => {
    expect(loadConfig(live).mock).toBe(false);
    expect(() => loadConfig({ ...live, STREAM_FILE: "stream.example.json" })).toThrow(/stream.json/);
    expect(() => loadConfig({ ...live, SEND21_WEBHOOK_SECRET: "" })).toThrow(/WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...live, STREAMER_TOKEN: "short" })).toThrow(/STREAMER_TOKEN/);
    expect(() => loadConfig({ ...live, OVERLAY_KEY: "too-short" })).toThrow(/OVERLAY_KEY/);
    expect(() => loadConfig({ ...live, OVERLAY_KEY: "a".repeat(40), STREAMER_TOKEN: "a".repeat(40) })).toThrow(/differ/);
    expect(() => loadConfig({ ...live, PAY_OPTIONS: "usdt-base:0xabc" })).toThrow();
  });
});
