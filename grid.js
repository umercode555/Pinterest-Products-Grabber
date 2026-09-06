// ---------- Script parsing: paste everything, auto-split into 10-product scripts ----------

const CTA_PATTERN = /also comment/i;

function cleanProductLine(line) {
  let s = line;
  s = s.replace(/^\s*\d+[\.\)]\s*/, "").replace(/^\s*[-\u2022]\s*/, "");
  s = s.replace(/\band\b/gi, " ");
  s = s.replace(/\s{2,}/g, " ").trim();
  s = s.replace(/^[,;:.\-"']+|[,;:.\-"']+$/g, "").trim();
  return s;
}

function parseAllScripts(raw) {
  const segments = (raw || "")
    .split(/(?<=[.?!])\s+|\r?\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const scripts = [];
  let i = 0;
  while (i < segments.length) {
    const intro = segments[i++] || "";
    let cta = "";
    const products = [];

    while (i < segments.length && products.length < 10) {
      const seg = segments[i];
      if (CTA_PATTERN.test(seg)) {
        cta = seg;
        i++;
        continue;
      }
      const parts = seg.split(",").map(cleanProductLine).filter(Boolean);
      for (const p of parts) {
        if (products.length < 10) products.push(p);
      }
      i++;
    }

    if (products.length) {
      scripts.push({ intro, cta, products });
    } else {
      break;
    }
  }
  return scripts;
}

// ---------- State ----------

let scripts = [];
let activeTab = 0;
let scriptCache = {};   // scriptIndex -> [{keyword, images}]
let inFlight = new Set();
let doneScripts = new Set();
let pendingStartBadge = null;

// keyboard-nav state
let focusGrid = [];      // focusGrid[rowIdx] = [{el, src, keyword}, ...]
let focusRow = 0;
let focusCol = 0;
let overlayOpen = false;
let overlayRawSrc = null;
let overlayKeyword = null;
let overlayThumbEl = null;

// ---------- Full-session persistence (survives closed tab / browser / laptop) ----------
const STATE_KEY = "ppgGridState";
let stateLoaded = false;
let saveQueued = false;

function saveState() {
  if (!stateLoaded) return; // never overwrite saved state with blank pre-load values
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    chrome.storage.local.set({
      [STATE_KEY]: {
        rawInput: scriptInput.value,
        scripts,
        activeTab,
        doneScripts: Array.from(doneScripts),
        scriptCache,
        timerElapsedBeforePause,
        timerRunning,
        timerStartedAt
      }
    });
  }, 150);
}

function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STATE_KEY], (s) => resolve(s[STATE_KEY] || null));
  });
}

const scriptInput = document.getElementById("scriptInput");
const parseBtn = document.getElementById("parseBtn");
const parseStatus = document.getElementById("parseStatus");
const tabBar = document.getElementById("tabBar");
const scriptMeta = document.getElementById("scriptMeta");
const statusEl = document.getElementById("status");
const rowsEl = document.getElementById("rows");
const scriptsDoneCountEl = document.getElementById("scriptsDoneCount");

// ---------- Dopamine layer: progress bar + celebration ----------
let progressCelebrated = false;
function updateProgressBar() {
  const total = scripts.length;
  const done = doneScripts.size;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const fill = document.getElementById("progressFill");
  const truck = document.getElementById("progressTruck");
  if (!fill) return;
  fill.style.width = pct + "%";
  truck.style.left = pct + "%";
  document.getElementById("progressDoneText").textContent = done;
  document.getElementById("progressTotalText").textContent = total;
  document.getElementById("progressPctText").textContent = pct + "%";
  if (total && done === total) {
    if (!progressCelebrated) {
      progressCelebrated = true;
      if (window.PPGFX) {
        window.PPGFX.confetti(1600);
        window.PPGFX.ping("big");
        window.PPGFX.toast("All scripts done for this batch!", window.PPGFX.icons.flag);
      }
    }
  } else {
    progressCelebrated = false;
  }
}
const badgeStartInput = document.getElementById("badgeStartInput");
const applyBadgeBtn = document.getElementById("applyBadgeBtn");
const badgeHint = document.getElementById("badgeHint");

