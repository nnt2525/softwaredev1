const sidebar = document.querySelector("#chat-sidebar");
const chatScroll = document.querySelector("#chat-scroll");
const welcomeView = document.querySelector("#welcome-view");
const conversation = document.querySelector("#conversation");
const promptInput = document.querySelector("#prompt-input");
const sendButton = document.querySelector(".send-button");
const chatForm = document.querySelector("#chat-form");
const historyList = document.querySelector("#chat-history-list");
const conversationHistory = [];
const historyStorageKey = "mali-chat-history-v1";
const maxSavedChats = 30;
let activeRequest;
let activeResearchRunId;
let activeChatId = null;

renderSavedChats();

function setSidebarOpen(isOpen) {
  sidebar.classList.toggle("is-open", isOpen);
  document.body.classList.toggle("sidebar-is-open", isOpen);
}

document.querySelector(".sidebar-close").addEventListener("click", () => setSidebarOpen(false));
document.querySelector(".sidebar-open").addEventListener("click", () => setSidebarOpen(true));
document.querySelector(".new-chat-button").addEventListener("click", startNewChat);

document.querySelectorAll(".suggestion-card").forEach((card) => {
  card.addEventListener("click", () => {
    promptInput.value = card.dataset.prompt;
    updateComposer();
    promptInput.focus();
  });
});

promptInput.addEventListener("input", updateComposer);
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = promptInput.value.trim();
  if (!message || activeRequest) return;

  welcomeView.hidden = true;
  addMessage(message, "user");
  conversationHistory.push({ role: "user", content: message });
  saveCurrentChat();
  promptInput.value = "";
  updateComposer();
  promptInput.disabled = true;

  const typing = document.createElement("div");
  typing.className = "message assistant-message typing-message";
  typing.innerHTML = '<span class="assistant-avatar" aria-hidden="true"><span></span><span></span><span></span></span><span class="typing-status">กำลังเริ่มค้นคว้า</span><span class="typing-dots"><i></i><i></i><i></i></span>';
  conversation.append(typing);
  scrollToLatest();

  const request = new AbortController();
  activeRequest = request;
  const recentMessages = conversationHistory.slice(-8).map((entry, index, entries) => ({
    role: entry.role,
    content: index === entries.length - 1 ? entry.content : entry.content.slice(0, 600),
  }));

  try {
    const startResponse = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: recentMessages }),
      signal: request.signal,
    });
    const startResult = await startResponse.json();
    if (!startResponse.ok) throw new Error(startResult.error || "เริ่มค้นคว้าไม่สำเร็จ");

    if (startResult.kind !== "research") {
      typing.remove();
      conversationHistory.push({ role: "assistant", content: startResult.reply, citations: startResult.citations || [] });
      saveCurrentChat();
      addMessage(startResult.reply, "assistant", startResult.citations);
      return;
    }

    activeResearchRunId = startResult.runId;
    typing.querySelector(".typing-status").textContent = "กำลังค้นคว้าจากแหล่งข้อมูลบนเว็บ อาจใช้เวลา 5-20 นาที";

    let result;
    while (!request.signal.aborted) {
      await waitForNextPoll(request.signal);
      const pollResponse = await fetch(`/api/chat/${encodeURIComponent(startResult.runId)}`, {
        signal: request.signal,
      });
      result = await pollResponse.json();
      if (!pollResponse.ok) throw new Error(result.error || "ตรวจสถานะงานค้นคว้าไม่สำเร็จ");
      if (result.status === "COMPLETED") break;
      if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(result.status)) {
        throw new Error(result.error || "งานค้นคว้าไม่สำเร็จ กรุณาลองใหม่");
      }
    }

    if (request.signal.aborted) return;
    if (!result?.reply) throw new Error("งานค้นคว้าไม่ส่งรายงานกลับมา กรุณาลองใหม่");

    typing.remove();
    activeResearchRunId = undefined;
    conversationHistory.push({ role: "assistant", content: result.reply, citations: result.citations || [] });
    saveCurrentChat();
    addMessage(result.reply, "assistant", result.citations);
  } catch (error) {
    typing.remove();
    if (error.name !== "AbortError") {
      addMessage(error.message || "เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", "assistant");
    }
  } finally {
    if (activeRequest === request) {
      activeRequest = undefined;
      activeResearchRunId = undefined;
      promptInput.disabled = false;
      updateComposer();
      promptInput.focus();
    }
  }
});

document.querySelector(".search-tool").addEventListener("click", (event) => {
  event.currentTarget.classList.toggle("is-selected");
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    startNewChat();
  }
  if (event.key === "Escape") setSidebarOpen(false);
});

function updateComposer() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
  sendButton.disabled = promptInput.value.trim().length === 0;
}

