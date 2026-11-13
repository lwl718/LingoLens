(() => {
  if (window.__lingolensLoaded) return;
  window.__lingolensLoaded = true;

  const LANGUAGES = [
    ["zh-CN", "简中"], ["zh-TW", "繁中"], ["en", "英语"], ["ja", "日语"],
    ["ko", "韩语"], ["fr", "法语"], ["de", "德语"], ["es", "西语"],
    ["ru", "俄语"], ["pt", "葡语"], ["it", "意语"], ["ar", "阿语"]
  ];

  const host = document.createElement("div");
  host.id = "lingolens-extension-host";
  const shadow = host.attachShadow({ mode: "closed" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("content.css");
  shadow.append(stylesheet);

  const shell = document.createElement("div");
  shell.className = "ll-shell";
  shell.hidden = true;
  shell.innerHTML = `
    <section class="ll-panel" role="dialog" aria-label="LingoLens 翻译">
      <header class="ll-header">
        <div class="ll-brand"><span class="ll-mark">文</span><span>LingoLens</span></div>
        <div class="ll-header-actions">
          <select class="ll-target" aria-label="目标语言"></select>
          <button class="ll-icon-button" data-action="copy" title="复制译文" aria-label="复制译文">⧉</button>
          <button class="ll-icon-button" data-action="pin" title="固定窗口" aria-label="固定窗口">⌖</button>
          <button class="ll-icon-button" data-action="close" title="关闭" aria-label="关闭">×</button>
        </div>
      </header>
      <div class="ll-body">
        <p class="ll-original"></p>
        <div class="ll-divider"></div>
        <div class="ll-status" aria-live="polite"></div>
        <p class="ll-result"></p>
        <button class="ll-retry" data-action="retry" hidden>重试</button>
      </div>
      <footer class="ll-footer"><span class="ll-provider">AI 翻译</span></footer>
    </section>
    <button class="ll-trigger" aria-label="翻译选中文字" title="翻译选中文字">译</button>
  `;
  shadow.append(shell);
  document.documentElement.append(host);

  const panel = shell.querySelector(".ll-panel");
  const header = shell.querySelector(".ll-header");
  const trigger = shell.querySelector(".ll-trigger");
  const targetSelect = shell.querySelector(".ll-target");
  const originalNode = shell.querySelector(".ll-original");
  const resultNode = shell.querySelector(".ll-result");
  const statusNode = shell.querySelector(".ll-status");
  const retryButton = shell.querySelector(".ll-retry");
  const pinButton = shell.querySelector('[data-action="pin"]');

  for (const [value, label] of LANGUAGES) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    targetSelect.append(option);
  }

  let settings = null;
  let currentText = "";
  let currentRect = null;
  let pinned = false;
  let requestSerial = 0;
  let selectionTimer = null;
  let dragState = null;

  loadSettings();

  document.addEventListener("mouseup", (event) => {
    if (event.composedPath().includes(host)) return;
    scheduleSelectionRead(120);
  }, true);

  document.addEventListener("keyup", (event) => {
    if (event.key.startsWith("Arrow") || event.key === "Shift") scheduleSelectionRead(100);
  }, true);

  document.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if (event.composedPath().includes(host) || pinned || shell.hidden) return;
    clearTimeout(selectionTimer);
    hideWidget();
  }, true);

  shell.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "close") hideWidget();
    if (action === "retry") requestTranslation();
    if (action === "copy") copyResult();
    if (action === "pin") {
      pinned = !pinned;
      panel.classList.toggle("is-pinned", pinned);
      pinButton.setAttribute("aria-pressed", String(pinned));
      pinButton.title = pinned ? "取消固定" : "固定窗口";
    }
  });

  header.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button, select")) return;
    const shellRect = shell.getBoundingClientRect();
    dragState = {
      offsetX: event.clientX - shellRect.left,
      offsetY: event.clientY - shellRect.top
    };
    panel.classList.add("is-dragging");
    event.preventDefault();
  });

  document.addEventListener("mousemove", (event) => {
    if (!dragState) return;
    moveWidget(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
  }, true);

  document.addEventListener("mouseup", finishDrag, true);
  window.addEventListener("blur", finishDrag);

  trigger.addEventListener("click", () => showPanelAndTranslate());

  targetSelect.addEventListener("change", async () => {
    if (!settings) return;
    settings.targetLanguage = targetSelect.value;
    await chrome.storage.local.set({ targetLanguage: targetSelect.value });
    requestTranslation();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !settings) return;
    for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
    targetSelect.value = settings.targetLanguage;
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "TRANSLATE_CURRENT_SELECTION") {
      openFromSelection();
    }
    if (message?.type === "OPEN_TRANSLATION") {
      const selected = readSelection();
      currentText = String(message.text || selected.text || "").trim();
      currentRect = selected.rect || centeredRect();
      if (currentText) showPanelAndTranslate();
    }
  });

  async function loadSettings() {
    const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" }).catch(() => null);
    settings = response && !response.error ? response : {
      targetLanguage: "zh-CN",
      autoTranslate: true,
      showOriginal: true,
      maxSelectionLength: 2000
    };
    targetSelect.value = settings.targetLanguage || "zh-CN";
  }

  function scheduleSelectionRead(delay) {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(handleSelection, delay);
  }

  async function handleSelection() {
    if (!settings) await loadSettings();
    const selected = readSelection();
    if (!selected.text || selected.text.length > settings.maxSelectionLength) return;
    if (selected.text === currentText && !shell.hidden) return;
    currentText = selected.text;
    currentRect = selected.rect;
    pinned = false;
    panel.classList.remove("is-pinned");
    pinButton.setAttribute("aria-pressed", "false");
    if (settings.autoTranslate) showPanelAndTranslate();
    else showTrigger();
  }

  function openFromSelection() {
    const selected = readSelection();
    if (!selected.text) return;
    currentText = selected.text;
    currentRect = selected.rect;
    showPanelAndTranslate();
  }

  function showTrigger() {
    shell.hidden = false;
    panel.hidden = true;
    trigger.hidden = false;
    positionWidget(42, 42);
  }

  function showPanelAndTranslate() {
    if (!currentText) return;
    shell.hidden = false;
    trigger.hidden = true;
    panel.hidden = false;
    targetSelect.value = settings?.targetLanguage || "zh-CN";
    originalNode.hidden = settings?.showOriginal === false;
    shell.querySelector(".ll-divider").hidden = settings?.showOriginal === false;
    originalNode.textContent = currentText;
    positionWidget(360, 230);
    requestTranslation();
  }

  async function requestTranslation() {
    if (!currentText) return;
    const serial = ++requestSerial;
    panel.classList.add("is-loading");
    statusNode.textContent = "正在翻译…";
    statusNode.classList.remove("is-error");
    resultNode.textContent = "";
    retryButton.hidden = true;
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE",
      payload: {
        text: currentText,
        targetLanguage: targetSelect.value
      }
    }).catch((error) => ({ ok: false, error: error.message }));
    if (serial !== requestSerial) return;
    panel.classList.remove("is-loading");
    if (!response?.ok) {
      statusNode.textContent = response?.error || "翻译失败，请检查 API 设置";
      statusNode.classList.add("is-error");
      retryButton.hidden = false;
      return;
    }
    statusNode.classList.remove("is-error");
    statusNode.textContent = response.cached ? "已从本地缓存读取" : "";
    resultNode.textContent = response.translation;
  }

  async function copyResult() {
    if (!resultNode.textContent) return;
    try {
      await navigator.clipboard.writeText(resultNode.textContent);
      statusNode.classList.remove("is-error");
      statusNode.textContent = "已复制";
      setTimeout(() => {
        if (statusNode.textContent === "已复制") statusNode.textContent = "";
      }, 1200);
    } catch {
      statusNode.textContent = "复制失败";
      statusNode.classList.add("is-error");
    }
  }

  function readSelection() {
    const active = document.activeElement;
    if (active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && /^(text|search|url|email|tel)$/i.test(active.type)))) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (Number.isInteger(start) && end > start) {
        return { text: active.value.slice(start, end).trim(), rect: active.getBoundingClientRect() };
      }
    }

    const selection = window.getSelection();
    const text = String(selection || "").trim();
    if (!text || !selection.rangeCount) return { text: "", rect: null };
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    return { text, rect: rect.width || rect.height ? rect : centeredRect() };
  }

  function centeredRect() {
    return {
      left: window.innerWidth / 2,
      right: window.innerWidth / 2,
      top: window.innerHeight / 2,
      bottom: window.innerHeight / 2,
      width: 0,
      height: 0
    };
  }

  function positionWidget(width, height) {
    const rect = currentRect || centeredRect();
    const margin = 12;
    let left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
    let top = rect.bottom + 10;
    if (top + height > window.innerHeight - margin) top = rect.top - height - 10;
    top = Math.min(Math.max(margin, top), window.innerHeight - height - margin);
    shell.style.left = `${Math.round(left)}px`;
    shell.style.top = `${Math.round(top)}px`;
  }

  function moveWidget(left, top) {
    const widget = panel.hidden ? trigger : panel;
    const rect = widget.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    shell.style.left = `${Math.round(Math.min(Math.max(margin, left), maxLeft))}px`;
    shell.style.top = `${Math.round(Math.min(Math.max(margin, top), maxTop))}px`;
  }

  function finishDrag() {
    if (!dragState) return;
    dragState = null;
    panel.classList.remove("is-dragging");
  }

  function hideWidget() {
    shell.hidden = true;
    pinned = false;
    dragState = null;
    requestSerial += 1;
    panel.classList.remove("is-pinned", "is-loading");
  }
})();