// ---------- Badge numbering (persists across days) ----------

function getNextBadge() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["ppgNextBadge"], (s) => resolve(s.ppgNextBadge || 1));
  });
}
function setNextBadge(n) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ ppgNextBadge: n }, resolve);
  });
}

async function refreshBadgeHint() {
  const next = await getNextBadge();
  badgeHint.textContent = pendingStartBadge
    ? `Will start this batch at Badge ${pendingStartBadge}.`
    : `Next batch starts at Badge ${next}.`;
}
refreshBadgeHint();

applyBadgeBtn.addEventListener("click", () => {
  const n = parseInt(badgeStartInput.value, 10);
  if (!n || n < 1) return;
  pendingStartBadge = n;
  refreshBadgeHint();
});

// ---------- Timer ----------

let timerStartedAt = null;
let timerElapsedBeforePause = 0;
let timerRunning = false;

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
function tickTimer() {
  if (!timerRunning) return;
  document.getElementById("timerDisplay").textContent =
    formatElapsed(timerElapsedBeforePause + (Date.now() - timerStartedAt));
}
setInterval(tickTimer, 1000);

document.getElementById("timerStartBtn").addEventListener("click", (e) => {
  if (!timerRunning) {
    timerRunning = true;
    timerStartedAt = Date.now();
    e.target.textContent = "Pause";
  } else {
    timerRunning = false;
    timerElapsedBeforePause += Date.now() - timerStartedAt;
    e.target.textContent = "Start";
  }
  saveState();
});
document.getElementById("timerResetBtn").addEventListener("click", () => {
  timerRunning = false;
  timerStartedAt = null;
  timerElapsedBeforePause = 0;
  document.getElementById("timerDisplay").textContent = "00:00";
  document.getElementById("timerStartBtn").textContent = "Start";
  saveState();
});

// ---------- Parsing + Badge assignment ----------

parseBtn.addEventListener("click", async () => {
  const raw = scriptInput.value;
  scripts = parseAllScripts(raw);
  scriptCache = {};
  inFlight = new Set();
  doneScripts = new Set();
  activeTab = 0;
  scriptsDoneCountEl.textContent = "0";
  progressCelebrated = false;
  updateProgressBar();

  if (!scripts.length) {
    parseStatus.textContent = "\u26A0 Couldn't find any products in that text.";
    tabBar.innerHTML = "";
    rowsEl.innerHTML = "";
    scriptMeta.innerHTML = "";
    return;
  }

  const startBadge = pendingStartBadge || (await getNextBadge());
  scripts.forEach((s, idx) => (s.badge = startBadge + idx));
  await setNextBadge(startBadge + scripts.length);
  pendingStartBadge = null;
  refreshBadgeHint();

  parseStatus.textContent =
    `Parsed ${scripts.length} script${scripts.length === 1 ? "" : "s"} \u2014 ` +
    `Badge ${scripts[0].badge}\u2013${scripts[scripts.length - 1].badge}.`;

  renderTabs();
  renderScript(0);
  prefetchRemaining();
  saveState();
});

scriptInput.addEventListener("input", saveState);

// ---------- Fetching (on-demand + background prefetch, non-blocking) ----------

function fetchGridImages(keywords, limit) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "FETCH_GRID_IMAGES", keywords, limit }, resolve);
  });
}

async function loadImagesForScript(idx) {
  if (scriptCache[idx]) {
    if (idx === activeTab) applyResults(idx, scriptCache[idx]);
    return;
  }
  if (inFlight.has(idx)) return;
  inFlight.add(idx);
  if (idx === activeTab) statusEl.textContent = "Fetching images for Script " + (idx + 1) + "\u2026";

  const results = await fetchGridImages(scripts[idx].products, 8);
  scriptCache[idx] = results || [];
  inFlight.delete(idx);

  if (idx === activeTab) {
    statusEl.textContent = "";
    applyResults(idx, scriptCache[idx]);
  }
  saveState();
}

