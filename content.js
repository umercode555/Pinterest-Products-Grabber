/* ---------------------------------------------------------------------
 * Pinterest Product Pack Grabber — content script
 *
 * IMPORTANT: the download button is NOT injected into Pinterest's own
 * pin/link elements. Pinterest attaches its own pointerdown/click
 * navigation handlers high up in its React tree, and those fire before
 * any listener placed on a button nested inside that tree — so a button
 * "on top of" the pin still triggers Pinterest's own navigation.
 *
 * Instead we use ONE floating button appended directly to <html>,
 * completely outside Pinterest's DOM subtree. It follows whatever
 * qualifying image the mouse is over (positioned via
 * getBoundingClientRect) and is shown/hidden on mousemove. Because it is
 * not a descendant of any Pinterest element, Pinterest's delegated
 * handlers never see clicks on it — clicking it can only ever trigger
 * OUR handler.
 * ------------------------------------------------------------------- */

function isCandidateImg(img) {
  if (!img) return false;
  const src = img.currentSrc || img.src || "";
  if (!/pinimg\.com/.test(src)) return false;
  const rect = img.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 120) return false; // skip avatars/icons
  return true;
}

// Pinterest overlays a transparent link/div on top of each pin's <img>, so
// the element under the cursor is often that overlay, not the image. Walk
// from the topmost element at the point to find the real <img>.
function findImageNear(target, x, y) {
  if (target && target.tagName === "IMG" && target.src) return target;

  const atPoint = document.elementFromPoint(x, y);
  if (atPoint && atPoint.tagName === "IMG" && atPoint.src) return atPoint;

  let el = target;
  for (let i = 0; i < 6 && el; i++) {
    const img = el.querySelector ? el.querySelector("img") : null;
    if (img && img.src) return img;
    el = el.parentElement;
  }
  return null;
}

// ---------- Floating button (lives outside Pinterest's DOM tree) ----------

const floatBtn = document.createElement("button");
floatBtn.type = "button";
floatBtn.id = "ppg-float-btn";
floatBtn.title = "Save HD image to Product Pack";
floatBtn.innerHTML =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>';

// Appended to <html> (documentElement), not <body> — Pinterest's app is
// mounted into a container div inside body, so this keeps the button a
// sibling of that container, outside its event-delegation subtree.
function mountFloatButton() {
  document.documentElement.appendChild(floatBtn);
}
if (document.documentElement) mountFloatButton();

let hoverImg = null;
let hideTimer = null;

function positionButtonOn(img) {
  const rect = img.getBoundingClientRect();
  floatBtn.style.left = Math.round(rect.left + 8) + "px";
  floatBtn.style.top = Math.round(rect.top + 8) + "px";
}

function showButtonFor(img) {
  hoverImg = img;
  clearTimeout(hideTimer);
  positionButtonOn(img);
  floatBtn.classList.add("ppg-visible");
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    floatBtn.classList.remove("ppg-visible");
    hoverImg = null;
  }, 250);
}

let lastMoveTs = 0;
function handleMouseMove(e) {
  const now = Date.now();
  if (now - lastMoveTs < 40) return; // light throttle
  lastMoveTs = now;

  // Moving onto the button itself: keep it shown, don't re-evaluate target.
  if (e.target === floatBtn || floatBtn.contains(e.target)) {
    clearTimeout(hideTimer);
    return;
  }

  const img = findImageNear(e.target, e.clientX, e.clientY);
  if (img && isCandidateImg(img)) {
    showButtonFor(img);
  } else {
    scheduleHide();
  }
}

document.addEventListener("mousemove", handleMouseMove, true);
floatBtn.addEventListener("mouseenter", () => clearTimeout(hideTimer));
floatBtn.addEventListener("mouseleave", scheduleHide);

// Keep the button glued to its image while scrolling.
function repositionIfVisible() {
  if (hoverImg && floatBtn.classList.contains("ppg-visible")) {
    if (!hoverImg.isConnected) {
      floatBtn.classList.remove("ppg-visible");
      hoverImg = null;
      return;
    }
    positionButtonOn(hoverImg);
  }
}
window.addEventListener("scroll", repositionIfVisible, true);
window.addEventListener("resize", repositionIfVisible);

floatBtn.addEventListener(
  "click",
  (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!hoverImg) return;
    const src = hoverImg.currentSrc || hoverImg.src;
    triggerDownload(src, floatBtn);
  },
  true
);

// ---------- Clipboard automation ----------

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}

function fallbackCopy(text) {
  return new Promise((resolve) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
    ta.remove();
    resolve();
  });
}

let toastTimer = null;
function showToast(message) {
  let toast = document.getElementById("ppg-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "ppg-toast";
    document.documentElement.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("ppg-toast-show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("ppg-toast-show"), 3500);
}

function handleResult(result) {
  if (!result || !result.ok) {
    if (result && result.error === "no-hd") {
      showToast("⚠ No HD version exists for this image — pick a different one");
    } else {
      const reason = result && result.error ? result.error : "unknown error";
      showToast("Download failed (" + reason + ") — try again");
    }
    return;
  }
  if (window.PPGFX) window.PPGFX.ping();

  if (result.done) {
    showToast('Saved "' + result.downloadedKeyword + '". Queue complete!');
    if (window.PPGFX) window.PPGFX.confetti(1800);
    if (result.milestone && window.PPGFX) setTimeout(() => window.PPGFX.milestoneToast(result.milestone), 500);
    return;
  }
  if (result.milestone && window.PPGFX) window.PPGFX.milestoneToast(result.milestone);
  if (result.nextKeyword) {
    copyToClipboard(result.nextKeyword);
    showToast('Saved "' + result.downloadedKeyword + '" → searching "' + result.nextKeyword + '"');
    maybeAutoSearchNext(result.nextKeyword);
  } else {
    showToast('Saved "' + result.downloadedKeyword + '" (' + result.filename + ")");
  }
}

// Auto-search: Pinterest's search URL is just /search/pins/?q=<term>. Once
// an image is saved, we navigate the current tab straight to the search
// for the next keyword — so the whole loop becomes: download → page lands
// on the next product's results → download → ... No manual re-searching.
// A short pause lets the toast/button animation register before the page
// unloads. Off-able from the popup (defaults to on).
function maybeAutoSearchNext(keyword) {
  chrome.storage.local.get(["autoSearchNext"], (s) => {
    const enabled = s.autoSearchNext !== false;
    if (!enabled) return;
    const url = "https://www.pinterest.com/search/pins/?q=" + encodeURIComponent(keyword);
    setTimeout(() => {
      window.location.href = url;
    }, 450);
  });
}

function triggerDownload(src, btn) {
  if (btn) {
    btn.classList.add("ppg-loading");
    btn.disabled = true;
  }
  chrome.runtime.sendMessage({ type: "DOWNLOAD_HD_IMAGE", src }, (result) => {
    if (btn) {
      btn.classList.remove("ppg-loading");
      btn.disabled = false;
      btn.classList.add("ppg-done");
      setTimeout(() => btn.classList.remove("ppg-done"), 1200);
    }
    handleResult(result);
  });
}

// ---------- Legacy right-click fallback ----------

document.addEventListener(
  "contextmenu",
  (e) => {
    const img = findImageNear(e.target, e.clientX, e.clientY);
    if (img) {
      const src = img.currentSrc || img.src;
      chrome.runtime.sendMessage({ type: "CONTEXT_IMAGE", src });
    }
  },
  true
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "DOWNLOAD_RESULT") {
    handleResult(msg.result);
  }
});
