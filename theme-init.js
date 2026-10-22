/* =========================
   Theme (light / dark) toggle and sky accent

   Loaded synchronously from <head> so the saved/preferred theme and the sky
   accent are applied before first paint, which avoids a flash of the wrong
   colors. It also wires up any [data-theme-toggle] controls once the DOM is
   ready, so the same file can be shared across pages without per-page glue
   code.
========================= */

(function () {
  "use strict";

  var STORAGE_KEY = "theme";
  var root = document.documentElement;
  var mql =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;

  // Set when the user toggles the theme, so an explicit choice is honored even
  // if the localStorage write fails (private mode, quota, storage blocked).
  var userChoseTheme = false;

  function storedTheme() {
    try {
      var value = localStorage.getItem(STORAGE_KEY);
      return value === "light" || value === "dark" ? value : null;
    } catch (err) {
      return null;
    }
  }

  function systemTheme() {
    return mql && mql.matches ? "dark" : "light";
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme;
  }

  // Apply as early as possible (this script runs in <head>, before <body>).
  applyTheme(storedTheme() || systemTheme());

  function currentTheme() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function updateToggle(toggle, theme) {
    var isDark = theme === "dark";
    var label = isDark ? "Switch to light mode" : "Switch to dark mode";
    toggle.setAttribute("aria-pressed", String(isDark));
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
  }

  function updateToggles(theme) {
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < toggles.length; i++) {
      updateToggle(toggles[i], theme);
    }
  }

  // The theme is applied to <html> in <head> before the toggle exists, so its
  // static markup can misreport the theme to assistive tech until init() runs.
  // Watch for the toggle being parsed and sync it as soon as it appears.
  if (typeof MutationObserver === "function" && document.readyState === "loading") {
    var earlyObserver = new MutationObserver(function () {
      var toggles = document.querySelectorAll("[data-theme-toggle]");
      if (!toggles.length) return;
      for (var i = 0; i < toggles.length; i++) {
        updateToggle(toggles[i], currentTheme());
      }
    });
    earlyObserver.observe(root, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", function () {
      earlyObserver.disconnect();
    });
  }

  function setTheme(theme) {
    userChoseTheme = true;
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (err) {
      /* storage unavailable (private mode, etc.) — theme still applies */
    }
    updateToggles(theme);
  }

  function init() {
    updateToggles(currentTheme());

    var toggles = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < toggles.length; i++) {
      toggles[i].addEventListener("click", function () {
        setTheme(currentTheme() === "dark" ? "light" : "dark");
      });
    }

    // Follow OS changes until the user makes an explicit choice (stored, or
    // in-memory when the storage write failed).
    if (mql) {
      var onSystemChange = function (event) {
        if (storedTheme() || userChoseTheme) return;
        applyTheme(event.matches ? "dark" : "light");
        updateToggles(currentTheme());
      };
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onSystemChange);
      } else if (typeof mql.addListener === "function") {
        mql.addListener(onSystemChange);
      }
    }

    // When restored from the back/forward cache, the theme applied in <head>
    // never re-runs, so a choice made on another page (e.g. resume) can be
    // stale. Re-read the current choice on pageshow and re-apply it.
    window.addEventListener("pageshow", function () {
      var theme =
        storedTheme() || (userChoseTheme ? currentTheme() : systemTheme());
      applyTheme(theme);
      updateToggles(theme);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

/* =========================
   Sky accent

   The accent color follows the sun over San Francisco. The sun's elevation
   is computed locally (no network requests, no visitor location) and mapped
   onto a small palette, which is written to CSS custom properties on <html>.
   Preview other times with ?sky=night|blue|dawn|afterglow|sunrise|golden|
   morning|afternoon|day, or an elevation in degrees such as ?sky=-3.
========================= */

(function () {
  "use strict";

  var LAT = 37.7749;
  var LON = -122.4194;
  var RAD = Math.PI / 180;
  var MINUTE = 60000;
  var HORIZON = -0.833; // sun's upper limb on the horizon, with refraction
  var root = document.documentElement;

  // Elevation of the sun's center in degrees, good to about half a degree.
  function sunElevation(ms) {
    var d = ms / 86400000 - 10957.5; // days since J2000.0
    var g = (357.529 + 0.98560028 * d) * RAD;
    var q = 280.459 + 0.98564736 * d;
    var lambda = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
    var eps = (23.439 - 0.00000036 * d) * RAD;
    var ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
    var dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
    var gmst = 280.46061837 + 360.98564736629 * d;
    var hourAngle = (gmst + LON) * RAD - ra;
    var lat = LAT * RAD;
    return (
      Math.asin(
        Math.sin(lat) * Math.sin(dec) +
          Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle)
      ) / RAD
    );
  }

  function nextCrossing(fromMs, rising) {
    var step = 4 * MINUTE;
    var prev = sunElevation(fromMs) - HORIZON;
    for (var t = fromMs + step; t <= fromMs + 26 * 60 * MINUTE; t += step) {
      var cur = sunElevation(t) - HORIZON;
      if (rising ? prev < 0 && cur >= 0 : prev > 0 && cur <= 0) {
        var lo = t - step;
        var hi = t;
        while (hi - lo > MINUTE / 2) {
          var mid = (lo + hi) / 2;
          var m = sunElevation(mid) - HORIZON;
          if (rising ? m < 0 : m > 0) lo = mid;
          else hi = mid;
        }
        return hi;
      }
      prev = cur;
    }
    return null;
  }

  // [elevation, zenith, horizon, sun, accent, accent 2, star opacity]
  var KEYS = [
    [-18, "#0b1025", "#1a2446", "#e9ecf5", "#8193e0", "#b6a8f2", 1],
    [-10, "#121c4a", "#33417f", "#a9b8ea", "#6d87f0", "#a98ff2", 0.75],
    [-4, "#272a63", "#c86f8f", "#ffae7d", "#ee7b98", "#ffb27f", 0.2],
    [1, "#35437d", "#ef8f5f", "#ffc46f", "#f2884f", "#ffc46f", 0],
    [6, "#6c8fca", "#f4bf8a", "#ffd98c", "#f39a4c", "#ffd27a", 0],
    [15, "#6ea2dc", "#d6e6f2", "#fff0c4", "#3f8ee0", "#7cc2f2", 0],
    [35, "#5d9ce0", "#c2ddf4", "#fffbe8", "#2f86e0", "#6fc3f5", 0]
  ];

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(rgb) {
    return (
      "#" +
      rgb
        .map(function (v) {
          var h = Math.round(Math.max(0, Math.min(255, v))).toString(16);
          return h.length === 1 ? "0" + h : h;
        })
        .join("")
    );
  }

  function mix(a, b, t) {
    var x = hexToRgb(a);
    var y = hexToRgb(b);
    return rgbToHex([0, 1, 2].map(function (i) {
      return x[i] + (y[i] - x[i]) * t;
    }));
  }

  function luminance(hex) {
    var c = hexToRgb(hex).map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function contrast(a, b) {
    var la = luminance(a);
    var lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  var LIGHT_INK = "#ffffff";
  var DARK_INK = "#121211";

  // Text on the sky tile sits over the zenith color, so pick the better ink
  // and nudge the zenith until that pairing clears WCAG AA (4.5:1).
  function readable(zenith) {
    var useLight = contrast(zenith, LIGHT_INK) >= contrast(zenith, DARK_INK);
    var ink = useLight ? LIGHT_INK : DARK_INK;
    var away = useLight ? "#000000" : "#ffffff";
    var bg = zenith;
    for (var i = 0; i < 24 && contrast(bg, ink) < 4.6; i++) bg = mix(bg, away, 0.06);
    return { zenith: bg, ink: ink, tone: useLight ? "dark" : "light" };
  }

  function paletteAt(elevation) {
    var last = KEYS.length - 1;
    var e = Math.max(KEYS[0][0], Math.min(KEYS[last][0], elevation));
    var i = 0;
    while (i < last - 1 && e > KEYS[i + 1][0]) i++;
    var a = KEYS[i];
    var b = KEYS[i + 1];
    var t = (e - a[0]) / (b[0] - a[0]);
    return {
      zenith: mix(a[1], b[1], t),
      horizon: mix(a[2], b[2], t),
      sun: mix(a[3], b[3], t),
      accent: mix(a[4], b[4], t),
      accent2: mix(a[5], b[5], t),
      stars: a[6] + (b[6] - a[6]) * t
    };
  }

  function phaseOf(elevation, rising) {
    if (elevation < -12) return "night";
    if (elevation < -6) return "blue";
    if (elevation < HORIZON) return rising ? "dawn" : "afterglow";
    if (elevation < 6) return rising ? "sunrise" : "golden";
    return rising ? "morning" : "afternoon";
  }

  var PREVIEWS = {
    night: [-20, false],
    blue: [-9, false],
    dawn: [-3, true],
    afterglow: [-3, false],
    sunrise: [2, true],
    golden: [3, false],
    morning: [20, true],
    afternoon: [20, false],
    day: [40, false]
  };

  function readPreview() {
    var match = /[?&]sky=([^&#]+)/.exec(window.location.search);
    if (!match) return null;
    var value = decodeURIComponent(match[1]).toLowerCase();
    if (PREVIEWS[value]) return { elevation: PREVIEWS[value][0], rising: PREVIEWS[value][1] };
    var n = parseFloat(value);
    return isFinite(n) ? { elevation: Math.max(-30, Math.min(70, n)), rising: false } : null;
  }

  var preview = readPreview();

  function compute(now) {
    var elevation = preview ? preview.elevation : sunElevation(now);
    var rising = preview ? preview.rising : sunElevation(now + 10 * MINUTE) > elevation;
    var palette = paletteAt(elevation);
    var tile = readable(palette.zenith);
    return {
      now: now,
      preview: !!preview,
      elevation: elevation,
      rising: rising,
      phase: phaseOf(elevation, rising),
      zenith: tile.zenith,
      horizon: palette.horizon,
      sun: palette.sun,
      accent: palette.accent,
      accent2: palette.accent2,
      stars: palette.stars,
      ink: tile.ink,
      tone: tile.tone,
      sunY: Math.max(-12, Math.min(8, -elevation * 0.42)),
      nextSunrise: nextCrossing(now, true),
      nextSunset: nextCrossing(now, false)
    };
  }

  function apply(state) {
    var style = root.style;
    style.setProperty("--sky-zenith", state.zenith);
    style.setProperty("--sky-horizon", state.horizon);
    style.setProperty("--sky-sun", state.sun);
    style.setProperty("--sky-accent", state.accent);
    style.setProperty("--sky-accent-2", state.accent2);
    style.setProperty("--sky-ink", state.ink);
    style.setProperty("--sky-stars", state.stars.toFixed(2));
    style.setProperty("--sun-y", state.sunY.toFixed(2) + "px");
    root.setAttribute("data-sky-phase", state.phase);
    root.setAttribute("data-sky-tone", state.tone);
  }

  function update() {
    var state = compute(Date.now());
    apply(state);
    window.siteSky.state = state;
    return state;
  }

  window.siteSky = { state: null, update: update, sunElevation: sunElevation };

  try {
    update();
  } catch (err) {
    /* the static palette in styles.css stays in place */
  }
})();
