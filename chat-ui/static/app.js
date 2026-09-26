(function () {
  "use strict";

  // Fallback UUID v4 - generateUUID() wymaga "secure context" (HTTPS lub
  // dosłownie hostname "localhost"), a niestandardowe hosty jak np.
  // "cybersec-agent" wskazujące na 127.0.0.1 przez plik hosts NIE są
  // automatycznie traktowane jako bezpieczny kontekst przez przeglądarki.
  function generateUUID() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.generateUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  const threadIdEl = document.getElementById("thread-id");
  const newSessionBtn = document.getElementById("new-session");
  const toolsListEl = document.getElementById("tools-list");
  const toolsAllBtn = document.getElementById("tools-all");
  const toolsNoneBtn = document.getElementById("tools-none");
  const tabCybersecBtn = document.getElementById("tab-cybersec");
  const tabPentestingBtn = document.getElementById("tab-pentesting");
  const modelsListEl = document.getElementById("models-list");
  const pulseBar = document.getElementById("pulse-bar");
  const pulseIdle = document.getElementById("pulse-idle");
  const pulseTrack = document.getElementById("pulse-track");
  const toolControlsEl = document.createElement("div");
  toolControlsEl.id = "tool-controls";
  toolControlsEl.className = "tool-controls hidden";
  toolControlsEl.innerHTML = `
    <span class="tool-elapsed">00:00</span>
    <button type="button" class="stop-btn">■ Zatrzymaj</button>`;
  pulseBar.insertAdjacentElement("afterend", toolControlsEl);
  const elapsedEl = toolControlsEl.querySelector(".tool-elapsed");
  const stopBtn = toolControlsEl.querySelector(".stop-btn");

  const liveOutputEl = document.createElement("pre");
  liveOutputEl.id = "live-output";
  liveOutputEl.className = "live-output hidden";
  toolControlsEl.insertAdjacentElement("afterend", liveOutputEl);

  let elapsedTimer = null;
  let elapsedStart = null;

  function startElapsedTimer() {
    elapsedStart = Date.now();
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - elapsedStart) / 1000);
      const m = String(Math.floor(secs / 60)).padStart(2, "0");
      const s = String(secs % 60).padStart(2, "0");
      elapsedEl.textContent = `${m}:${s}`;
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  stopBtn.addEventListener("click", async () => {
    if (!threadId) return;
    stopBtn.disabled = true;
    stopBtn.textContent = "Zatrzymywanie…";
    try {
      const res = await fetch(`/api/stop/${threadId}`, { method: "POST" });
      const data = await res.json();
      if (data.status === "stopped") {
        stopBtn.textContent = "Zatrzymano";
      } else if (data.status === "not_running") {
        stopBtn.textContent = "Nic do zatrzymania";
      } else {
        stopBtn.textContent = "Błąd zatrzymania";
      }
    } catch (e) {
      stopBtn.textContent = "Błąd komunikacji";
    }
    setTimeout(() => {
      stopBtn.disabled = false;
      stopBtn.textContent = "■ Zatrzymaj";
    }, 2000);
  });

  const threadEl = document.getElementById("thread");
  const composer = document.getElementById("composer");
  const composerInput = document.getElementById("composer-input");
  const composerSend = document.getElementById("composer-send");
  const exampleSelect = document.getElementById("example-select");

  let threadId = null;
  let selectedTools = new Set();

  // Parametry jawnie wybranych narzędzi.
  // { tool_name: { param_name: value } }
  let toolParams = {};
  let allTools = [];
  let activeCategory = "cybersec";
  let modelConfig = null;
  let pipelineOrder = [];
  let pollTimer = null;
  let pendingResolve = null;
  let isBusy = false;

  function saveThreadId(id) {
    try { sessionStorage.setItem("cybersec_thread_id", id); } catch (e) {}
  }
  const QUICK_COMMANDS = [
    "sprawdź firewall i fail2ban",
    "zrób pełny audyt bezpieczeństwa",
    "przeprowadź skan nmap na localhost",
  ];

  function newSession() {
    threadId = generateUUID();
    saveThreadId(threadId);
    threadIdEl.textContent = threadId.slice(0, 8) + "…";
    threadEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-mark"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg></div>
        <div class="empty-title">Gotowy do audytu</div>
        <div class="empty-sub">Wybierz narzędzia po lewej albo zacznij od jednego z poniższych — cel zostanie wykryty automatycznie z treści wiadomości.</div>
        <div class="quick-chips-row">
          ${QUICK_COMMANDS.map((c) => `<button type="button" class="quick-chip" data-cmd="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("")}
        </div>
      </div>`;
    threadEl.querySelectorAll(".quick-chip").forEach((btn) => {
      btn.addEventListener("click", () => sendMessage(btn.dataset.cmd));
    });
    resetPulse();
  }
  async function resumeSession() {
    let savedId = null;
    try { savedId = sessionStorage.getItem("cybersec_thread_id"); } catch (e) {}
    if (!savedId) { newSession(); return; }
    try {
      const res = await fetch(`/api/status/${savedId}`);
      if (!res.ok) { newSession(); return; }
      const status = await res.json();
      const activeStages = ["security_agent", "report_writers", "critic"];
      if (!status || !activeStages.includes(status.stage)) {
        newSession();
        return;
      }
      // Wznawiamy sesję, która była w trakcie przetwarzania w momencie
      // odświeżenia strony (threadId żyje tylko w JS, ginie przy reload -
      // ale pipeline po stronie orchestratora działa dalej w tle).
      threadId = savedId;
      threadIdEl.textContent = threadId.slice(0, 8) + "…";
      threadEl.innerHTML = "";
      appendUserMessage("(wznowiono po odświeżeniu strony)");
      const bubble = appendAssistantPending();
      liveOutputEl.classList.add("hidden");
      liveOutputEl.textContent = "";
      toolControlsEl.classList.add("hidden");
      stopBtn.disabled = false;
      stopBtn.textContent = "■ Zatrzymaj";
      isBusy = true;
      composerSend.disabled = true;
      startElapsedTimer();
      startPolling();
      try {
        const finalStatus = await new Promise((resolve) => { pendingResolve = resolve; });
        if (finalStatus.stage === "error") {
          appendErrorMessage(bubble, finalStatus.detail || "Błąd podczas przetwarzania");
        } else {
          renderMarkdown(bubble, finalStatus.result || "(brak treści raportu)");
          if (finalStatus.suggested_tools && finalStatus.suggested_tools.length > 0) {
            renderSuggestions(bubble, finalStatus.suggested_tools);
          }
        }
      } catch (e) {
        appendErrorMessage(bubble, `Błąd komunikacji z serwerem: ${e.message}`);
        stopPolling();
      } finally {
        liveOutputEl.classList.add("hidden");
        toolControlsEl.classList.add("hidden");
        stopElapsedTimer();
        isBusy = false;
        composerSend.disabled = false;
        threadEl.scrollTop = threadEl.scrollHeight;
      }
    } catch (e) {
      newSession();
    }
  }

  newSessionBtn.addEventListener("click", newSession);

  const TOOL_LABELS = {
    check_firewall: { label: "Zapora sieciowa (UFW)", icon: "shield" },
    check_fail2ban: { label: "Ochrona przed brute-force (fail2ban)", icon: "alert" },
    check_ssh: { label: "Konfiguracja SSH", icon: "lock" },
    check_updates: { label: "Aktualizacje systemowe", icon: "check" },
    check_local_ports: { label: "Otwarte porty lokalne", icon: "scan" },
    list_services: { label: "Uslugi systemowe", icon: "list" },
    list_users: { label: "Konta uzytkownikow", icon: "list" },
    nmap_scan_ip: { label: "Skaner portow (Nmap)", icon: "scan" },
    nmap_stealth_scan: { label: "Skan ukryty (Nmap)", icon: "scan" },
    nmap_vuln_scan: { label: "Skan podatnosci (Nmap)", icon: "bug" },
    nikto_scan: { label: "Skaner podatnosci WWW (Nikto)", icon: "bug" },
    nuclei_scan: { label: "Skaner podatnosci (Nuclei)", icon: "bug" },
    testssl_scan: { label: "Audyt TLS/SSL", icon: "lock" },
    whatweb_scan: { label: "Rozpoznanie technologii WWW", icon: "search" },
    wafw00f_scan: { label: "Wykrywanie WAF", icon: "shield" },
    enum4linux_scan: { label: "Enumeracja SMB", icon: "search" },
    hydra_ftp: { label: "Test sily hasel (FTP)", icon: "lock" },
    certipy_find: { label: "Audyt AD CS (Certipy)", icon: "search" },
    coercer_coerce: { label: "Wymuszenie uwierzytelnienia (Coercer)", icon: "bug" },
    ntlmrelayx_listen: { label: "Przekaznik NTLM (ntlmrelayx)", icon: "bug" },
  };

  const TOOL_ICONS = {
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
    check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>',
    list: '<line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>',
    scan: '<circle cx="12" cy="12" r="9"></circle><line x1="21" y1="12" x2="18" y2="12"></line><line x1="6" y1="12" x2="3" y2="12"></line><line x1="12" y1="6" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="18"></line>',
    bug: '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>',
    search: '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>',
  };

  function humanizeToolName(name) {
    return name.replace(/_/g, " ").replace(/\w/g, (c) => c.toUpperCase());
  }

  function toolIconSvg(name) {
    const key = (TOOL_LABELS[name] && TOOL_LABELS[name].icon) || "scan";
    const path = TOOL_ICONS[key] || TOOL_ICONS.scan;
    return `<svg class="tool-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  }

  async function loadTools() {
    try {
      const res = await fetch("/api/tools");
      const data = await res.json();
      allTools = data.tools || [];
      renderToolsList();
    } catch (e) {
      toolsListEl.innerHTML = `<div class="tools-loading">błąd ładowania narzędzi</div>`;
    }
  }

  function renderToolParams(toolName, container) {
    const tool = allTools.find((t) => t.name === toolName);

    const schema = tool?.args_schema || {};
    const properties = schema.properties || {};
    const requiredParams = new Set(schema.required || []);

    if (!tool || Object.keys(properties).length === 0) {
      container.innerHTML = "";
      container.classList.add("hidden");
      return;
    }

    // Narzedzia ktore NIE wymagaja recznego wskazania celu (wiekszosc)
    // dostaja krotka informacje zamiast pelnego formularza - cel jest
    // wyciagany automatycznie z tresci wiadomosci (patrz sendMessage +
    // ensureToolParamsForTarget). Zapobiega to myleniu pol miedzy
    // narzedziami (patrz incydent z 2026-09-12).
    if (!tool.requires_manual_target) {
      container.classList.remove("hidden");
      container.innerHTML = `
        <div class="tool-params-auto-hint">
          ✓ Cel zostanie pobrany automatycznie z Twojej wiadomości
          (np. "sprawdź 172.19.0.50 przez ${escapeHtml(toolName)}")
        </div>
      `;
      return;
    }

    container.classList.remove("hidden");

    const fields = Object.entries(properties).map(([name, spec]) => {
      const current =
        toolParams[toolName] &&
        toolParams[toolName][name] !== undefined
          ? toolParams[toolName][name]
          : (spec.default ?? "");

      const required = requiredParams.has(name) ? " *" : "";
      const description = spec.description
        ? `<small class="tool-param-desc">${escapeHtml(spec.description)}</small>`
        : "";

      const inputType =
        spec.type === "number" || spec.type === "integer"
          ? "number"
          : "text";

      return `
        <div class="tool-param">
          <label>
            <span>${escapeHtml(spec.title || name)}${required}</span>
            <input
              type="${inputType}"
              class="tool-param-input"
              data-tool="${escapeHtml(toolName)}"
              data-param="${escapeHtml(name)}"
              value="${escapeHtml(String(current))}"
              placeholder="${escapeHtml(spec.default ?? "")}"
              ${requiredParams.has(name) ? "required" : ""}
            >
          </label>
          ${description}
        </div>
      `;
    }).join("");

    container.innerHTML = `
      <div class="tool-params-title">Parametry narzędzia</div>
      ${fields}
    `;

    container.querySelectorAll(".tool-param-input").forEach((input) => {
      input.addEventListener("input", () => {
        const tool = input.dataset.tool;
        const param = input.dataset.param;

        if (!toolParams[tool]) {
          toolParams[tool] = {};
        }

        toolParams[tool][param] = input.value;
      });
    });
  }

  function ensureToolParamsForTarget(toolName, target) {
    const tool = allTools.find((t) => t.name === toolName);
    if (!tool || !tool.params || !target) return;

    const targetParam =
      Object.keys(tool.params).find((name) =>
        ["target", "ip", "host"].includes(name)
      );

    if (!targetParam) return;

    if (!toolParams[toolName]) {
      toolParams[toolName] = {};
    }

    if (!toolParams[toolName][targetParam]) {
      toolParams[toolName][targetParam] = target;
    }
  }

  function renderToolsList() {
    toolsListEl.innerHTML = "";
    const filtered = allTools.filter((t) => (t.category || "cybersec") === activeCategory);
    if (filtered.length === 0) {
      toolsListEl.innerHTML = `<div class="tools-loading">brak narzędzi w tej kategorii</div>`;
      return;
    }
    filtered.forEach((t) => {
      const row = document.createElement("label");
      row.className = "tool-item";
      const shortDesc = t.description.split("\n")[0].trim();
      const displayName = (TOOL_LABELS[t.name] && TOOL_LABELS[t.name].label) || humanizeToolName(t.name);
      row.innerHTML = `
        <input type="checkbox" data-tool="${t.name}">
        ${toolIconSvg(t.name)}
        <span>
          <span class="tool-name">${escapeHtml(displayName)}</span>
          <span class="tool-desc">${escapeHtml(shortDesc)}</span>
        </span>
        <div class="tool-params hidden"></div>`;

      const cb = row.querySelector("input");
      const paramsEl = row.querySelector(".tool-params");

      cb.checked = selectedTools.has(t.name);

      if (cb.checked) {
        renderToolParams(t.name, paramsEl);
      }

      cb.addEventListener("change", () => {
        if (cb.checked) {
          selectedTools.add(t.name);
          renderToolParams(t.name, paramsEl);
        } else {
          selectedTools.delete(t.name);
          paramsEl.innerHTML = "";
          paramsEl.classList.add("hidden");
        }
      });

      toolsListEl.appendChild(row);
    });
  }

  function switchTab(category) {
    activeCategory = category;
    tabCybersecBtn.classList.toggle("mode-tab-active", category === "cybersec");
    tabPentestingBtn.classList.toggle("mode-tab-active", category === "pentesting");
    renderToolsList();
  }

  tabCybersecBtn.addEventListener("click", () => switchTab("cybersec"));
  tabPentestingBtn.addEventListener("click", () => switchTab("pentesting"));

  toolsAllBtn.addEventListener("click", () => {
    toolsListEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = true;
      selectedTools.add(cb.dataset.tool);

      const row = cb.closest(".tool-item");
      const paramsEl = row ? row.querySelector(".tool-params") : null;

      if (paramsEl) {
        renderToolParams(cb.dataset.tool, paramsEl);
      }
    });
  });

  toolsNoneBtn.addEventListener("click", () => {
    toolsListEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = false;
      selectedTools.delete(cb.dataset.tool);

      const row = cb.closest(".tool-item");
      const paramsEl = row ? row.querySelector(".tool-params") : null;

      if (paramsEl) {
        paramsEl.innerHTML = "";
        paramsEl.classList.add("hidden");
      }
    });
  });

  async function loadModels() {
    try {
      const res = await fetch("/api/models");
      modelConfig = await res.json();

      pipelineOrder = [{ key: "security_agent", label: modelConfig.tool_model }];
      modelConfig.report_models.forEach((m, i) => {
        pipelineOrder.push({ key: `writer:${i}`, label: shortModelName(m) });
      });
      pipelineOrder.push({ key: "critic", label: modelConfig.critic_model });

      renderModelsList();
      buildPulseTrack();
    } catch (e) {
      modelsListEl.innerHTML = `<div class="tools-loading">błąd ładowania modeli</div>`;
    }
  }

  function shortModelName(name) {
    return name.split("/").pop();
  }

  function renderModelsList() {
    modelsListEl.innerHTML = "";
    const roles = [
      { label: "AGENT", model: modelConfig.tool_model },
      ...modelConfig.report_models.map((m) => ({ label: "WRITER", model: m })),
      { label: "CRITIC", model: modelConfig.critic_model },
    ];
    roles.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "model-row";
      row.dataset.pipelineIndex = i;
      row.innerHTML = `<span class="model-dot" data-dot="${i}"></span> ${shortModelName(r.model)} <span class="model-role">${r.label}</span>`;
      modelsListEl.appendChild(row);
    });
  }

  function buildPulseTrack() {
    pulseTrack.innerHTML = "";
    pipelineOrder.forEach((node, i) => {
      const el = document.createElement("div");
      el.className = "pulse-node";
      el.dataset.index = i;
      el.innerHTML = `
        <div class="pulse-node-line"></div>
        <div class="pulse-node-circle">${i + 1}</div>
        <div class="pulse-node-label">${node.label}</div>`;
      pulseTrack.appendChild(el);
    });
  }

  function resetPulse() {
    pulseBar.classList.remove("active");
    pulseTrack.classList.remove("show");
    document.querySelectorAll(".pulse-node").forEach((n) => n.classList.remove("active", "done", "error"));
    document.querySelectorAll(".model-dot").forEach((d) => d.classList.remove("active", "done"));
    const statusText = pulseBar.querySelector(".pulse-status-text");
    if (statusText) statusText.remove();
  }

  function updatePulse(status) {
    const stage = status.stage;
    pulseBar.classList.add("active");
    pulseTrack.classList.add("show");

    let currentIdx = -1;
    if (stage === "security_agent") currentIdx = 0;
    else if (stage === "report_writers") {
      const match = /\((\d+)\/(\d+)\)/.exec(status.detail || "");
      const idx = match ? parseInt(match[1], 10) : 1;
      currentIdx = idx;
    } else if (stage === "critic") currentIdx = pipelineOrder.length - 1;
    else if (stage === "done") currentIdx = pipelineOrder.length;
    else if (stage === "error") currentIdx = -2;

    pipelineOrder.forEach((node, i) => {
      const el = pulseTrack.querySelector(`.pulse-node[data-index="${i}"]`);
      const dot = modelsListEl.querySelector(`.model-dot[data-dot="${i}"]`);
      el.classList.remove("active", "done", "error");
      if (dot) dot.classList.remove("active", "done");

      if (stage === "error") {
        return;
      }
      if (i < currentIdx) {
        el.classList.add("done");
        if (dot) dot.classList.add("done");
      } else if (i === currentIdx) {
        el.classList.add("active");
        if (dot) dot.classList.add("active");
      }
    });

    let statusText = pulseBar.querySelector(".pulse-status-text");
    if (!statusText) {
      statusText = document.createElement("div");
      statusText.className = "pulse-status-text";
      pulseBar.appendChild(statusText);
    }
    let percentSuffix = "";
    if (stage !== "error" && currentIdx >= 0 && pipelineOrder.length > 0) {
      const percent = Math.min(100, Math.round(((currentIdx + 1) / pipelineOrder.length) * 100));
      percentSuffix = ` (${percent}%)`;
    }
    statusText.textContent = (status.detail || stage) + percentSuffix;
  }

  async function pollToolOutput() {
    if (!threadId) return;
    try {
      const res = await fetch(`/api/tool_output/${threadId}`);
      const data = await res.json();
      if (data.lines && data.lines.length > 0) {
        liveOutputEl.classList.remove("hidden");
        toolControlsEl.classList.remove("hidden");
        const header = data.tool ? `$ ${data.tool}\n` : "";
        liveOutputEl.textContent = header + data.lines.join("\n");
        liveOutputEl.scrollTop = liveOutputEl.scrollHeight;
      }
    } catch (e) {}
  }

  async function pollStatus() {
    if (!threadId) return;
    try {
      const res = await fetch(`/api/status/${threadId}`);
      const status = await res.json();
      updatePulse(status);
      pollToolOutput();
      if (status.stage === "done" || status.stage === "error") {
        stopPolling();
        if (pendingResolve) {
          pendingResolve(status);
          pendingResolve = null;
        }
      }
    } catch (e) {}
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollStatus, 1000);
    pollStatus();
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function clearEmptyState() {
    const empty = threadEl.querySelector(".empty-state");
    if (empty) empty.remove();
  }

  function appendUserMessage(text) {
    clearEmptyState();
    const div = document.createElement("div");
    div.className = "msg msg-user";
    div.innerHTML = `<div class="msg-bubble"></div>`;
    div.querySelector(".msg-bubble").textContent = text;
    threadEl.appendChild(div);
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  function appendAssistantPending() {
    const div = document.createElement("div");
    div.className = "msg msg-assistant";
    div.innerHTML = `
      <div class="msg-label">RAPORT</div>
      <div class="msg-bubble pending">Uruchamiam pipeline diagnostyczny…</div>`;
    threadEl.appendChild(div);
    threadEl.scrollTop = threadEl.scrollHeight;
    return div.querySelector(".msg-bubble");
  }

  const FINDING_LABEL = { high: "KRYTYCZNE", medium: "OSTRZEŻENIE", low: "INFO" };

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function renderMarkdown(bubbleEl, text) {
    bubbleEl.classList.remove("pending");

    const findingRe = /::finding\[(\w+)\]\{concern="([^"]*)"\s+title="([^"]*)"\}\n?([\s\S]*?)::/g;
    let out = "";
    let lastIndex = 0;
    let match;

    while ((match = findingRe.exec(text)) !== null) {
      const [full, type, concern, title, body] = match;
      const before = text.slice(lastIndex, match.index);
      out += window.marked ? window.marked.parse(before) : before;

      const cls = FINDING_LABEL[type] ? type : "medium";
      const label = FINDING_LABEL[cls];
      const bodyHtml = body.trim()
        ? (window.marked ? window.marked.parse(body.trim()) : escapeHtml(body.trim()))
        : "";

      out += `
        <div class="finding-card finding-${cls}">
          <div class="finding-head">
            <span class="finding-icon finding-icon-${cls}"></span>
            <span class="finding-label">${label}</span>
            <span class="finding-title">${escapeHtml(title)}</span>
          </div>
          ${bodyHtml ? `<div class="finding-body">${bodyHtml}</div>` : ""}
          <div class="finding-concern">${escapeHtml(concern)}</div>
        </div>`;

      lastIndex = match.index + full.length;
    }

    out += window.marked ? window.marked.parse(text.slice(lastIndex)) : text.slice(lastIndex);
    bubbleEl.innerHTML = out;
  }

  function appendErrorMessage(bubbleEl, text) {
    bubbleEl.closest(".msg").classList.add("msg-error");
    bubbleEl.classList.remove("pending");
    bubbleEl.textContent = text;
  }

  const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
  // Lapie pelny URL (ze schematem, opcjonalnie z portem/sciezka/parametrem)
  // - priorytetowy wybor, jesli administrator wpisal cos wiecej niz goly IP
  // (np. adres z konkretnym parametrem do testu SQL injection).
  const URL_RE = /https?:\/\/[^\s]+/i;
  let lastTargetGuess = null;

  function renderSuggestions(bubble, tools) {
    const msgDiv = bubble.closest(".msg");
    if (!msgDiv) return;
    const box = document.createElement("div");
    box.className = "suggestions-box";
    const itemsHtml = tools.map((t) => `
      <label class="suggestion-item">
        <input type="checkbox" data-tool="${escapeHtml(t.name)}" checked>
        <div>
          <div class="suggestion-name">${escapeHtml(t.name)}</div>
          <div class="suggestion-desc">${escapeHtml(t.description)}</div>
        </div>
      </label>`).join("");
    box.innerHTML = `
      <div class="suggestions-title">⚠ Audyt sugeruje weryfikację pentestem</div>
      ${itemsHtml}
      <button type="button" class="run-suggested-btn">Uruchom pentest z zaznaczonymi</button>`;
    msgDiv.insertAdjacentElement("afterend", box);

    box.querySelector(".run-suggested-btn").addEventListener("click", () => {
      const checked = Array.from(
        box.querySelectorAll('input[type="checkbox"]:checked')
      ).map((el) => el.getAttribute("data-tool"));

      if (checked.length === 0) return;

      selectedTools = new Set(checked);

      // Sugestia pochodzi z raportu, więc wykorzystujemy wcześniej
      // wykryty target. Nie pytamy LLM o ponowne wybranie celu.
      if (lastTargetGuess) {
        checked.forEach((toolName) => {
          ensureToolParamsForTarget(toolName, lastTargetGuess);
        });
      }

      box.remove();

      const target = lastTargetGuess ? ` na ${lastTargetGuess}` : "";
      sendMessage(
        `Przeprowadzam weryfikację pentestową narzędziami: ${checked.join(", ")}${target}`
      );
    });
  }

  async function sendMessage(text) {
    if (isBusy || !text.trim()) return;
    const urlMatch = text.match(URL_RE);
    const ipMatch = text.match(IPV4_RE);
    if (urlMatch) {
      lastTargetGuess = urlMatch[0];
    } else if (ipMatch) {
      lastTargetGuess = ipMatch[0];
    }

    // Automatyczne wypelnienie parametru celu dla WSZYSTKICH zaznaczonych
    // narzedzi na podstawie adresu/URL wykrytego w tresci wiadomosci -
    // administrator wpisuje cel RAZ, w prompcie, zamiast oddzielnie w
    // formularzu kazdego narzedzia (zrodlo bledow z 2026-09-12, np. port
    // przypadkowo trafiajacy do pola cookie innego narzedzia).
    if (lastTargetGuess && selectedTools.size > 0) {
      selectedTools.forEach((toolName) => {
        ensureToolParamsForTarget(toolName, lastTargetGuess);
      });
    }
    isBusy = true;
    composerSend.disabled = true;

    appendUserMessage(text);
    const bubble = appendAssistantPending();
    liveOutputEl.classList.add("hidden");
    liveOutputEl.textContent = "";
    toolControlsEl.classList.add("hidden");
    stopBtn.disabled = false;
    stopBtn.textContent = "■ Zatrzymaj";
    startElapsedTimer();
    // WAŻNE: resetujemy pasek WIZUALNIE od razu, zanim cokolwiek pójdzie
    // do backendu - inaczej przez chwilę widać stary, zakończony ("done")
    // stan poprzedniego zapytania w tej samej sesji.
    resetPulse();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          thread_id: threadId,
          selected_tools: selectedTools.size > 0 ? Array.from(selectedTools) : null,
          tool_params: selectedTools.size > 0 ? toolParams : null,
          admin_password: window.getAdminPasswordForRequest ? window.getAdminPasswordForRequest() : null,
          session_token: window.getSessionToken ? window.getSessionToken() : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        appendErrorMessage(bubble, `Błąd: ${data.detail || "nieznany błąd orchestratora"}`);
      } else {
        threadId = data.thread_id;
        saveThreadId(threadId);
        threadIdEl.textContent = threadId.slice(0, 8) + "…";
        // KLUCZOWA ZMIANA: zaczynamy polling DOPIERO PO otrzymaniu
        // potwierdzenia od backendu (który w /chat synchronicznie ustawia
        // status_store na "starting" PRZED zwróceniem odpowiedzi) - to
        // eliminuje wyścig, w którym pierwsze poll(e) trafiały jeszcze na
        // stary status "done" z poprzedniego zapytania w tej samej sesji.
        startPolling();
        // Pipeline działa teraz w tle po stronie orchestratora - czekamy na
        // wynik przez ten sam mechanizm pollingu /status, zamiast trzymać
        // otwarte jedno długie połączenie HTTP (które przy pipeline'ach
        // trwających kilkanaście-kilkadziesiąt minut było zawodne).
        const status = await new Promise((resolve) => { pendingResolve = resolve; });
        if (status.stage === "error") {
          appendErrorMessage(bubble, status.detail || "Błąd podczas przetwarzania");
        } else {
          renderMarkdown(bubble, status.result || "(brak treści raportu)");
          if (status.suggested_tools && status.suggested_tools.length > 0) {
            renderSuggestions(bubble, status.suggested_tools);
          }
        }
        // Audyt zakończony — pobieramy aktualny lifecycle Findingów.
        loadFindings();
      }
    } catch (e) {
      appendErrorMessage(bubble, `Błąd komunikacji z serwerem: ${e.message}`);
      stopPolling();
    } finally {
      liveOutputEl.classList.add("hidden");
      toolControlsEl.classList.add("hidden");
      stopElapsedTimer();
      isBusy = false;
      composerSend.disabled = false;
      threadEl.scrollTop = threadEl.scrollHeight;
    }
  }

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = composerInput.value;
    composerInput.value = "";
    sendMessage(text);
  });

  exampleSelect.addEventListener("change", () => {
    if (exampleSelect.value) {
      composerInput.value = exampleSelect.value;
      composerInput.focus();
      exampleSelect.selectedIndex = 0;
    }
  });


  // ============================================================
  // FINDINGS
  // ============================================================

  const findingsListEl = document.getElementById("findings-list");
  const findingsSummaryEl = document.getElementById("findings-summary");
  const findingsRefreshBtn = document.getElementById("findings-refresh");
  const findingDetailOverlay = document.getElementById("finding-detail-overlay");
  const findingDetailTitle = document.getElementById("finding-detail-title");
  const findingDetailContent = document.getElementById("finding-detail-content");
  const findingDetailClose = document.getElementById("finding-detail-close");

  let findingsCache = [];

  function findingSeverity(value) {
    const v = String(value || "").toLowerCase();

    if (
      v.includes("critical") ||
      v.includes("kryty")
    ) return "critical";

    if (
      v.includes("high") ||
      v.includes("wysok")
    ) return "high";

    if (
      v.includes("medium") ||
      v.includes("śred") ||
      v.includes("sred")
    ) return "medium";

    return "low";
  }

  function findingSeverityLabel(severity) {
    return {
      critical: "CRITICAL",
      high: "HIGH",
      medium: "MEDIUM",
      low: "LOW"
    }[severity] || String(severity || "UNKNOWN").toUpperCase();
  }

  function findingSeverityIcon(severity) {
    return {
      critical: "🔴",
      high: "🟠",
      medium: "🟡",
      low: "🟢"
    }[severity] || "⚪";
  }

  function findingValue(obj, names, fallback = "") {
    if (!obj || typeof obj !== "object") return fallback;

    for (const name of names) {
      if (
        Object.prototype.hasOwnProperty.call(obj, name) &&
        obj[name] !== null &&
        obj[name] !== undefined &&
        obj[name] !== ""
      ) {
        return obj[name];
      }
    }

    return fallback;
  }

  function findingId(finding) {
    return findingValue(
      finding,
      ["finding_id", "id", "uuid", "key"],
      "—"
    );
  }

  function findingTitle(finding) {
    return findingValue(
      finding,
      ["title", "name", "summary", "finding"],
      "Bez tytułu"
    );
  }

  function findingDescription(finding) {
    return findingValue(
      finding,
      ["description", "detail", "details", "body", "evidence"],
      ""
    );
  }

  function normalizeFindingsPayload(data) {
    if (Array.isArray(data)) return data;

    if (data && Array.isArray(data.findings)) {
      return data.findings;
    }

    if (data && Array.isArray(data.items)) {
      return data.items;
    }

    if (data && Array.isArray(data.results)) {
      return data.results;
    }

    return [];
  }

  function renderFindingsSummary(findings) {
    if (!findingsSummaryEl) return;

    const counts = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0
    };

    findings.forEach((f) => {
      counts[findingSeverity(
        findingValue(f, ["severity", "risk", "priority"], "low")
      )]++;
    });

    findingsSummaryEl.innerHTML = `
      <div class="finding-count finding-count-critical">
        <span class="finding-count-dot"></span><strong>${counts.critical}</strong><small>CRITICAL</small>
      </div>
      <div class="finding-count finding-count-high">
        <span class="finding-count-dot"></span><strong>${counts.high}</strong><small>HIGH</small>
      </div>
      <div class="finding-count finding-count-medium">
        <span class="finding-count-dot"></span><strong>${counts.medium}</strong><small>MEDIUM</small>
      </div>
      <div class="finding-count finding-count-low">
        <span class="finding-count-dot"></span><strong>${counts.low}</strong><small>LOW</small>
      </div>
    `;
  }

  function renderFindingsList(findings) {
    if (!findingsListEl) return;

    if (!findings.length) {
      findingsListEl.innerHTML = `
        <div class="findings-empty">
          brak Findingów
        </div>`;
      return;
    }

    findingsListEl.innerHTML = findings.map((finding, index) => {
      const severity = findingSeverity(
        findingValue(finding, ["severity", "risk", "priority"], "low")
      );

      const id = findingId(finding);
      const title = findingTitle(finding);

      return `
        <button
          type="button"
          class="finding-list-item finding-list-${severity}"
          data-finding-index="${index}">
          <span class="finding-list-icon finding-list-icon-${severity}"></span>
          <span class="finding-list-main">
            <span class="finding-list-id">${escapeHtml(String(id))}</span>
            <span class="finding-list-title">${escapeHtml(String(title))}</span>
          </span>
          <span class="finding-list-severity">${findingSeverityLabel(severity)}</span>
        </button>
      `;
    }).join("");

    findingsListEl.querySelectorAll(".finding-list-item").forEach((el) => {
      el.addEventListener("click", () => {
        const index = Number(el.dataset.findingIndex);
        const finding = findingsCache[index];
        if (finding) openFindingDetail(finding);
      });
    });
  }

  async function loadFindings() {
    if (!findingsListEl) return;

    try {
      findingsListEl.innerHTML =
        `<div class="findings-loading">ładowanie…</div>`;

      const res = await fetch("/api/findings", {
        cache: "no-store"
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      findingsCache = normalizeFindingsPayload(data);

      renderFindingsSummary(findingsCache);
      renderFindingsList(findingsCache);
    } catch (e) {
      findingsListEl.innerHTML = `
        <div class="findings-error">
          nie można pobrać Findingów
        </div>`;
      if (findingsSummaryEl) {
        findingsSummaryEl.innerHTML = `
          <div class="findings-error">
            błąd API
          </div>`;
      }
    }
  }

  function formatFindingDate(value) {
    if (!value) return "";

    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value);

      return d.toLocaleString("pl-PL");
    } catch (e) {
      return String(value);
    }
  }

  function renderPrimitive(value) {
    if (value === null || value === undefined) return "—";

    if (typeof value === "boolean") {
      return value ? "tak" : "nie";
    }

    if (typeof value === "object") {
      return escapeHtml(JSON.stringify(value, null, 2));
    }

    return escapeHtml(String(value));
  }

  function renderLifecycleArray(title, items) {
    if (!Array.isArray(items) || items.length === 0) {
      return `
        <section class="finding-detail-section">
          <div class="finding-detail-section-title">${escapeHtml(title)}</div>
          <div class="finding-detail-empty">brak danych</div>
        </section>`;
    }

    return `
      <section class="finding-detail-section">
        <div class="finding-detail-section-title">
          ${escapeHtml(title)}
          <span class="finding-detail-section-count">${items.length}</span>
        </div>
        <div class="finding-lifecycle-list">
          ${items.map((item, index) => {
            const status = findingValue(
              item,
              ["status", "result", "outcome", "state"],
              ""
            );

            const date = findingValue(
              item,
              ["created_at", "updated_at", "timestamp", "date", "tested_at"],
              ""
            );

            const name = findingValue(
              item,
              ["name", "title", "type", "method", "assessment"],
              `#${index + 1}`
            );

            const score = findingValue(
              item,
              ["score", "risk_score", "cvss", "value"],
              ""
            );

            return `
              <div class="finding-lifecycle-item">
                <div class="finding-lifecycle-head">
                  <span class="finding-lifecycle-name">
                    ${escapeHtml(String(name))}
                  </span>
                  ${
                    status
                      ? `<span class="finding-lifecycle-status">${escapeHtml(String(status))}</span>`
                      : ""
                  }
                </div>
                ${
                  date
                    ? `<div class="finding-lifecycle-date">${escapeHtml(formatFindingDate(date))}</div>`
                    : ""
                }
                ${
                  score !== ""
                    ? `<div class="finding-lifecycle-score">score: ${renderPrimitive(score)}</div>`
                    : ""
                }
                <pre class="finding-lifecycle-data">${renderPrimitive(item)}</pre>
              </div>`;
          }).join("")}
        </div>
      </section>`;
  }

  function openFindingDetail(finding) {
    if (!findingDetailOverlay) return;

    const id = findingId(finding);
    const title = findingTitle(finding);
    const severity = findingSeverity(
      findingValue(finding, ["severity", "risk", "priority"], "low")
    );

    findingDetailTitle.textContent = `${id} — ${title}`;

    const description = findingDescription(finding);

    const validation = findingValue(
      finding,
      ["validations", "validation", "validation_results"],
      []
    );

    const retests = findingValue(
      finding,
      ["retests", "retest", "retest_results"],
      []
    );

    const riskAssessments = findingValue(
      finding,
      ["risk_assessments", "risk_assessment", "riskAssessments"],
      []
    );

    const createdAt = findingValue(
      finding,
      ["created_at", "created", "timestamp"],
      ""
    );

    findingDetailContent.innerHTML = `
      <div class="finding-detail-severity finding-detail-severity-${severity}">
        <span class="finding-list-icon finding-list-icon-${severity}"></span>
        <strong>${findingSeverityLabel(severity)}</strong>
      </div>

      ${
        description
          ? `<section class="finding-detail-section">
              <div class="finding-detail-section-title">OPIS / EVIDENCE</div>
              <div class="finding-detail-description">${renderPrimitive(description)}</div>
            </section>`
          : ""
      }

      ${
        createdAt
          ? `<div class="finding-detail-meta">
              utworzono: ${escapeHtml(formatFindingDate(createdAt))}
            </div>`
          : ""
      }

      ${renderLifecycleArray("VALIDATION", Array.isArray(validation) ? validation : [validation].filter(Boolean))}
      ${renderLifecycleArray("RETESTY", Array.isArray(retests) ? retests : [retests].filter(Boolean))}
      ${renderLifecycleArray("RISK ASSESSMENTS", Array.isArray(riskAssessments) ? riskAssessments : [riskAssessments].filter(Boolean))}

      <section class="finding-detail-section finding-raw-section">
        <details>
          <summary>Surowe dane Findinga</summary>
          <pre class="finding-raw">${escapeHtml(JSON.stringify(finding, null, 2))}</pre>
        </details>
      </section>
    `;

    findingDetailOverlay.classList.remove("hidden");
  }

  function closeFindingDetail() {
    if (findingDetailOverlay) {
      findingDetailOverlay.classList.add("hidden");
    }
  }

  if (findingsRefreshBtn) {
    findingsRefreshBtn.addEventListener("click", loadFindings);
  }

  if (findingDetailClose) {
    findingDetailClose.addEventListener("click", closeFindingDetail);
  }

  if (findingDetailOverlay) {
    findingDetailOverlay.addEventListener("click", (e) => {
      if (e.target === findingDetailOverlay) {
        closeFindingDetail();
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeFindingDetail();
    }
  });

  function initNetworkMap() {
    const svg = document.getElementById("map-svg");
    if (!svg) return;

    const continents = [
      { cx: 170, cy: 150, rx: 85, ry: 75 },
      { cx: 165, cy: 245, rx: 32, ry: 22 },
      { cx: 235, cy: 350, rx: 52, ry: 85 },
      { cx: 500, cy: 110, rx: 42, ry: 38 },
      { cx: 510, cy: 270, rx: 58, ry: 108 },
      { cx: 700, cy: 140, rx: 138, ry: 92 },
      { cx: 650, cy: 250, rx: 34, ry: 34 },
      { cx: 730, cy: 270, rx: 34, ry: 28 },
      { cx: 830, cy: 370, rx: 54, ry: 38 },
    ];

    let dots = "";
    const step = 13;
    for (let x = 40; x < 960; x += step) {
      for (let y = 30; y < 470; y += step) {
        for (let i = 0; i < continents.length; i++) {
          const c = continents[i];
          const dx = (x - c.cx) / c.rx;
          const dy = (y - c.cy) / c.ry;
          if (dx * dx + dy * dy <= 1) {
            const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
            const frac = h - Math.floor(h);
            if (frac > 0.14) {
              dots += `<circle cx="${x}" cy="${y}" r="${(1.2 + frac * 0.7).toFixed(2)}"></circle>`;
            }
            break;
          }
        }
      }
    }

    const server = { x: 508, y: 102 };
    function makeArc(tx, ty) {
      const mx = (server.x + tx) / 2;
      const my = (server.y + ty) / 2;
      const dist = Math.hypot(tx - server.x, ty - server.y);
      const lift = Math.min(140, dist * 0.35);
      return { d: `M ${server.x} ${server.y} Q ${mx} ${my - lift} ${tx} ${ty}`, tx, ty };
    }
    const arcs = [makeArc(170, 150), makeArc(235, 350), makeArc(650, 250), makeArc(830, 370)];

    const arcPaths = arcs.map((a) => `<path class="map-arc" d="${a.d}"></path>`).join("");
    const arcDots = arcs.map((a) => `<circle class="map-endpoint" cx="${a.tx}" cy="${a.ty}" r="3"></circle>`).join("");

    svg.innerHTML = `
      <g class="map-dots">${dots}</g>
      <g class="map-arcs">${arcPaths}</g>
      ${arcDots}
      <circle class="map-server-ring" cx="${server.x}" cy="${server.y}" r="9"></circle>
      <circle class="map-server-ring map-server-ring-delay" cx="${server.x}" cy="${server.y}" r="9"></circle>
      <circle class="map-server-dot" cx="${server.x}" cy="${server.y}" r="5"></circle>
    `;
  }

  initNetworkMap();
  resumeSession();
  loadTools();
  loadModels();
  loadFindings();
})();