async function prefetchRemaining() {
  for (let idx = 0; idx < scripts.length; idx++) {
    await loadImagesForScript(idx);
  }
}

// ---------- Rendering ----------

function renderTabs() {
  tabBar.innerHTML = "";
  scripts.forEach((s, idx) => {
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (idx === activeTab ? " active" : "") + (doneScripts.has(idx) ? " done" : "");
    btn.innerHTML =
      `<span class="tab-label">Script ${idx + 1} \u00b7 B${s.badge}${doneScripts.has(idx) ? " \u2713" : ""}</span>` +
      `<span class="tab-del-btn" data-idx="${idx}" title="Delete this script">\u2715</span>`;
    btn.addEventListener("click", (e) => {
      if (e.target.classList.contains("tab-del-btn")) {
        e.stopPropagation();
        deleteScript(parseInt(e.target.dataset.idx, 10));
        return;
      }
      activeTab = idx;
      renderTabs();
      renderScript(idx);
      saveState();
    });
    tabBar.appendChild(btn);
  });
}

function deleteScript(idx) {
  if (idx < 0 || idx >= scripts.length) return;
  const label = `Script ${idx + 1} (Badge ${scripts[idx].badge})`;
  if (!confirm(`Delete ${label}? This only removes this script's progress/selections \u2014 other scripts and already-downloaded files are not affected.`)) return;

  scripts.splice(idx, 1);

  const newDone = new Set();
  doneScripts.forEach((i) => {
    if (i < idx) newDone.add(i);
    else if (i > idx) newDone.add(i - 1);
  });
  doneScripts = newDone;

  const newCache = {};
  Object.keys(scriptCache).forEach((k) => {
    const i = parseInt(k, 10);
    if (i < idx) newCache[i] = scriptCache[k];
    else if (i > idx) newCache[i - 1] = scriptCache[k];
  });
  scriptCache = newCache;

  if (activeTab >= scripts.length) activeTab = Math.max(0, scripts.length - 1);
  else if (activeTab > idx) activeTab -= 1;

  scriptsDoneCountEl.textContent = String(doneScripts.size);
  updateProgressBar();

  if (scripts.length) {
    renderTabs();
    renderScript(activeTab);
    parseStatus.textContent = `${scripts.length} script${scripts.length === 1 ? "" : "s"} remaining.`;
  } else {
    tabBar.innerHTML = "";
    scriptMeta.innerHTML = "";
    rowsEl.innerHTML = "";
    parseStatus.textContent = "All scripts deleted.";
  }
  saveState();
}

function deleteAllScripts() {
  if (!scripts.length) return;
  if (!confirm("Delete ALL scripts and their progress? Already-downloaded badge files are not affected.")) return;
  scripts = [];
  doneScripts = new Set();
  scriptCache = {};
  activeTab = 0;
  scriptsDoneCountEl.textContent = "0";
  progressCelebrated = false;
  updateProgressBar();
  tabBar.innerHTML = "";
  scriptMeta.innerHTML = "";
  rowsEl.innerHTML = "";
  parseStatus.textContent = "All scripts deleted.";
  saveState();
}

const deleteAllScriptsBtn = document.getElementById("deleteAllScriptsBtn");
if (deleteAllScriptsBtn) deleteAllScriptsBtn.addEventListener("click", deleteAllScripts);

