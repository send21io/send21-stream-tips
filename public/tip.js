// Tip page: custom amount, which alert you get, characters left.
(() => {
  const card = document.querySelector("[data-tip]");
  const form = document.getElementById("tipform");
  if (!card || !form) return;
  const { medium, big, min, max } = Object.fromEntries(["medium", "big", "min", "max"].map((k) => [k, Number(card.dataset[k])]));
  const unit = 10 ** Number(card.dataset.dec ?? 2);
  const fmt = new Intl.NumberFormat("en", { style: "currency", currency: card.dataset.currency });
  const custom = document.getElementById("custom");
  const input = document.getElementById("customAmount");
  const hint = document.getElementById("tierhint");
  const go = document.getElementById("go");
  const amount = () => {
    const v = form.querySelector('input[name="amount"]:checked')?.value;
    return v === "custom" ? Math.round(Number(input.value) * unit) : Number(v);
  };
  const update = () => {
    const isCustom = form.querySelector('input[name="amount"]:checked')?.value === "custom";
    custom.hidden = !isCustom;
    const a = amount();
    const ok = Number.isFinite(a) && a >= min && a <= max;
    hint.textContent = !ok ? `💸 ${fmt.format(min / unit)} – ${fmt.format(max / unit)}` : a >= big ? "🎉 confetti alert!" : a >= medium ? "🔥 big alert" : "🔔 small alert";
    go.textContent = ok ? `💜 Tip ${fmt.format(a / unit)}` : "💜 Tip";
    go.disabled = !ok;
  };
  form.addEventListener("change", update);
  input.addEventListener("input", update);
  const msg = form.querySelector("textarea");
  const left = document.getElementById("left");
  if (msg && left) msg.addEventListener("input", () => (left.textContent = String(Number(msg.maxLength) - [...msg.value].length)));
  update();
})();
