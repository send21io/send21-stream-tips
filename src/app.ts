import type { Config } from "./config.js";
import { Jar } from "./jar.js";
import { createMockClient, createSend21Client } from "./send21.js";
import { createApp } from "./server.js";
import { Store } from "./store.js";

/** Wire everything from a Config. Used by index.ts and the tests. */
export function buildJar(cfg: Config, opts: { log?: (l: string) => void; store?: Store; now?: () => Date } = {}) {
  const log = opts.log ?? console.log;
  const store = opts.store ?? new Store(cfg.dataFile);
  const mockSend21 = cfg.send21ApiKey ? null : createMockClient(cfg.publicUrl);
  const send21 = mockSend21 ?? createSend21Client({ apiBase: cfg.send21ApiBase, apiKey: cfg.send21ApiKey as string });
  const jar = new Jar(cfg.streamer, store, send21, { options: cfg.options, expiryHours: cfg.expiryHours, shortfallPercent: cfg.shortfallPercent, blockedWords: cfg.blockedWords }, opts.now);
  const mockPay = mockSend21 ? { client: mockSend21, selfUrl: `http://127.0.0.1:${cfg.port}` } : null;
  const app = createApp({ jar, secret: cfg.webhookSecret, streamerToken: cfg.streamerToken, overlayKey: cfg.overlayKey, publicUrl: cfg.publicUrl, log, trustProxy: cfg.trustProxy, ...(mockPay ? { mockSend21: mockPay } : {}) });
  const sweep = () => store.transaction((d) => jar.sweep(d));
  return { app, jar, store, mockSend21, mockPay, sweep };
}
