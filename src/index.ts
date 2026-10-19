import { buildJar } from "./app.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const { app, sweep } = buildJar(cfg);

app.listen(cfg.port, cfg.mock ? "127.0.0.1" : "0.0.0.0", () => {
  console.log(`${cfg.streamer.emoji} tip page ${cfg.publicUrl}/t/${cfg.streamer.id}  ·  🪝 /webhooks/send21`);
  console.log(`🎛️ dashboard ${cfg.publicUrl}/dashboard  ·  📺 overlay URL is on the dashboard (keep it secret)`);
  if (cfg.mock) {
    console.log("🧪 MOCK send21: no send21 calls, pay links open a local simulator.");
    console.log(`🧪 one-click: ${cfg.publicUrl}/dashboard/demo  ·  overlay ${cfg.publicUrl}/overlay/${cfg.overlayKey}`);
  }
  setInterval(sweep, 60_000).unref();
  sweep();
});