function renderScript(idx) {
  const script = scripts[idx];
  focusGrid = script.products.map(() => []);
  focusRow = 0;
  focusCol = 0;

  scriptMeta.innerHTML =
    `<b>Badge:</b> ${script.badge} &mdash; downloads for this script save into folder "Badge ${script.badge}".<br>` +
    (script.intro ? `<b>Intro:</b> ${script.intro}<br>` : "") +
    (script.cta ? `<b>CTA:</b> ${script.cta}` : "") +
    ` <button class="mark-done-btn" id="markDoneBtn">${doneScripts.has(idx) ? "Marked done \u2713" : "Mark script done"}</button>`;

  document.getElementById("markDoneBtn").addEventListener("click", () => {
    if (doneScripts.has(idx)) doneScripts.delete(idx);
    else doneScripts.add(idx);
    scriptsDoneCountEl.textContent = String(doneScripts.size);
    updateProgressBar();
    renderTabs();
    renderScript(idx);
    saveState();
  });

  rowsEl.innerHTML = "";
  script.products.forEach((keyword) => {
    const row = document.createElement("div");
    row.className = "kw-row";
    row.dataset.keyword = keyword;

    const label = document.createElement("div");
    label.className = "kw-label";
    label.textContent = keyword;
    row.appendChild(label);

    const imgsWrap = document.createElement("div");
    imgsWrap.className = "kw-imgs";
    imgsWrap.innerHTML = '<div class="row-loading">Loading\u2026</div>';
    row.appendChild(imgsWrap);

    rowsEl.appendChild(row);
  });

  loadImagesForScript(idx);
}

function applyResults(idx, results) {
  if (idx !== activeTab) return;
  const script = scripts[idx];
  const rowIndexByKeyword = {};
  script.products.forEach((k, i) => (rowIndexByKeyword[k] = i));

  results.forEach(({ keyword, images }) => {
    const row = rowsEl.querySelector(`.kw-row[data-keyword="${CSS.escape(keyword)}"]`);
    if (!row) return;
    const imgsWrap = row.querySelector(".kw-imgs");
    imgsWrap.innerHTML = "";

    const rIdx = rowIndexByKeyword[keyword];
    focusGrid[rIdx] = [];

    if (!images.length) {
      imgsWrap.innerHTML = '<div class="row-empty">No images found</div>';
      return;
    }

    images.forEach((src) => {
      const wrap = document.createElement("div");
      wrap.className = "thumb-wrap";
      const img = document.createElement("img");
      img.src = src;
      img.loading = "lazy";
      wrap.appendChild(img);
      wrap.addEventListener("click", () => openOverlay(src, keyword, wrap));
      imgsWrap.appendChild(wrap);
      focusGrid[rIdx].push({ el: wrap, src, keyword });
    });
  });

  updateFocusRing();
}

// ---------- Keyboard navigation ----------

function nearestNonEmptyRow(fromRow, dir) {
  let r = fromRow;
  for (let steps = 0; steps < focusGrid.length; steps++) {
    r += dir;
    if (r < 0 || r >= focusGrid.length) return null;
    if (focusGrid[r] && focusGrid[r].length) return r;
  }
  return null;
}

