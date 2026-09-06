const MENU_ID = "save-to-pack";

// ---------- Dopamine layer: lifetime image counter + milestone thresholds ----------
const PPG_MILESTONES = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000];
async function bumpTotalImagesAndCheckMilestone() {
  const s = await chrome.storage.local.get(["ppgTotalImages", "ppgMilestonesHit"]);
  const total = (s.ppgTotalImages || 0) + 1;
  const hit = s.ppgMilestonesHit || [];
  let milestone = null;
  if (PPG_MILESTONES.includes(total) && !hit.includes(total)) {
    milestone = total;
    hit.push(total);
  }
  await chrome.storage.local.set({ ppgTotalImages: total, ppgMilestonesHit: hit });
  return milestone;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Save to Product Pack (HD)",
      contexts: ["all"],
      documentUrlPatterns: ["*://*.pinterest.com/*"]
    });
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "CONTEXT_IMAGE" && msg.src) {
    chrome.storage.local.set({ lastContextImage: msg.src });
    return;
  }
  if (msg && msg.type === "DOWNLOAD_HD_IMAGE" && msg.src) {
    handleDownload(msg.src, msg.keyword).then(sendResponse);
    return true; // keep channel open for async response
  }
  if (msg && msg.type === "GET_QUEUE_STATE") {
    getQueueState().then(sendResponse);
    return true;
  }
  if (msg && msg.type === "FETCH_GRID_IMAGES" && Array.isArray(msg.keywords)) {
    fetchGridBatch(msg.keywords, msg.limit).then(sendResponse);
    return true;
  }
  if (msg && msg.type === "RESOLVE_HD_URL" && msg.src) {
    resolveHDUrl(msg.src).then((hdUrl) => sendResponse({ hdUrl })).catch(() => sendResponse({ hdUrl: null }));
    return true;
  }
  if (msg && msg.type === "DOWNLOAD_TO_BADGE" && msg.src && msg.badgeFolder) {
    handleBadgeDownload(msg.src, msg.keyword, msg.badgeFolder).then(sendResponse);
    return true;
  }
  if (msg && msg.type === "DELETE_BADGE" && msg.badgeFolder) {
    deleteBadge(msg.badgeFolder).then(sendResponse);
    return true;
  }
  if (msg && msg.type === "DELETE_ALL_BADGES") {
    deleteAllBadges().then(sendResponse);
    return true;
  }
  if (msg && msg.type === "GET_BADGES") {
    getBadges().then(sendResponse);
    return true;
  }
});

function getExt(url) {
  const m = url.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i);
  return m ? m[1].toLowerCase() : "jpg";
}

function sanitizeKeyword(kw) {
  return (
    kw.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40) || "item"
  );
}

// Pinterest CDN serves scaled copies under a size segment like /236x/, /474x/,
// /736x/, /1200x/ etc. NOT every pin actually has a file stored at
// /originals/ (some only exist up to a certain size, or the pin links out
// to a non-pinimg source). We only accept sizes that count as genuinely HD —
// if none of those exist, we refuse to download at all rather than quietly
// saving a small/blurry version and marking it as a success.
const HD_SIZE_CANDIDATES = ["originals", "1200x", "736x"];

