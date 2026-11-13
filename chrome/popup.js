const LANGUAGES = [
  ["auto", "自动识别"], ["zh-CN", "简体中文"], ["zh-TW", "繁体中文"],
  ["en", "英语"], ["ja", "日语"], ["ko", "韩语"], ["fr", "法语"],
  ["de", "德语"], ["es", "西班牙语"], ["ru", "俄语"], ["pt", "葡萄牙语"],
  ["it", "意大利语"], ["ar", "阿拉伯语"]
];

const PROVIDERS = {
  openai: { endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  deepseek: { endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-chat" },
  openrouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "openai/gpt-4o-mini" },
  ollama: { endpoint: "http://localhost:11434/v1/chat/completions", model: "qwen2.5:7b" }
};

const elements = Object.fromEntries([
  "connectionState", "sourceLanguage", "targetLanguage", "sourceText", "characterCount",
  "characterLimit", "translateButton", "resultPanel", "resultStatus", "resultText",
  "copyButton", "translateMessage", "settingsForm", "provider", "model", "endpoint",
  "apiKey", "toggleApiKey", "autoTranslate", "showOriginal", "maxSelectionLength",
  "settingsMessage", "testButton"
].map((id) => [id, document.getElementById(id)]));

let settings = null;

init();

async function init() {
  populateLanguages();
  bindEvents();
  settings = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (settings?.error) {
    setMessage(elements.translateMessage, settings.error, "error");
    return;
  }
  applySettings(settings);
}

function populateLanguages() {
  for (const [value, label] of LANGUAGES) {
    const sourceOption = new Option(label, value);
    elements.sourceLanguage.add(sourceOption);
    if (value !== "auto") elements.targetLanguage.add(new Option(label, value));
  }
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
  elements.sourceText.addEventListener("input", updateCharacterCount);
  elements.sourceText.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") translate();
  });
  elements.translateButton.addEventListener("click", translate);
  elements.copyButton.addEventListener("click", copyTranslation);
  elements.settingsForm.addEventListener("submit", saveSettingsFromForm);
  elements.testButton.addEventListener("click", testConnection);
  elements.provider.addEventListener("change", applyProviderPreset);
  elements.toggleApiKey.addEventListener("click", toggleApiKeyVisibility);
  elements.targetLanguage.addEventListener("change", () => chrome.storage.local.set({ targetLanguage: elements.targetLanguage.value }));
  elements.sourceLanguage.addEventListener("change", () => chrome.storage.local.set({ sourceLanguage: elements.sourceLanguage.value }));
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("is-active"));
  document.getElementById(`${name}View`).classList.add("is-active");
}

function applySettings(value) {
  settings = value;
  elements.sourceLanguage.value = value.sourceLanguage || "auto";
  elements.targetLanguage.value = value.targetLanguage || "zh-CN";
  elements.provider.value = value.provider || "custom";
  elements.model.value = value.model || "";
  elements.endpoint.value = value.endpoint || "";
  elements.apiKey.value = value.apiKey || "";
  elements.autoTranslate.checked = value.autoTranslate !== false;
  elements.showOriginal.checked = value.showOriginal !== false;
  elements.maxSelectionLength.value = value.maxSelectionLength || 2000;
  elements.characterLimit.textContent = value.maxSelectionLength || 2000;
  updateConnectionState();
  updateCharacterCount();
}

function collectSettings() {
  return {
    provider: elements.provider.value,
    endpoint: elements.endpoint.value.trim(),
    model: elements.model.value.trim(),
    apiKey: elements.apiKey.value.trim(),
    sourceLanguage: elements.sourceLanguage.value,
    targetLanguage: elements.targetLanguage.value,
    autoTranslate: elements.autoTranslate.checked,
    showOriginal: elements.showOriginal.checked,
    maxSelectionLength: Number(elements.maxSelectionLength.value),
    temperature: settings?.temperature ?? 0.2
  };
}

