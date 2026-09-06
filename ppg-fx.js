/* ---------------------------------------------------------------------
 * PPGFX — shared "dopamine layer": theme, sound, confetti, toasts,
 * milestone popups, end-of-day summary modal. Pure DOM/WebAudio, no
 * external assets or network calls, safe for extension pages AND
 * Pinterest content-script context alike.
 * ------------------------------------------------------------------- */
(function () {
  const root = document.documentElement;

  // ---------- Icon set (stroke-style, currentColor, glow via CSS on hover) ----------
  const ICONS = {
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5Z"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/></svg>',
    flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h13l-3 4 3 4H5"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v4a4 4 0 0 1-8 0V4Z"/><path d="M8 5H5a3 3 0 0 0 3 4M16 5h3a3 3 0 0 1-3 4"/><path d="M12 12v4M9 20h6M9.5 20a2.5 2.5 0 0 1 5 0"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M20 15.5 15 10l-4.5 5-2-1.6L4 17"/></svg>',
    checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.3l2.4 2.4 5-5.2"/></svg>',
    package: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z"/><path d="M4 7l8 4 8-4M12 11v10"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M4 20h16"/></svg>'
  };

  // ---------- Theme ----------
  function applyTheme(theme) {
    root.setAttribute("data-ppg-theme", theme === "dark" ? "dark" : "light");
    document.querySelectorAll(".ppg-theme-btn").forEach((btn) => {
      btn.innerHTML = theme === "dark" ? ICONS.sun : ICONS.moon;
      btn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    });
  }

  function loadTheme() {
    chrome.storage.local.get(["ppgTheme"], (s) => applyTheme(s.ppgTheme || "light"));
  }

  function toggleTheme() {
    const current = root.getAttribute("data-ppg-theme") === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    chrome.storage.local.set({ ppgTheme: next });
  }

  function wireThemeButtons() {
    document.querySelectorAll(".ppg-theme-btn").forEach((btn) => {
      if (btn.dataset.ppgWired) return;
      btn.dataset.ppgWired = "1";
      btn.addEventListener("click", toggleTheme);
    });
  }

  loadTheme();
  document.addEventListener("DOMContentLoaded", wireThemeButtons);
  wireThemeButtons();

  // ---------- Sound ping (Web Audio, no asset files) ----------
  let audioCtx = null;
  function ping(kind) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime;
      const notes = kind === "big" ? [523.25, 659.25, 783.99] : [880];
      notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const start = t0 + i * 0.09;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.16, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(start);
        osc.stop(start + 0.24);
      });
    } catch (e) {
      /* audio not available (e.g. autoplay-blocked) — fail silently */
    }
  }

  // ---------- Confetti (lightweight canvas burst) ----------
  function confetti(durationMs) {
    durationMs = durationMs || 1300;
    let canvas = document.getElementById("ppgFxConfettiCanvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.id = "ppgFxConfettiCanvas";
      document.documentElement.appendChild(canvas);
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const colors = ["#8b3ff5", "#6b21d8", "#f5b942", "#22a745", "#ff5c8a", "#3fb6f5"];
    const count = 140;
    const particles = Array.from({ length: count }, () => ({
      x: window.innerWidth / 2 + (Math.random() - 0.5) * 120,
      y: window.innerHeight * 0.35 + (Math.random() - 0.5) * 40,
      vx: (Math.random() - 0.5) * 11,
      vy: Math.random() * -9 - 4,
      size: Math.random() * 6 + 4,
      color: colors[(Math.random() * colors.length) | 0],
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.3,
      shape: Math.random() < 0.5 ? "rect" : "circle"
    }));

    const gravity = 0.28;
    const start = performance.now();

    function frame(now) {
      const elapsed = now - start;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      particles.forEach((p) => {
        p.vy += gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.shape === "rect") {
          ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      });
      if (elapsed < durationMs) {
        requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------- Toast (small, top-right, stacking) ----------
  function toast(message, iconSvg) {
    let layer = document.getElementById("ppgFxToastLayer");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "ppgFxToastLayer";
      document.documentElement.appendChild(layer);
    }
    const el = document.createElement("div");
    el.className = "ppg-fx-toast";
    el.innerHTML = `<span class="ppg-fx-emoji">${iconSvg || ICONS.sparkle}</span><span>${message}</span>`;
    layer.appendChild(el);
    requestAnimationFrame(() => el.classList.add("ppg-fx-in"));
    setTimeout(() => {
      el.classList.remove("ppg-fx-in");
      setTimeout(() => el.remove(), 350);
    }, 3200);
  }

  // ---------- Milestone popup (big celebratory center card) ----------
  function milestoneToast(total) {
    let layer = document.getElementById("ppgFxMilestoneLayer");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "ppgFxMilestoneLayer";
      layer.innerHTML =
        '<div class="ppg-fx-milestone-card">' +
        '<div class="ppg-fx-big">' + ICONS.trophy + '</div>' +
        '<div class="ppg-fx-num"></div>' +
        '<div class="ppg-fx-sub">images saved — keep going!</div>' +
        "<button>Nice!</button>" +
        "</div>";
      document.documentElement.appendChild(layer);
      layer.querySelector("button").addEventListener("click", () => layer.classList.remove("ppg-fx-show"));
      layer.addEventListener("click", (e) => {
        if (e.target === layer) layer.classList.remove("ppg-fx-show");
      });
    }
    layer.querySelector(".ppg-fx-num").textContent = total.toLocaleString();
    layer.classList.add("ppg-fx-show");
    confetti(1800);
    ping("big");
  }

  // ---------- End-of-day summary modal ----------
  // data: { images, scripts, packs, minutes }
  function showSummaryModal(data) {
    let layer = document.getElementById("ppgFxSummaryLayer");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "ppgFxSummaryLayer";
      document.documentElement.appendChild(layer);
      layer.addEventListener("click", (e) => {
        if (e.target === layer) layer.classList.remove("ppg-fx-show");
      });
    }
    const dateStr = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    layer.innerHTML = `
      <div class="ppg-fx-summary-card">
        <div class="ppg-fx-summary-title">Today's Summary</div>
        <div class="ppg-fx-summary-date">${dateStr}</div>
        <div class="ppg-fx-summary-row"><span class="ppg-fx-summary-label">${ICONS.image} Images saved</span><span class="ppg-fx-summary-val">${data.images}</span></div>
        <div class="ppg-fx-summary-row"><span class="ppg-fx-summary-label">${ICONS.checkCircle} Scripts done</span><span class="ppg-fx-summary-val">${data.scripts}</span></div>
        <div class="ppg-fx-summary-row"><span class="ppg-fx-summary-label">${ICONS.package} Packs/badges touched</span><span class="ppg-fx-summary-val">${data.packs}</span></div>
        <div class="ppg-fx-summary-row"><span class="ppg-fx-summary-label">${ICONS.clock} Time on the clock</span><span class="ppg-fx-summary-val">${data.minutes}</span></div>
        <button class="ppg-fx-summary-close">Nice work \u2014 close</button>
      </div>`;
    layer.querySelector(".ppg-fx-summary-close").addEventListener("click", () => layer.classList.remove("ppg-fx-show"));
    layer.classList.add("ppg-fx-show");
  }

  window.PPGFX = { ping, confetti, toast, milestoneToast, showSummaryModal, toggleTheme, icons: ICONS };
})();
