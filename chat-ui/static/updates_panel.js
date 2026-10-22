document.addEventListener('DOMContentLoaded', function () {
  const section = document.getElementById("updates-section");
  const info = document.getElementById("updates-info");
  const btn = document.getElementById("updates-refresh-btn");
  const msg = document.getElementById("updates-msg");
  if (!section) return;

  async function loadStatus() {
    try {
      const r = await fetch("/api/updates/status");
      const d = await r.json();
      const when = d.last_success_utc ? d.last_success_utc + " UTC" : "brak danych";
      info.textContent = "Wpisów: " + (d.entries ?? "?") + " • ostatnia aktualizacja: " + when;
    } catch (e) {
      info.textContent = "Nie można pobrać statusu baz.";
    }
  }

  let lastKey = "init";
  setInterval(() => {
    const user = window.currentUser;
    if (user === undefined) return;
    const key = user ? user.email + ":" + !!user.is_admin : "";
    if (key === lastKey) return;
    lastKey = key;
    if (user) {
      section.style.display = "block";
      btn.style.display = user.is_admin ? "block" : "none";
      loadStatus();
    } else {
      section.style.display = "none";
    }
  }, 500);

  btn.addEventListener("click", async () => {
    const token = window.getSessionToken ? window.getSessionToken() : null;
    if (!token) { msg.textContent = "Brak sesji."; return; }
    btn.disabled = true;
    msg.textContent = "Aktualizuję…";
    try {
      const r = await fetch("/api/updates/refresh", {
        method: "POST",
        headers: { "X-Session-Token": token },
      });
      const d = await r.json();
      if (r.ok) {
        msg.textContent = "Gotowe: " + d.new_entries_added + " nowych wpisów (łącznie " + d.total_entries + ").";
      } else {
        msg.textContent = d.detail || ("Błąd " + r.status);
      }
    } catch (e) {
      msg.textContent = "Błąd połączenia.";
    } finally {
      btn.disabled = false;
      loadStatus();
    }
  });
});