function updateFocusRing() {
  document.querySelectorAll(".thumb-wrap.ppg-focused").forEach((el) => el.classList.remove("ppg-focused"));
  const cell = focusGrid[focusRow] && focusGrid[focusRow][focusCol];
  if (cell) {
    cell.el.classList.add("ppg-focused");
    cell.el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function moveFocus(dRow, dCol) {
  if (overlayOpen) return;
  if (dRow !== 0) {
    const target = nearestNonEmptyRow(focusRow, dRow);
    if (target !== null) {
      focusRow = target;
      focusCol = Math.min(focusCol, focusGrid[focusRow].length - 1);
    }
  } else if (dCol !== 0) {
    const row = focusGrid[focusRow] || [];
    if (row.length) focusCol = Math.max(0, Math.min(row.length - 1, focusCol + dCol));
  }
  updateFocusRing();
}

document.addEventListener("keydown", (e) => {
  // Don't hijack keys while typing in the script textarea / badge input.
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") {
    if (e.key === "Escape") document.activeElement.blur();
    return;
  }

  if (overlayOpen) {
    if (e.key === "Enter") {
      e.preventDefault();
      triggerOverlaySave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeOverlay();
    }
    return;
  }

  switch (e.key) {
    case "ArrowUp":
    case "w":
    case "W":
      e.preventDefault();
      moveFocus(-1, 0);
      break;
    case "ArrowDown":
    case "s":
    case "S":
      e.preventDefault();
      moveFocus(1, 0);
      break;
    case "ArrowLeft":
    case "a":
    case "A":
      e.preventDefault();
      moveFocus(0, -1);
      break;
    case "ArrowRight":
    case "d":
    case "D":
      e.preventDefault();
      moveFocus(0, 1);
      break;
    case "Enter": {
      e.preventDefault();
      const cell = focusGrid[focusRow] && focusGrid[focusRow][focusCol];
      if (cell) openOverlay(cell.src, cell.keyword, cell.el);
      break;
    }
    default:
      break;
  }
});

// ---------- Preview overlay ----------

const overlay = document.getElementById("overlay");
const overlayImg = document.getElementById("overlayImg");
const overlayStatus = document.getElementById("overlayStatus");
const overlaySaveBtn = document.getElementById("overlaySaveBtn");
const overlayCloseBtn = document.getElementById("overlayCloseBtn");

function openOverlay(rawSrc, keyword, thumbEl) {
  overlayOpen = true;
  overlayRawSrc = rawSrc;
  overlayKeyword = keyword;
  overlayThumbEl = thumbEl;
  overlayImg.src = rawSrc;
  overlayStatus.textContent = "Resolving full resolution\u2026 (Enter to save, Esc to close)";
  overlaySaveBtn.disabled = false;
  overlaySaveBtn.textContent = "Save HD";
  overlay.classList.add("show");

  chrome.runtime.sendMessage({ type: "RESOLVE_HD_URL", src: rawSrc }, (res) => {
    if (overlayRawSrc !== rawSrc) return;
    if (res && res.hdUrl) {
      overlayImg.src = res.hdUrl;
      overlayStatus.textContent = "Full resolution \u2014 Enter to save, Esc to close.";
    } else {
      overlayStatus.textContent = "No higher-res version found \u2014 this is the best available. Enter to save, Esc to close.";
    }
  });
}

function closeOverlay() {
  overlayOpen = false;
  overlay.classList.remove("show");
}

function triggerOverlaySave() {
  if (overlaySaveBtn.disabled) return;
  overlaySaveBtn.disabled = true;
  overlaySaveBtn.textContent = "Saving\u2026";
  const badgeFolder = "Badge " + scripts[activeTab].badge;

  chrome.runtime.sendMessage(
    { type: "DOWNLOAD_TO_BADGE", src: overlayRawSrc, keyword: overlayKeyword, badgeFolder },
    (result) => {
      if (result && result.ok) {
        overlaySaveBtn.textContent = "Saved \u2713";
        if (overlayThumbEl) overlayThumbEl.classList.add("ppg-saved");
        if (window.PPGFX) window.PPGFX.ping();
        if (result.milestone && window.PPGFX) window.PPGFX.milestoneToast(result.milestone);
        setTimeout(closeOverlay, 450);
        renderBadgeManager();
      } else {
        overlaySaveBtn.disabled = false;
        overlaySaveBtn.textContent = "Save HD";
        const reason = result && result.error ? result.error : "failed";
        overlayStatus.textContent = `\u26A0 Could not save (${reason}). Enter to retry, Esc to close.`;
      }
    }
  );
}

overlayCloseBtn.addEventListener("click", closeOverlay);
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeOverlay();
});
overlaySaveBtn.addEventListener("click", triggerOverlaySave);

// ---------- Badge manager: delete one badge or all badges ----------

const badgeManagerEl = document.getElementById("badgeManager");
const deleteAllBadgesBtn = document.getElementById("deleteAllBadgesBtn");

function getBadgesFromBg() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_BADGES" }, (res) => resolve(res || {}));
  });
}