function addMessage(text, role, citations = []) {
  const message = document.createElement("article");
  message.className = `message ${role === "user" ? "user-message" : "assistant-message"}`;

  if (role === "assistant") {
    const avatar = document.createElement("span");
    avatar.className = "assistant-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.innerHTML = "<span></span><span></span><span></span>";
    message.append(avatar);
  }

  const content = document.createElement("p");
  content.textContent = text;
  message.append(content);

  if (role === "assistant" && Array.isArray(citations) && citations.length > 0) {
    const sources = document.createElement("div");
    sources.className = "message-sources";
    citations.slice(0, 8).forEach((citation, index) => {
      const url = typeof citation === "string" ? citation : citation?.url;
      if (!url) return;
      try {
        const parsedUrl = new URL(url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) return;
        const link = document.createElement("a");
        link.href = parsedUrl.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = typeof citation === "object" && citation.title
          ? citation.title
          : `แหล่งข้อมูล ${index + 1}`;
        sources.append(link);
      } catch {
        return;
      }
    });
    if (sources.childElementCount > 0) message.append(sources);
  }

  conversation.append(message);
  scrollToLatest();
}

function readSavedChats() {
  try {
    const savedChats = JSON.parse(localStorage.getItem(historyStorageKey) || "[]");
    return Array.isArray(savedChats) ? savedChats.filter((chat) => chat && typeof chat.id === "string" && Array.isArray(chat.messages)) : [];
  } catch {
    return [];
  }
}

function writeSavedChats(chats) {
  const savedChats = chats.slice(0, maxSavedChats);
  if (savedChats.length === 0) {
    try {
      localStorage.setItem(historyStorageKey, "[]");
    } catch {
      return;
    }
    return;
  }

  while (savedChats.length > 0) {
    try {
      localStorage.setItem(historyStorageKey, JSON.stringify(savedChats));
      return;
    } catch {
      savedChats.pop();
    }
  }
}

function saveCurrentChat() {
  const firstUserMessage = conversationHistory.find((message) => message.role === "user");
  if (!firstUserMessage) return;

  const chats = readSavedChats().filter((chat) => chat.id !== activeChatId);
  const chat = {
    id: activeChatId || crypto.randomUUID(),
    title: firstUserMessage.content.replace(/\s+/g, " ").trim().slice(0, 48),
    updatedAt: Date.now(),
    messages: conversationHistory.map(({ role, content, citations }) => ({ role, content, citations: citations || [] })),
  };
  activeChatId = chat.id;
  chats.unshift(chat);
  writeSavedChats(chats);
  renderSavedChats();
}

function renderSavedChats() {
  const chats = readSavedChats().sort((first, second) => second.updatedAt - first.updatedAt);
  historyList.replaceChildren();

  if (chats.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "history-empty";
    emptyState.textContent = "ยังไม่มีประวัติ";
    historyList.append(emptyState);
    return;
  }

  chats.forEach((chat) => {
    const row = document.createElement("div");
    row.className = "history-row";

    const openButton = document.createElement("button");
    openButton.className = `recent-chat${chat.id === activeChatId ? " active" : ""}`;
    openButton.type = "button";
    openButton.textContent = chat.title || "แชตใหม่";
    openButton.title = chat.title || "แชตใหม่";
    openButton.addEventListener("click", () => openSavedChat(chat.id));

    const deleteButton = document.createElement("button");
    deleteButton.className = "history-delete";
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", `ลบแชต ${chat.title || "แชตใหม่"}`);
    deleteButton.title = "ลบประวัติแชต";
    deleteButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>';
    deleteButton.addEventListener("click", () => deleteSavedChat(chat.id));

    row.append(openButton, deleteButton);
    historyList.append(row);
  });
}

function openSavedChat(chatId) {
  const chat = readSavedChats().find((savedChat) => savedChat.id === chatId);
  if (!chat) return;

  cancelActiveRequest();
  activeChatId = chat.id;
  conversationHistory.splice(0, conversationHistory.length, ...chat.messages);
  conversation.replaceChildren();
  welcomeView.hidden = conversationHistory.length > 0;
  conversationHistory.forEach(({ role, content, citations }) => addMessage(content, role, citations));
  renderSavedChats();
  setSidebarOpen(false);
}

function deleteSavedChat(chatId) {
  writeSavedChats(readSavedChats().filter((chat) => chat.id !== chatId));
  if (activeChatId === chatId) startNewChat();
  renderSavedChats();
}

function waitForNextPoll(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Request aborted", "AbortError"));
      return;
    }

    const finish = () => {
      signal.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = window.setTimeout(finish, 5000);
    const cancel = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function scrollToLatest() {
  requestAnimationFrame(() => {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  });
}

function startNewChat() {
  cancelActiveRequest();
  activeChatId = null;
  conversationHistory.length = 0;
  conversation.replaceChildren();
  welcomeView.hidden = false;
  promptInput.value = "";
  promptInput.disabled = false;
  updateComposer();
  setSidebarOpen(false);
  promptInput.focus();
  chatScroll.scrollTop = 0;
  renderSavedChats();
}

function cancelActiveRequest() {
  if (activeResearchRunId) {
    fetch(`/api/chat/${encodeURIComponent(activeResearchRunId)}/cancel`, { method: "POST" }).catch(() => {});
  }
  activeRequest?.abort();
  activeRequest = undefined;
  activeResearchRunId = undefined;
}