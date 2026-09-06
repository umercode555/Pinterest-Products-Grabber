async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}

function formatDuration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ---------- Script parsing ----------
// Splits a full pasted video script into:
//   intro    - the first non-empty line (kept verbatim, exported as INTRO_CAPTION)
//   cta      - the line containing "Also comment..." (kept verbatim, exported as CTA_CAPTION)
//   products - everything else, cleaned up into the up-to-10 queue items
// This replaces the old "just paste a comma list" flow but the queue itself
// still ends up as a plain array of product strings, so nothing downstream
// (background.js, the download/queue logic) needs to change.

const CTA_PATTERN = /also comment/i;

function cleanProductLine(line) {
  let s = line;
  // strip leading numbering/bullets: "1.", "1)", "-", "•"
  s = s.replace(/^\s*\d+[\.\)]\s*/, "").replace(/^\s*[-•]\s*/, "");
  // drop filler word "and" (whole word only, so "brand" etc. is untouched)
  s = s.replace(/\band\b/gi, " ");
  // collapse whitespace and stray leading/trailing punctuation/quotes
  s = s.replace(/\s{2,}/g, " ").trim();
  s = s.replace(/^[,;:.\-"']+|[,;:.\-"']+$/g, "").trim();
  return s;
}

function parseScript(raw) {
  // Scripts get pasted either as separate lines OR as one flowing paragraph
  // (e.g. "...under $100. Versace Eros, Paco Rabanne... Also comment
  // "BEGINNER1" for the list. JPG Le Male..."). So split on newlines AND on
  // whitespace that follows sentence-ending punctuation (. ! ?), whichever
  // is present, so both styles produce one "segment" per sentence/line.
  const segments = (raw || "")
    .split(/(?<=[.?!])\s+|\r?\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (!segments.length) return { intro: "", cta: "", products: [] };

  const introIdx = 0;
  const ctaIdx = segments.findIndex((s, i) => i !== introIdx && CTA_PATTERN.test(s));

  const intro = segments[introIdx] || "";
  const cta = ctaIdx >= 0 ? segments[ctaIdx] : "";

  const productSegments = segments.filter((_, i) => i !== introIdx && i !== ctaIdx);

  // Product segments might be one-per-line/sentence OR comma-separated
  // within a sentence (or a mix) — split on both so any style works.
  const products = productSegments
    .flatMap((s) => s.split(","))
    .map(cleanProductLine)
    .filter(Boolean)
    .slice(0, 10);

  return { intro, cta, products };
}

function isNewCalendarDay(ts) {
  return new Date(ts).toDateString() !== new Date().toDateString();
}

// Highest "Pack N" number seen anywhere (history + current counter), so a
// fresh suggestion always lands one past whatever actually happened —
// even if the stored counter drifted.
function suggestNextPackNumber(packHistory, currentPackNumber) {
  let maxSeen = currentPackNumber || 0;
  packHistory.forEach((p) => {
    const m = /Pack (\d+)/.exec(p.folder || "");
    if (m) maxSeen = Math.max(maxSeen, parseInt(m[1], 10));
  });
  return maxSeen + 1;
}

// Cached so the once-a-second tick doesn't need to hit chrome.storage.
let liveQueueStartedAt = null;
let queueIsActive = false;

function tickTimer() {
  const el = document.getElementById("queueTimerVal");
  if (!el || !liveQueueStartedAt || !queueIsActive) return;
  const elapsed = (Date.now() - liveQueueStartedAt) / 1000;
  el.textContent = formatDuration(elapsed);
}
setInterval(tickTimer, 1000);

async function render() {
  let {
    batch = [],
    folder = "",
    queue = [],
    queueIndex = 0,
    queueStartedAt = null,
    packHistory = [],
    introCaption = "",
    ctaCaption = "",
    packNumber = 0,
    folderCreatedAt = null,
    autoSearchNext = true
  } = await chrome.storage.local.get([
    "batch",
    "folder",
    "queue",
    "queueIndex",
    "queueStartedAt",
    "packHistory",
    "introCaption",
    "ctaCaption",
    "packNumber",
    "folderCreatedAt",
    "autoSearchNext"
  ]);

  // A folder left over from a previous day gets auto-archived here too,
  // so the popup never shows yesterday's items as if they were today's.
  if (folder && folderCreatedAt && isNewCalendarDay(folderCreatedAt)) {
    if (batch.length) {
      packHistory.push({
        folder,
        count: batch.length,
        finishedAt: Date.now(),
        durationSec: null,
        incomplete: true
      });
    }
    folder = null;
    batch = [];
    await chrome.storage.local.set({ batch, folder, folderCreatedAt: null, packHistory });
  }

  // Batch section
  document.getElementById("count").textContent =
    batch.length + " item" + (batch.length === 1 ? "" : "s") + (folder ? " — " + folder : "");

  const list = document.getElementById("list");
  list.innerHTML = "";
  batch.forEach((item) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<span class="file">${item.file}</span><span>${item.keyword}</span>`;
    list.appendChild(row);
  });

  // Queue section (with live elapsed timer)
  const statusEl = document.getElementById("queueStatus");
  const actionsEl = document.getElementById("queueActions");
  liveQueueStartedAt = queueStartedAt;

  const metaEl = document.getElementById("scriptMeta");

  if (!queue.length) {
    queueIsActive = false;
    statusEl.className = "empty";
    statusEl.textContent = "No active queue.";
    actionsEl.style.display = "none";
    metaEl.style.display = "none";
  } else {
    const current = queue[queueIndex];
    const remaining = Math.max(queue.length - queueIndex, 0);
    const clockIcon = window.PPGFX ? window.PPGFX.icons.clock : "";
    const timerHtml = queueStartedAt ? `<div id="queueTimer"><span style="width:12px;height:12px;display:inline-flex;">${clockIcon}</span> <span id="queueTimerVal">${formatDuration((Date.now() - queueStartedAt) / 1000)}</span></div>` : "";

    if (!current) {
      queueIsActive = false;
      statusEl.className = "";
      const trophyIcon = window.PPGFX ? window.PPGFX.icons.trophy : "";
      statusEl.innerHTML = `<b style="display:inline-flex;align-items:center;gap:5px;"><span style="width:14px;height:14px;display:inline-flex;color:var(--ppg-accent);">${trophyIcon}</span>Queue complete</b> — ${queue.length}/${queue.length} products downloaded.${timerHtml}`;
      actionsEl.style.display = "none";
    } else {
      queueIsActive = true;
      statusEl.className = "";
      statusEl.innerHTML =
        `Product <b>${queueIndex + 1}</b> of ${queue.length} — <span class="kw">"${current}"</span><br>` +
        `${remaining} remaining. Copied to clipboard: use the purple button on the image to save & auto-advance.` +
        timerHtml;
      actionsEl.style.display = "flex";
    }

    if (introCaption || ctaCaption) {
      metaEl.style.display = "block";
      metaEl.innerHTML =
        (introCaption ? `<b>INTRO_CAPTION:</b> ${introCaption}<br>` : "") +
        (ctaCaption ? `<b>CTA_CAPTION:</b> ${ctaCaption}` : "");
    } else {
      metaEl.style.display = "none";
    }
  }

  // History section — persists forever until explicitly cleared, so you can
  // always see how many packs (and total images) you've downloaded overall.
  const totalImages = packHistory.reduce((sum, p) => sum + p.count, 0);
  document.getElementById("historyTotal").textContent = packHistory.length
    ? `— ${packHistory.length} pack${packHistory.length === 1 ? "" : "s"}, ${totalImages} images total`
    : "";

  const historyList = document.getElementById("historyList");
  const historyActions = document.getElementById("historyActions");
  if (!packHistory.length) {
    historyList.className = "empty";
    historyList.textContent = "No finished packs yet.";
    historyActions.style.display = "none";
  } else {
    historyList.className = "";
    historyList.innerHTML = "";
    // newest first
    [...packHistory].reverse().forEach((p, i) => {
      const row = document.createElement("div");
      row.className = "hist-item";
      if (i === 0 && p._justFinished) row.classList.add("ppg-new");
      const date = new Date(p.finishedAt);
      const dateStr = date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const durationStr = typeof p.durationSec === "number" ? formatDuration(p.durationSec) + " · " : "";
      const incompleteTag = p.incomplete ? ' <span style="color:#c0392b;">(incomplete)</span>' : "";
      row.innerHTML = `<span class="hname">${p.folder}${incompleteTag}</span><span class="hmeta">${p.count} imgs · ${durationStr}${dateStr}<button class="hist-folder-btn" data-folder="${p.folder}" title="Show in Finder"><svg width="13" height="13" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 5.5C2 4.67157 2.67157 4 3.5 4H7.5L9.5 6H16.5C17.3284 6 18 6.67157 18 7.5V14.5C18 15.3284 17.3284 16 16.5 16H3.5C2.67157 16 2 15.3284 2 14.5V5.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></button></span>`;
      historyList.appendChild(row);
    });
    historyActions.style.display = "flex";
  }

  // Pack # control
  const packInput = document.getElementById("packNumInput");
  const packHint = document.getElementById("packNumHint");
  if (folder) {
    const m = /Pack (\d+)/.exec(folder);
    packInput.value = m ? m[1] : "";
    packInput.disabled = true;
    packHint.textContent = `Saving to "${folder}" right now. Finish or Reset before changing the number.`;
  } else {
    packInput.disabled = false;
    packInput.value = suggestNextPackNumber(packHistory, packNumber);
    packHint.textContent = "Redoing a pack? Set its number here and hit \"Use this #\" before saving — new files overwrite the old ones.";
  }

  document.getElementById("autoSearchToggle").checked = autoSearchNext !== false;
}

document.getElementById("openGridBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("grid.html") });
});

document.getElementById("autoSearchToggle").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ autoSearchNext: e.target.checked });
});

document.getElementById("applyPackBtn").addEventListener("click", async () => {
  const n = parseInt(document.getElementById("packNumInput").value, 10);
  if (!n || n < 1) return;
  await chrome.storage.local.set({
    folder: "Pack " + n,
    packNumber: n,
    folderCreatedAt: Date.now(),
    batch: []
  });
  chrome.action.setBadgeText({ text: "" });
  render();
});

document.getElementById("startBtn").addEventListener("click", async () => {
  const raw = document.getElementById("queueInput").value;
  const { intro, cta, products } = parseScript(raw);
  if (!products.length) {
    const statusEl = document.getElementById("queueStatus");
    statusEl.className = "";
    statusEl.innerHTML = "⚠ Couldn't find any products in that text — paste the script as-is (paragraph or line-by-line both work).";
    return;
  }

  // No folder yet (fresh start) — lock in the pack number shown in the
  // input so it always matches what the popup displayed, then create a
  // fresh, empty folder for it. Prevents a new queue from silently
  // inheriting a stale folder/batch from earlier.
  const { folder: existingFolder, packNumber: storedPackNumber = 0, packHistory: ph = [] } =
    await chrome.storage.local.get(["folder", "packNumber", "packHistory"]);
  if (!existingFolder) {
    const inputVal = parseInt(document.getElementById("packNumInput").value, 10);
    const n = inputVal && inputVal > 0 ? inputVal : suggestNextPackNumber(ph, storedPackNumber);
    await chrome.storage.local.set({
      folder: "Pack " + n,
      packNumber: n,
      folderCreatedAt: Date.now(),
      batch: []
    });
  }

  // Real-time timer starts the moment the queue kicks off. Intro/CTA are
  // stashed separately from the queue — they never enter the download
  // workflow, they just ride along until Finish Batch writes the manifest.
  await chrome.storage.local.set({
    queue: products,
    queueIndex: 0,
    queueStartedAt: Date.now(),
    introCaption: intro,
    ctaCaption: cta
  });
  await copyText(products[0]);
  render();
});

document.getElementById("clearQueueBtn").addEventListener("click", async () => {
  await chrome.storage.local.remove(["queue", "queueIndex", "queueStartedAt", "introCaption", "ctaCaption"]);
  document.getElementById("queueInput").value = "";
  render();
});

document.getElementById("recopyBtn").addEventListener("click", async () => {
  const { queue = [], queueIndex = 0 } = await chrome.storage.local.get(["queue", "queueIndex"]);
  if (queue[queueIndex]) await copyText(queue[queueIndex]);
});

document.getElementById("skipBtn").addEventListener("click", async () => {
  const { queue = [], queueIndex = 0 } = await chrome.storage.local.get(["queue", "queueIndex"]);
  const nextIndex = Math.min(queueIndex + 1, queue.length);
  await chrome.storage.local.set({ queueIndex: nextIndex });
  if (queue[nextIndex]) await copyText(queue[nextIndex]);
  render();
});

document.getElementById("resetBtn").addEventListener("click", async () => {
  await chrome.storage.local.remove(["batch", "folder", "folderCreatedAt"]);
  chrome.action.setBadgeText({ text: "" });
  render();
});

document.getElementById("finishBtn").addEventListener("click", async () => {
  const {
    batch = [],
    folder,
    packHistory = [],
    queueStartedAt = null,
    introCaption = "",
    ctaCaption = ""
  } = await chrome.storage.local.get([
    "batch",
    "folder",
    "packHistory",
    "queueStartedAt",
    "introCaption",
    "ctaCaption"
  ]);
  if (!batch.length || !folder) return;

  // INTRO_CAPTION / CTA_CAPTION ride along untouched from the original
  // script so the video tool can drop them back into place — first and
  // last — without any manual re-entry.
  const manifest = {
    count: batch.length,
    INTRO_CAPTION: introCaption,
    items: batch,
    CTA_CAPTION: ctaCaption
  };
  const url = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(manifest, null, 2));
  chrome.downloads.download({ url, filename: folder + "/manifest.json", saveAs: false, conflictAction: "overwrite" });

  // Permanently log this finished pack — including how long it took — so the
  // lifetime total/history survives Reset, browser restarts, etc.
  const durationSec = queueStartedAt ? (Date.now() - queueStartedAt) / 1000 : null;
  packHistory.push({
    folder,
    count: batch.length,
    finishedAt: Date.now(),
    durationSec,
    _justFinished: true
  });

  await chrome.storage.local.set({ packHistory });
  await chrome.storage.local.remove([
    "batch",
    "folder",
    "folderCreatedAt",
    "queue",
    "queueIndex",
    "queueStartedAt",
    "introCaption",
    "ctaCaption"
  ]);
  chrome.action.setBadgeText({ text: "" });

  await render();

  // Little "swell" celebration on the just-finished entry + the running total.
  const newRow = document.querySelector("#historyList .hist-item.ppg-new");
  if (newRow) setTimeout(() => newRow.classList.remove("ppg-new"), 650);
  const totalEl = document.getElementById("historyTotal");
  totalEl.classList.add("ppg-new");
  setTimeout(() => totalEl.classList.remove("ppg-new"), 650);

  if (window.PPGFX) {
    window.PPGFX.confetti(1600);
    window.PPGFX.ping("big");
  }

  // Clear the one-shot flag so it doesn't re-animate on the next render().
  packHistory[packHistory.length - 1]._justFinished = false;
  await chrome.storage.local.set({ packHistory });
});

document.getElementById("historyList").addEventListener("click", async (e) => {
  const btn = e.target.closest(".hist-folder-btn");
  if (!btn) return;
  const folder = btn.dataset.folder;
  const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const results = await chrome.downloads.search({
    filenameRegex: escaped,
    limit: 1,
    orderBy: ["-startTime"]
  });
  if (results.length) {
    chrome.downloads.show(results[0].id);
  } else {
    alert("Couldn't find that pack's files (may have been moved or deleted).");
  }
});

document.getElementById("clearHistoryBtn").addEventListener("click", async () => {
  await chrome.storage.local.remove(["packHistory"]);
  render();
});

render();