async function saveSettingsFromForm(event) {
  event.preventDefault();
  setMessage(elements.settingsMessage, "正在保存…");
  const response = await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: collectSettings() });
  if (!response?.ok) {
    setMessage(elements.settingsMessage, response?.error || "保存失败", "error");
    return false;
  }
  applySettings(response.settings);
  setMessage(elements.settingsMessage, "已保存", "success");
  return true;
}

async function translate() {
  if (elements.translateButton.disabled) return;
  const text = elements.sourceText.value.trim();
  if (!text) {
    setMessage(elements.translateMessage, "请输入需要翻译的内容", "error");
    elements.sourceText.focus();
    return;
  }
  setTranslating(true);
  setMessage(elements.translateMessage, "");
  elements.resultPanel.hidden = true;
  const response = await chrome.runtime.sendMessage({
    type: "TRANSLATE",
    payload: {
      text,
      sourceLanguage: elements.sourceLanguage.value,
      targetLanguage: elements.targetLanguage.value
    }
  }).catch((error) => ({ ok: false, error: error.message }));
  setTranslating(false);
  if (!response?.ok) {
    setMessage(elements.translateMessage, response?.error || "翻译失败", "error");
    return;
  }
  elements.resultText.textContent = response.translation;
  elements.resultStatus.textContent = response.cached ? "译文 · 缓存" : "译文";
  elements.resultPanel.hidden = false;
}

async function testConnection() {
  setMessage(elements.settingsMessage, "正在测试…");
  const saved = await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: collectSettings() });
  if (!saved?.ok) {
    setMessage(elements.settingsMessage, saved?.error || "设置无效", "error");
    return;
  }
  settings = saved.settings;
  const response = await chrome.runtime.sendMessage({
    type: "TRANSLATE",
    payload: { text: "Hello", sourceLanguage: "en", targetLanguage: "zh-CN", bypassCache: true }
  }).catch((error) => ({ ok: false, error: error.message }));
  if (!response?.ok) {
    setMessage(elements.settingsMessage, response?.error || "连接失败", "error");
    elements.connectionState.className = "connection-state is-error";
    elements.connectionState.lastChild.textContent = "连接失败";
    return;
  }
  applySettings(saved.settings);
  setMessage(elements.settingsMessage, `连接正常：${response.translation}`, "success");
}

function applyProviderPreset() {
  const preset = PROVIDERS[elements.provider.value];
  if (!preset) return;
  elements.endpoint.value = preset.endpoint;
  elements.model.value = preset.model;
}

function toggleApiKeyVisibility() {
  const visible = elements.apiKey.type === "text";
  elements.apiKey.type = visible ? "password" : "text";
  elements.toggleApiKey.textContent = visible ? "显示" : "隐藏";
}

async function copyTranslation() {
  if (!elements.resultText.textContent) return;
  await navigator.clipboard.writeText(elements.resultText.textContent);
  elements.resultStatus.textContent = "已复制";
  setTimeout(() => { elements.resultStatus.textContent = "译文"; }, 1200);
}

function setTranslating(active) {
  elements.translateButton.disabled = active;
  elements.translateButton.querySelector(".button-label").textContent = active ? "翻译中" : "翻译";
  elements.translateButton.querySelector(".button-spinner").hidden = !active;
}

function updateCharacterCount() {
  const count = elements.sourceText.value.length;
  const limit = Number(elements.characterLimit.textContent) || 2000;
  elements.characterCount.textContent = count;
  elements.characterCount.style.color = count > limit ? "#b2472f" : "";
}

function updateConnectionState() {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(settings.endpoint || "");
  const ready = Boolean(settings.endpoint && settings.model && (settings.apiKey || local));
  elements.connectionState.className = `connection-state${ready ? " is-ready" : ""}`;
  elements.connectionState.lastChild.textContent = ready ? "已配置" : "未配置";
}

function setMessage(element, text, type = "") {
  element.textContent = text;
  element.className = `inline-message${type ? ` is-${type}` : ""}`;
}
