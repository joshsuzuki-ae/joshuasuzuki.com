(() => {
  "use strict";

  const SF = { lat: 37.7749, lon: -122.4194 };
  const TZ = "America/Los_Angeles";
  const RING_RADIUS = 210;
  const RING_GAP = 28;
  const BASE_FONT_SIZE = 17;
  const IDLE_SPEED = 4; // degrees per second
  const RETURN_DELAY = 6000;
  const MAX_OFFSET = 12 * 3600e3;
  const MINUTE = 60e3;

  const root = document.documentElement;
  const orbit = document.querySelector("[data-orbit]");
  const ring = document.querySelector("[data-ring]");
  const ringText = document.querySelector("[data-ring-text]");
  const textPath = ringText.querySelector("textPath");
  const stars = document.querySelector("[data-stars]");
  const caption = document.querySelector("[data-caption]");
  const hint = document.querySelector(".hint");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const coarsePointer = window.matchMedia("(pointer: coarse)");
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

  // Sky colors keyed by solar altitude (degrees). Values between stops are interpolated.
  const PALETTE = [
    { alt: -18, sun: [40, 50, 100], halo: [40, 60, 140, 0], sky: [40, 60, 150, 0.16], ambient: [30, 45, 120, 0.1], glint: [130, 150, 230] },
    { alt: -8, sun: [130, 70, 150], halo: [120, 60, 160, 0.1], sky: [90, 55, 150, 0.32], ambient: [70, 40, 130, 0.1], glint: [170, 130, 230] },
    { alt: -2, sun: [255, 90, 95], halo: [255, 80, 95, 0.25], sky: [255, 95, 115, 0.5], ambient: [200, 70, 115, 0.12], glint: [255, 125, 135] },
    { alt: 3, sun: [255, 112, 52], halo: [255, 100, 50, 0.45], sky: [255, 122, 62, 0.55], ambient: [255, 110, 60, 0.12], glint: [255, 155, 95] },
    { alt: 12, sun: [255, 184, 96], halo: [255, 152, 72, 0.4], sky: [255, 172, 92, 0.4], ambient: [255, 150, 80, 0.09], glint: [255, 205, 145] },
    { alt: 30, sun: [255, 242, 214], halo: [255, 222, 172, 0.3], sky: [255, 232, 194, 0.22], ambient: [255, 226, 192, 0.06], glint: [255, 242, 222] },
  ];

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const toRad = (deg) => (deg * Math.PI) / 180;
  const wrap180 = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

  // NOAA solar position approximation; accurate to well under a degree.
  function solarPosition(date) {
    const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
    const dayOfYear = Math.floor((date.getTime() - yearStart) / 864e5) + 1;
    const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const g = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hours - 12) / 24);
    const eqTime =
      229.18 *
      (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl =
      0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
      0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const solarMinutes = (((hours * 60 + eqTime + 4 * SF.lon) % 1440) + 1440) % 1440;
    const hourAngle = solarMinutes / 4 - 180;
    const lat = toRad(SF.lat);
    const cosZenith = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(toRad(hourAngle));
    const altitude = 90 - (Math.acos(clamp(cosZenith, -1, 1)) * 180) / Math.PI;
    return { altitude, hourAngle };
  }

  function paletteAt(alt) {
    const a = clamp(alt, PALETTE[0].alt, PALETTE[PALETTE.length - 1].alt);
    let i = 0;
    while (i < PALETTE.length - 2 && a > PALETTE[i + 1].alt) i++;
    const lo = PALETTE[i];
    const hi = PALETTE[i + 1];
    const t = (a - lo.alt) / (hi.alt - lo.alt);
    const mix = (key) => lo[key].map((v, k) => lerp(v, hi[key][k], t));
    return { sun: mix("sun"), halo: mix("halo"), sky: mix("sky"), ambient: mix("ambient"), glint: mix("glint") };
  }

  const rgb = (c) => `rgb(${c.map((v) => Math.round(v)).join(", ")})`;
  const rgba = (c) => `rgba(${c.slice(0, 3).map((v) => Math.round(v)).join(", ")}, ${c[3].toFixed(3)})`;

  function phaseName(alt) {
    if (alt >= 8) return "daylight";
    if (alt >= 0) return "golden hour";
    if (alt >= -6) return "afterglow";
    if (alt >= -12) return "blue hour";
    return "night";
  }

  const written = {};
  function setVar(name, value) {
    if (written[name] === value) return;
    written[name] = value;
    root.style.setProperty(name, value);
  }

  function renderSky(date, live) {
    const { altitude, hourAngle } = solarPosition(date);
    const colors = paletteAt(altitude);
    const horizon = 62;

    setVar("--sun-x", `${(50 + clamp(hourAngle / 120, -1, 1) * 30).toFixed(2)}%`);
    setVar("--sun-y", `${clamp(horizon - altitude, 6, 96).toFixed(2)}%`);
    setVar("--sun", rgb(colors.sun));
    setVar("--sun-halo", rgba(colors.halo));
    setVar("--sky", rgba(colors.sky));
    setVar("--ambient", rgba(colors.ambient));
    setVar("--glint", rgb(colors.glint));
    setVar("--accent", rgb(colors.glint));
    setVar("--glint-a", (smoothstep(-3, 1, altitude) * (1 - smoothstep(25, 45, altitude)) * 0.55).toFixed(3));
    setVar("--stars-a", smoothstep(-4, -12, altitude).toFixed(3));

    const text = `${live ? "live · " : ""}san francisco · ${clock.format(date).toLowerCase()} · ${phaseName(altitude)}`;
    if (caption.textContent !== text) caption.textContent = text;
  }

  function fitRing() {
    const target = 2 * Math.PI * RING_RADIUS - RING_GAP;
    ringText.style.letterSpacing = "0px";
    ringText.style.fontSize = `${BASE_FONT_SIZE}px`;
    const natural = textPath.getComputedTextLength();
    if (!natural) return;
    const size = BASE_FONT_SIZE * Math.min(1.2, (target * 0.97) / natural);
    ringText.style.fontSize = `${size.toFixed(2)}px`;
    const glyphs = textPath.textContent.length;
    const spacing = (target - textPath.getComputedTextLength()) / glyphs;
    ringText.style.letterSpacing = `${spacing.toFixed(3)}px`;
  }

  function scatterStars() {
    let seed = 20171999;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const shadows = [];
    for (let i = 0; i < 110; i++) {
      const x = (random() * 100).toFixed(2);
      const y = (random() * 100).toFixed(2);
      const spread = random() < 0.15 ? 0.6 : 0;
      const alpha = (0.25 + random() * 0.6).toFixed(2);
      shadows.push(`${x}vw ${y}vh 0 ${spread}px rgba(255, 255, 255, ${alpha})`);
    }
    stars.style.boxShadow = shadows.join(", ");
  }

  // `?at=19:30` previews the sky at that San Francisco time today.
  function previewOffset() {
    const match = /^(\d{1,2}):(\d{2})$/.exec(new URLSearchParams(window.location.search).get("at") || "");
    if (!match) return 0;
    const now = new Date();
    const parts = {};
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", timeZoneName: "shortOffset" })
      .formatToParts(now)
      .forEach((p) => { parts[p.type] = p.value; });
    const zone = /GMT([+-]\d+)(?::(\d+))?/.exec(parts.timeZoneName || "");
    const offsetHours = zone ? Number(zone[1]) : -8;
    const offsetMinutes = offsetHours * 60 + Math.sign(offsetHours || 1) * Number((zone && zone[2]) || 0);
    const target =
      Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(match[1]), Number(match[2])) -
      offsetMinutes * MINUTE;
    return target - now.getTime();
  }

  const baseOffset = previewOffset();
  let scrubOffset = 0;
  let lastInteraction = 0;

  function scrub(deltaMs) {
    scrubOffset = clamp(scrubOffset + deltaMs, -MAX_OFFSET, MAX_OFFSET);
    lastInteraction = performance.now();
  }

  let angle = 0;
  let velocity = IDLE_SPEED;
  let hoveringLink = false;
  let drag = null;
  let scrubDrag = null;
  let suppressClick = false;

  function pointerAngle(event) {
    const box = orbit.getBoundingClientRect();
    return (Math.atan2(event.clientY - (box.top + box.height / 2), event.clientX - (box.left + box.width / 2)) * 180) / Math.PI;
  }

  orbit.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = { pointerId: event.pointerId, last: pointerAngle(event), time: event.timeStamp, travel: 0, captured: false };
  });

  window.addEventListener("pointermove", (event) => {
    if (drag && event.pointerId === drag.pointerId) {
      const current = pointerAngle(event);
      const delta = wrap180(current - drag.last);
      const dt = Math.max(1, event.timeStamp - drag.time) / 1000;
      drag.travel += Math.abs(delta);
      // Capture only once it's clearly a drag, so a plain tap still reaches the link underneath.
      if (!drag.captured && drag.travel > 3) {
        drag.captured = true;
        orbit.setPointerCapture(event.pointerId);
        orbit.classList.add("is-dragging");
      }
      if (drag.captured) {
        angle += delta;
        velocity = lerp(velocity, delta / dt, 0.5);
      }
      drag.last = current;
      drag.time = event.timeStamp;
    } else if (scrubDrag && event.pointerId === scrubDrag.pointerId) {
      scrub((event.clientY - scrubDrag.y) * 2 * MINUTE);
      scrubDrag.y = event.clientY;
    }
  });

  function endDrag(event) {
    if (drag && event.pointerId === drag.pointerId) {
      suppressClick = drag.captured;
      orbit.classList.remove("is-dragging");
      drag = null;
    }
    if (scrubDrag && event.pointerId === scrubDrag.pointerId) scrubDrag = null;
  }
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  orbit.addEventListener(
    "click",
    (event) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );

  ring.querySelectorAll("a").forEach((link) => {
    link.addEventListener("pointerenter", () => { hoveringLink = true; });
    link.addEventListener("pointerleave", () => { hoveringLink = false; });
    link.addEventListener("focus", () => { hoveringLink = true; });
    link.addEventListener("blur", () => { hoveringLink = false; });
  });

  document.addEventListener("pointerdown", (event) => {
    if (orbit.contains(event.target) || event.button !== 0) return;
    scrubDrag = { pointerId: event.pointerId, y: event.clientY };
  });

  window.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      scrub(pixels * 0.4 * MINUTE);
    },
    { passive: false }
  );

  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") scrub(15 * MINUTE);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") scrub(-15 * MINUTE);
    else if (event.key === "Escape" || event.key === "n") scrubOffset = 0;
    else return;
    event.preventDefault();
  });

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (!drag || !drag.captured) {
      const target = hoveringLink || reduceMotion.matches ? 0 : IDLE_SPEED;
      velocity = lerp(velocity, target, 1 - Math.exp(-dt * 1.2));
      angle += velocity * dt;
    }
    ring.style.transform = `rotate(${(angle % 360).toFixed(3)}deg)`;

    if (scrubOffset !== 0 && !scrubDrag && now - lastInteraction > RETURN_DELAY) {
      scrubOffset = reduceMotion.matches ? 0 : scrubOffset * Math.exp(-dt * 2.2);
      if (Math.abs(scrubOffset) < 30e3) scrubOffset = 0;
    }

    renderSky(new Date(Date.now() + baseOffset + scrubOffset), baseOffset === 0 && scrubOffset === 0);
    window.requestAnimationFrame(frame);
  }

  hint.textContent = coarsePointer.matches ? "drag the sky to move the sun" : "scroll to move the sun";
  scatterStars();
  fitRing();
  window.requestAnimationFrame(frame);
})();
