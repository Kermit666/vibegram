export function createChatStateStore() {
  const MAX_RECENT_BOT_MESSAGES = 200;
  const deliveryState = new Map();
  const menuStateByChat = new Map();
  const panelMessageByChat = new Map();

  function getChatState(chatId) {
    const key = String(chatId);
    const existing = deliveryState.get(key);
    if (existing) {
      return existing;
    }

    const created = {
      buffer: "",
      isSending: false,
      timer: null,
      recentBotMessageIds: [],
    };
    deliveryState.set(key, created);
    return created;
  }

  function getMenuState(chatId) {
    const key = String(chatId);
    const existing = menuStateByChat.get(key);
    if (existing) {
      return existing;
    }

    const created = {
      threadChoices: [],
      threadById: new Map(),
      threadPage: 0,
      threadBackAction: "panel:main",
      threadFilterRepoPath: null,
      repoChoices: [],
      repoTokenToPath: new Map(),
      repoPage: 0,
      selectedRepoPath: null,
    };
    menuStateByChat.set(key, created);
    return created;
  }

  function getPanelMessageState(chatId) {
    return panelMessageByChat.get(String(chatId)) ?? null;
  }

  function setPanelMessageState(chatId, messageId) {
    if (!chatId || !messageId) {
      return;
    }

    panelMessageByChat.set(String(chatId), {
      messageId,
      updatedAt: Date.now(),
    });
  }

  function clearPanelMessageState(chatId) {
    if (chatId === undefined || chatId === null) {
      return;
    }

    panelMessageByChat.delete(String(chatId));
  }

  function pushRecentBotMessageId(chatId, messageId) {
    if (chatId === undefined || chatId === null || !messageId) {
      return;
    }

    const state = getChatState(chatId);
    state.recentBotMessageIds.push(messageId);
    if (state.recentBotMessageIds.length > MAX_RECENT_BOT_MESSAGES) {
      state.recentBotMessageIds = state.recentBotMessageIds.slice(-MAX_RECENT_BOT_MESSAGES);
    }
  }

  function popRecentBotMessageIds(chatId, limit = 20) {
    if (chatId === undefined || chatId === null) {
      return [];
    }

    const state = getChatState(chatId);
    if (!Array.isArray(state.recentBotMessageIds) || state.recentBotMessageIds.length === 0) {
      return [];
    }

    const safeLimit = Math.max(1, Number.isInteger(limit) ? limit : 20);
    const start = Math.max(0, state.recentBotMessageIds.length - safeLimit);
    const taken = state.recentBotMessageIds.slice(start);
    state.recentBotMessageIds = state.recentBotMessageIds.slice(0, start);
    return taken;
  }

  return {
    getChatState,
    getMenuState,
    getPanelMessageState,
    setPanelMessageState,
    clearPanelMessageState,
    pushRecentBotMessageId,
    popRecentBotMessageIds,
  };
}
