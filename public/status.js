// Tip status: reload when the payment moves on.
(() => {
  const card = document.querySelector("[data-status]");
  if (!card || !["open", "seen", "review", "accepted"].includes(card.dataset.status)) return;
  setInterval(async () => {
    try {
      const r = await fetch(`${location.pathname}/status`, { cache: "no-store" });
      if (r.ok && (await r.json()).status !== card.dataset.status) location.reload();
    } catch {
      /* try again */
    }
  }, 3000);
})();
