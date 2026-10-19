// OBS browser source. Asks the server for the next alert, plays it, then acks
// it. The server leases an alert to one overlay and marks it shown only on the
// ack, so every alert plays exactly once to the end, even across reloads and
// reconnects (an unacked one comes back after its lease). Push over SSE, with
// polling as the fallback.
(() => {
  const stage = document.querySelector(".stage");
  const base = location.pathname.replace(/\/$/, "");
  const fmt = new Intl.NumberFormat("en", { style: "currency", currency: stage.dataset.currency });
  const money = (m) => fmt.format(m / 10 ** Number(stage.dataset.dec ?? 2));
  const slot = document.getElementById("slot");
  const confetti = document.getElementById("confetti");
  const SHOW = { small: 6000, medium: 8000, big: 11000 };
  const ICON = { small: "🔔", medium: "🔥", big: "🎉" };
  let playing = null;
  let skipNow = null;
  let audio = null;

  // ---------- sound (synth, no files) ----------
  const tone = (f, t, d, type = "triangle", g = 0.08) => {
    const o = audio.createOscillator();
    const v = audio.createGain();
    o.type = type;
    o.frequency.value = f;
    v.gain.setValueAtTime(g, audio.currentTime + t);
    v.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t + d);
    o.connect(v).connect(audio.destination);
    o.start(audio.currentTime + t);
    o.stop(audio.currentTime + t + d);
  };
  const sound = (tier) => {
    if (stage.dataset.sound !== "1") return;
    try {
      audio ??= new AudioContext();
      const notes = tier === "big" ? [523, 659, 784, 1047, 1319] : tier === "medium" ? [587, 880, 1175] : [880, 1320];
      notes.forEach((f, i) => tone(f, i * 0.11, 0.5));
      if (tier === "big") [0, 0.06, 0.12].forEach((t) => tone(2093, 0.6 + t, 0.25, "sine", 0.04));
    } catch {
      /* no audio */
    }
  };

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const burst = () => {
    const colors = ["#f7931a", "#ffb35c", "#3ddc84", "#7aa7ff", "#ff6bd5", "#ffe14d"];
    for (let i = 0; i < 140; i++) {
      const p = el("i", "bit");
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = `${Math.random() * 0.8}s`;
      p.style.animationDuration = `${2.6 + Math.random() * 2.2}s`;
      p.style.setProperty("--x", `${(Math.random() - 0.5) * 260}px`);
      p.style.setProperty("--r", `${Math.random() * 900}deg`);
      confetti.append(p);
    }
    setTimeout(() => confetti.replaceChildren(), 6000);
  };

  async function play(a) {
    playing = a.seq;
    const box = el("div", `alert tier-${a.tier}`);
    box.append(el("p", "a-icon", ICON[a.tier]), el("p", "a-who", a.name), el("p", "a-amt", money(a.amount)));
    if (a.message) box.append(el("p", "a-msg", a.message));
    if (a.test) box.append(el("p", "a-test", "🧪 test"));
    slot.replaceChildren(box);
    sound(a.tier);
    if (a.tier === "big") burst();
    await new Promise((done) => {
      const t = setTimeout(done, SHOW[a.tier]);
      skipNow = () => {
        clearTimeout(t);
        done();
      };
    });
    box.classList.add("out");
    await new Promise((r) => setTimeout(r, 450));
    slot.replaceChildren();
    skipNow = null;
    playing = null;
    try {
      await fetch(`${base}/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seq: a.seq }) });
    } catch {
      /* the lease runs out and it comes back; better twice than never */
    }
  }

  let busy = false;
  async function pull() {
    if (busy || playing) return;
    busy = true;
    try {
      const r = await fetch(`${base}/next`, { method: "POST" });
      const { alert } = await r.json();
      if (alert) {
        await play(alert);
        busy = false;
        return void setTimeout(pull, 600);
      }
    } catch {
      /* offline: the poll tries again */
    }
    busy = false;
  }

  // ---------- goal + top tippers ----------
  const goalBox = document.getElementById("goal");
  const topBox = document.getElementById("top");
  function state(s) {
    if (stage.dataset.goal === "1" && s.goal) {
      goalBox.hidden = false;
      document.getElementById("goalLabel").textContent = `${s.goal.emoji} ${s.goal.label}`;
      document.getElementById("goalPct").textContent = `${s.goal.percent}%`;
      document.getElementById("goalFill").style.width = `${s.goal.percent}%`;
      document.getElementById("goalSub").textContent = `${money(s.goal.raised)} / ${money(s.goal.target)}`;
    }
    if (stage.dataset.top === "1") {
      topBox.hidden = !s.top.length;
      const medals = ["🥇", "🥈", "🥉"];
      document.getElementById("topList").replaceChildren(...s.top.map((t, i) => {
        const li = el("li");
        li.append(el("span", "", `${medals[i] ?? "🏅"} ${t.name}`), el("b", "", money(t.total)));
        return li;
      }));
    }
  }
  const refresh = async () => {
    try {
      state(await (await fetch(`${base}/state`)).json());
    } catch {
      /* next round */
    }
  };

  if ("EventSource" in window) {
    const es = new EventSource(`${base}/stream`);
    es.addEventListener("wake", () => pull());
    es.addEventListener("state", (e) => state(JSON.parse(e.data)));
    es.addEventListener("skip", (e) => {
      if (JSON.parse(e.data).seq === playing && skipNow) skipNow();
    });
  }
  refresh();
  pull();
  setInterval(pull, 4000);
  setInterval(refresh, 15000);
})();
