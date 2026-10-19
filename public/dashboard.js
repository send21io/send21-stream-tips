// Dashboard: refresh every 5 s while nothing is being typed.
(() => {
  setInterval(() => {
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "SELECT")) return;
    location.reload();
  }, 5000);
})();
