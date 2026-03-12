(function initMiniAppSpike() {
  const tg = window.Telegram?.WebApp;
  const userEl = document.getElementById("user");
  const chatTypeEl = document.getElementById("chatType");
  const openPanelBtn = document.getElementById("openPanel");
  const showStatusBtn = document.getElementById("showStatus");
  const showThreadsBtn = document.getElementById("showThreads");

  if (!tg) {
    if (userEl) {
      userEl.textContent = "Telegram WebApp SDK unavailable";
    }
    return;
  }

  tg.ready();
  tg.expand();

  const user = tg.initDataUnsafe?.user;
  const chatType = tg.initDataUnsafe?.chat_type ?? "unknown";
  if (userEl) {
    userEl.textContent = user ? `${user.id} (${user.first_name ?? "user"})` : "unknown";
  }
  if (chatTypeEl) {
    chatTypeEl.textContent = chatType;
  }

  const send = (value) => {
    if (typeof value !== "string" || value.length === 0) {
      return;
    }
    tg.sendData(value);
    tg.close();
  };

  openPanelBtn?.addEventListener("click", () => {
    send("/panel");
  });
  showStatusBtn?.addEventListener("click", () => {
    send("/status");
  });
  showThreadsBtn?.addEventListener("click", () => {
    send("/threads 10");
  });
})();