async function renderBadgeManager() {
  if (!badgeManagerEl) return;
  const badges = await getBadgesFromBg();
  const names = Object.keys(badges).sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(b.replace(/\D/g, ""), 10) || 0;
    return na - nb;
  });

  if (!names.length) {
    badgeManagerEl.innerHTML = '<span style="font-size:12px;color:#aaa;">No saved badges yet.</span>';
    deleteAllBadgesBtn.style.display = "none";
    return;
  }
  deleteAllBadgesBtn.style.display = "inline-block";

  badgeManagerEl.innerHTML = "";
  names.forEach((name) => {
    const chip = document.createElement("span");
    chip.className = "badge-chip";
    chip.innerHTML =
      `${name} (${badges[name].length}) <button class="badge-del-btn" data-badge="${name}">\u2715</button>`;
    badgeManagerEl.appendChild(chip);
  });

  badgeManagerEl.querySelectorAll(".badge-del-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.badge;
      await new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: "DELETE_BADGE", badgeFolder: name }, resolve)
      );
      renderBadgeManager();
    });
  });
}

deleteAllBadgesBtn.addEventListener("click", async () => {
  if (!confirm("Delete ALL saved badges? This can't be undone. Scripts and progress are not affected.")) return;
  await new Promise((resolve) => chrome.runtime.sendMessage({ type: "DELETE_ALL_BADGES" }, resolve));
  renderBadgeManager();
});

renderBadgeManager();

// ---------- Restore full session on load (scripts, progress, timer) ----------

(async function restoreSession() {
  const saved = await loadState();
  if (saved && Array.isArray(saved.scripts) && saved.scripts.length) {
    scripts = saved.scripts;
    activeTab = saved.activeTab || 0;
    doneScripts = new Set(saved.doneScripts || []);
    scriptCache = saved.scriptCache || {};
    scriptInput.value = saved.rawInput || "";
    scriptsDoneCountEl.textContent = String(doneScripts.size);
    updateProgressBar();

    timerElapsedBeforePause = saved.timerElapsedBeforePause || 0;
    timerRunning = !!saved.timerRunning;
    timerStartedAt = saved.timerStartedAt || null;
    if (timerRunning) {
      document.getElementById("timerStartBtn").textContent = "Pause";
    } else if (timerStartedAt) {
      // was running, tab got closed mid-run: fold that time into elapsed
      timerElapsedBeforePause += Date.now() - timerStartedAt;
      timerStartedAt = null;
    }
    tickTimer();

    parseStatus.textContent =
      `Restored ${scripts.length} script${scripts.length === 1 ? "" : "s"} \u2014 ` +
      `Badge ${scripts[0].badge}\u2013${scripts[scripts.length - 1].badge}.`;

    renderTabs();
    renderScript(activeTab);
    prefetchRemaining();
  } else if (saved && saved.rawInput) {
    scriptInput.value = saved.rawInput;
  }
  stateLoaded = true;
})();

// ---------- Dopamine layer: Today's Summary ----------
function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

async function computeTodaySummary() {
  const s = await chrome.storage.local.get(["gridBatches", "packHistory"]);
  const gridBatches = s.gridBatches || {};
  const packHistory = s.packHistory || [];

  let images = 0;
  const packsToday = new Set();
  Object.keys(gridBatches).forEach((folder) => {
    gridBatches[folder].forEach((item) => {
      if (isToday(item.ts)) {
        images += 1;
        packsToday.add(folder);
      }
    });
  });
  packHistory.forEach((p) => {
    if (isToday(p.finishedAt)) {
      images += p.count || 0;
      packsToday.add(p.folder);
    }
  });

  const elapsedMs = timerElapsedBeforePause + (timerRunning && timerStartedAt ? Date.now() - timerStartedAt : 0);
  const minutes = formatElapsed(elapsedMs);

  return { images, scripts: doneScripts.size, packs: packsToday.size, minutes };
}

const summaryBtn = document.getElementById("summaryBtn");
if (summaryBtn) {
  summaryBtn.addEventListener("click", async () => {
    const data = await computeTodaySummary();
    if (window.PPGFX) window.PPGFX.showSummaryModal(data);
  });
}