async function urlExists(url) {
  try {
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// Returns a verified HD URL, or null if this image has no HD version
// available anywhere on Pinterest's CDN.
async function resolveHDUrl(rawSrc) {
  let path;
  try {
    path = new URL(rawSrc).pathname;
  } catch (e) {
    return null;
  }
  const match = path.match(/\/(\d+x\d*|originals)\//);
  if (!match) return null; // not a recognizable pinimg size path

  for (const size of HD_SIZE_CANDIDATES) {
    const candidate = rawSrc.replace(match[0], "/" + size + "/");
    if (await urlExists(candidate)) return candidate;
  }
  return null; // no HD size exists for this pin
}

function isNewCalendarDay(ts) {
  return new Date(ts).toDateString() !== new Date().toDateString();
}

// If yesterday's folder is still sitting in storage, archive it (instead of
// silently continuing to save into it) and clear the slate for a new pack.
async function rolloverStaleFolder(store) {
  let folder = store.folder;
  let batch = store.batch || [];
  const folderCreatedAt = store.folderCreatedAt || null;

  const stale = folder && folderCreatedAt && isNewCalendarDay(folderCreatedAt);
  if (!stale) return { folder, batch, rolled: false };

  if (batch.length) {
    const s = await chrome.storage.local.get(["packHistory"]);
    const packHistory = s.packHistory || [];
    packHistory.push({
      folder,
      count: batch.length,
      finishedAt: Date.now(),
      durationSec: null,
      incomplete: true
    });
    await chrome.storage.local.set({ packHistory });
  }
  return { folder: null, batch: [], rolled: true };
}

async function getQueueState() {
  const s = await chrome.storage.local.get(["queue", "queueIndex", "batch", "folder"]);
  const queue = s.queue || [];
  const queueIndex = s.queueIndex || 0;
  return {
    queue,
    queueIndex,
    current: queue[queueIndex] || null,
    next: queue[queueIndex + 1] || null,
    remaining: Math.max(queue.length - queueIndex, 0),
    batch: s.batch || [],
    folder: s.folder || null
  };
}

// Core download handler used by BOTH the floating button and the right-click
// fallback. Only commits to storage (batch/queue advance/badge) once the
// download is CONFIRMED to have actually saved a real file — a failed
// attempt leaves the queue untouched so the user can just click again.
async function handleDownload(rawSrc, explicitKeyword) {
  const store = await chrome.storage.local.get([
    "queue",
    "queueIndex",
    "batch",
    "folder",
    "folderCreatedAt",
    "lastKeyword",
    "packNumber"
  ]);
  const queue = store.queue || [];
  const queueIndex = store.queueIndex || 0;
  // Batch Grid passes its own keyword directly (no active queue involved) —
  // that always wins over whatever the queue happens to be pointing at.
  const keyword = explicitKeyword || queue[queueIndex] || store.lastKeyword || "unknown";

  const hdUrl = await resolveHDUrl(rawSrc);
  if (!hdUrl) {
    return { ok: false, error: "no-hd", filename: null };
  }

  // Never silently keep appending into a folder created on an earlier day —
  // that's what was mixing unrelated packs together.
  const rolled = await rolloverStaleFolder(store);
  let folder = rolled.folder;
  let batch = rolled.batch;
  let folderCreatedAt = store.folderCreatedAt || null;

  let packNumber = store.packNumber || 0;
  const isNewFolder = !folder;
  if (isNewFolder) {
    packNumber = packNumber + 1;
    folder = "Pack " + packNumber;
    folderCreatedAt = Date.now();
  }

  const index = batch.length + 1;
  const filename = String(index).padStart(2, "0") + "." + getExt(hdUrl);
  const path = folder + "/" + filename;

  const downloadId = await new Promise((resolve) => {
    chrome.downloads.download(
      { url: hdUrl, filename: path, saveAs: false, conflictAction: "overwrite" },
      (id) => resolve(id)
    );
  });

  if (!downloadId) {
    return { ok: false, error: "Could not start download", filename };
  }

  // Not waiting for the download to fully finish — that added several
  // seconds of visible spinner per image. The HD-existence check above
  // (HEAD request) already guarantees this URL is a real, valid file, so
  // it's safe to advance the queue as soon as the download has STARTED.
  batch.push({ file: filename, keyword, url: hdUrl, ts: Date.now() });

  // A Batch Grid save is a one-off outside the queue flow — it must not
  // silently advance an unrelated queue that happens to be active.
  const advancesQueue = !explicitKeyword && queue.length > 0;
  const nextIndex = advancesQueue ? queueIndex + 1 : queueIndex;
  const nextKeyword = advancesQueue ? queue[nextIndex] || null : null;
  const done = advancesQueue && nextIndex >= queue.length;

  const toSave = { batch, folder, folderCreatedAt, queueIndex: nextIndex };
  if (isNewFolder) toSave.packNumber = packNumber;
  await chrome.storage.local.set(toSave);

  chrome.action.setBadgeText({ text: String(batch.length) });
  chrome.action.setBadgeBackgroundColor({ color: "#6b21d8" });

  const milestone = await bumpTotalImagesAndCheckMilestone();

  return {
    ok: true,
    downloadedKeyword: keyword,
    filename,
    nextKeyword,
    remaining: Math.max(queue.length - nextIndex, 0),
    done,
    milestone
  };
}

// ---------- Batch Grid: fetch top images per keyword, no page loads ----------

// Matches any i.pinimg.com image URL regardless of size folder, stopping at
// the closing quote/backslash that always terminates it in the page's raw
// HTML/JSON — deliberately loose since Pinterest's markup shifts over time.
// Real pin images always sit under a size folder then a 3-level hex hash
// path (e.g. /736x/aa/bb/cc/hash.jpg). Avatars, favicons, and other UI
// images use different path shapes — this pattern excludes them instead
// of grabbing every i.pinimg.com URL indiscriminately.
const PINIMG_URL_RE = /https:\/\/i\.pinimg\.com\/(?:\d+x\d*|originals)\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]+\.(?:jpg|jpeg|png|webp)/gi;

// Two different pin URLs can point at the same underlying image at
// different CDN sizes — collapse those so we don't show duplicates.
function pinKey(url) {
  return url.replace(/\/(?:\d+x\d*|originals)\//, "/SIZE/");
}

function extractTopImages(html, limit) {
  const matches = html.match(PINIMG_URL_RE) || [];
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const key = pinKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

async function searchPinterestImages(keyword, limit) {
  // Appending "Aesthetic" consistently surfaces better-styled product shots.
  const url = "https://www.pinterest.com/search/pins/?q=" + encodeURIComponent(keyword + " Aesthetic");
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return { keyword, images: [] };
    const html = await res.text();
    return { keyword, images: extractTopImages(html, limit) };
  } catch (e) {
    return { keyword, images: [] };
  }
}

// Sequential, not Promise.all — hammering Pinterest with parallel search
// requests at once is more likely to trip rate limiting than one at a time.
async function fetchGridBatch(keywords, limit) {
  const results = [];
  const n = limit || 8;
  for (const kw of keywords) {
    results.push(await searchPinterestImages(kw, n));
  }
  return results;
}

// ---------- Batch Grid: per-Badge downloads (independent of the Pack/queue
// system used by the popup) ----------
async function handleBadgeDownload(rawSrc, keyword, badgeFolder) {
  const hdUrl = await resolveHDUrl(rawSrc);
  if (!hdUrl) {
    return { ok: false, error: "no-hd", filename: null };
  }

  const STORE_KEY = "gridBatches";
  const store = await chrome.storage.local.get([STORE_KEY]);
  const gridBatches = store[STORE_KEY] || {};
  const list = gridBatches[badgeFolder] || [];

  const index = list.length + 1;
  const filename = String(index).padStart(2, "0") + "." + getExt(hdUrl);
  const path = badgeFolder + "/" + filename;

  const downloadId = await new Promise((resolve) => {
    chrome.downloads.download(
      { url: hdUrl, filename: path, saveAs: false, conflictAction: "overwrite" },
      (id) => resolve(id)
    );
  });
  if (!downloadId) {
    return { ok: false, error: "Could not start download", filename };
  }

  list.push({ file: filename, keyword, url: hdUrl, ts: Date.now() });
  gridBatches[badgeFolder] = list;
  await chrome.storage.local.set({ [STORE_KEY]: gridBatches });

  const milestone = await bumpTotalImagesAndCheckMilestone();

  return { ok: true, downloadedKeyword: keyword, filename, folder: badgeFolder, milestone };
}

// ---------- Batch Grid: badge management (delete one / delete all) ----------
// Only ever touches the "gridBatches" key — never queue/batch/packHistory/
// ppgNextBadge/ppgGridState, so deleting badges can't affect anything else.
async function getBadges() {
  const STORE_KEY = "gridBatches";
  const store = await chrome.storage.local.get([STORE_KEY]);
  return store[STORE_KEY] || {};
}

async function deleteBadge(badgeFolder) {
  const STORE_KEY = "gridBatches";
  const store = await chrome.storage.local.get([STORE_KEY]);
  const gridBatches = store[STORE_KEY] || {};
  delete gridBatches[badgeFolder];
  await chrome.storage.local.set({ [STORE_KEY]: gridBatches });
  return { ok: true, badges: gridBatches };
}

async function deleteAllBadges() {
  const STORE_KEY = "gridBatches";
  await chrome.storage.local.set({ [STORE_KEY]: {} });
  return { ok: true, badges: {} };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const store = await chrome.storage.local.get(["lastContextImage"]);
  const imageUrl = info.srcUrl || store.lastContextImage;
  if (!imageUrl) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#999" });
    return;
  }
  const result = await handleDownload(imageUrl);
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "DOWNLOAD_RESULT", result }).catch(() => {});
  }
});
