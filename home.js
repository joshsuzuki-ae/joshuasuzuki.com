(() => {
  "use strict";

  const SF = { lat: 37.7749, lon: -122.4194 };
  const TZ = "America/Los_Angeles";
  const RING_RADIUS = 210;
  const RING_GAP = 28;
  const BASE_FONT_SIZE = 17;
  const RETURN_DELAY = 6000;
  const MAX_OFFSET = 12 * 3600e3;
  const MINUTE = 60e3;
  const SCREENSAVER_DELAY = 10000;
  // Bends the path slightly when both walls are about to be hit within this many
  // seconds, so a corner lands every minute or two instead of every half hour.
  const CORNER_ASSIST = 0.25;
  const DVD_COLORS = [
    [0, 153, 255],
    [255, 46, 147],
    [255, 214, 0],
    [0, 230, 118],
    [170, 92, 255],
    [255, 120, 0],
    [0, 229, 255],
  ];

  // Ball physics, tuned by feel. Speeds are px/s, spin is deg/s.
  const FRICTION = 0.9; // fraction of speed lost per second, as an exponential rate
  const RESTITUTION = 0.8;
  const MAX_THROW = 4200;
  const SQUASH = 0.00022; // squash per px/s of impact speed
  const MAX_SQUASH = 0.32;
  const JELLY_STIFFNESS = 320;
  const JELLY_DAMPING = 13;
  const STRETCH = 0.000035; // stretch along the direction of travel per px/s
  const MAX_STRETCH = 0.14;

  const root = document.documentElement;
  const orbit = document.querySelector("[data-orbit]");
  const ring = document.querySelector("[data-ring]");
  const ringText = document.querySelector("[data-ring-text]");
  const textPath = ringText.querySelector("textPath");
  const stars = document.querySelector("[data-stars]");
  const caption = document.querySelector("[data-caption]");
  const hint = document.querySelector(".hint");
  const cornerLabel = document.querySelector("[data-corner]");
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
  const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const toRad = (deg) => (deg * Math.PI) / 180;

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

    return `${live ? "live · " : ""}san francisco · ${clock.format(date).toLowerCase()} · ${phaseName(altitude)}`;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
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

  // ---- Time scrubbing -------------------------------------------------------

  const baseOffset = previewOffset();
  let scrubOffset = 0;
  let lastScrub = 0;
  let scrubDrag = null;

  function scrub(deltaMs) {
    scrubOffset = clamp(scrubOffset + deltaMs, -MAX_OFFSET, MAX_OFFSET);
    lastScrub = performance.now();
  }

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

  // ---- The ball -------------------------------------------------------------
  // One body drives everything: resting, held, thrown, bouncing as a
  // screensaver, and gliding home. `ex`/`ey` are squash (negative) or bulge
  // (positive) along the screen axes, sprung back like jelly after each hit.

  const ball = {
    mode: "rest", // rest | held | free | saver | home
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    spin: 0,
    scale: 1,
    ex: 0,
    ey: 0,
    evx: 0,
    evy: 0,
    wallX: 0,
    wallY: 0,
  };
  let grab = null;
  let suppressClick = false;
  let saver = null;
  let lastActivity = performance.now();

  const storage = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();
  let corners = Number((storage && storage.getItem("corners")) || 0);

  function saverScale() {
    const size = clamp(Math.min(window.innerWidth, window.innerHeight) * 0.28, 150, 250);
    return size / (orbit.offsetWidth * 0.92);
  }

  // Outside the screensaver, the caption's top edge acts as the floor so the ring never lands on it.
  function bounds(scale, fullScreen) {
    const r = orbit.offsetWidth * 0.46 * scale;
    const half = window.innerHeight / 2 - r;
    const floor = fullScreen ? 0 : window.innerHeight - caption.parentElement.getBoundingClientRect().top + 8;
    return {
      r,
      bx: Math.max(0, window.innerWidth / 2 - r),
      top: Math.max(0, half),
      bottom: Math.max(0, half - floor),
    };
  }

  function impact(axis, speed, side, strength = 1) {
    const amount = Math.min(MAX_SQUASH * 14, speed * SQUASH * 14) * strength;
    if (axis === "x") {
      ball.evx -= amount;
      ball.evy += amount * 0.7;
      ball.wallX = side;
    } else {
      ball.evy -= amount;
      ball.evx += amount * 0.7;
      ball.wallY = side;
    }
  }

  // Integrate position and resolve wall hits. Returns which walls were hit.
  function move(dt, { bx, top, bottom }, restitution) {
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    let hitX = false;
    let hitY = false;
    if (Math.abs(ball.x) > bx) {
      const side = Math.sign(ball.x);
      ball.x = side * bx;
      impact("x", Math.abs(ball.vx), side, restitution < 1 ? 1 : 0.35);
      ball.spin += side * ball.vy * 0.08;
      ball.vx = -ball.vx * restitution;
      hitX = true;
    }
    if (ball.y > bottom || ball.y < -top) {
      const side = Math.sign(ball.y);
      ball.y = side > 0 ? bottom : -top;
      impact("y", Math.abs(ball.vy), side, restitution < 1 ? 1 : 0.35);
      ball.spin -= side * ball.vx * 0.08;
      ball.vy = -ball.vy * restitution;
      hitY = true;
    }
    return { hitX, hitY };
  }

  function stepJelly(dt) {
    ball.evx += (-JELLY_STIFFNESS * ball.ex - JELLY_DAMPING * ball.evx) * dt;
    ball.evy += (-JELLY_STIFFNESS * ball.ey - JELLY_DAMPING * ball.evy) * dt;
    ball.ex = clamp(ball.ex + ball.evx * dt, -MAX_SQUASH, MAX_SQUASH);
    ball.ey = clamp(ball.ey + ball.evy * dt, -MAX_SQUASH, MAX_SQUASH);
  }

  // Spin decays, then the ring springs back to upright so it's readable at rest.
  function stepSpin(dt, settle) {
    ball.spin *= Math.exp(-1.4 * dt);
    if (settle || Math.abs(ball.spin) < 60) {
      const upright = Math.round(ball.angle / 360) * 360;
      ball.spin = lerp(ball.spin, (upright - ball.angle) * 4, ease(8, dt));
    }
    ball.angle += ball.spin * dt;
  }

  // ---- Grabbing and throwing ----

  orbit.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    grab = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: event.clientX - (window.innerWidth / 2 + ball.x),
      dy: event.clientY - (window.innerHeight / 2 + ball.y),
      samples: [],
      held: false,
    };
  });

  document.addEventListener("pointerdown", (event) => {
    if (orbit.contains(event.target) || event.button !== 0) return;
    scrubDrag = { pointerId: event.pointerId, y: event.clientY };
  });

  window.addEventListener("pointermove", (event) => {
    if (grab && event.pointerId === grab.pointerId) {
      // Only take over once it's clearly a drag, so a plain tap still reaches the link underneath.
      if (!grab.held && Math.hypot(event.clientX - grab.startX, event.clientY - grab.startY) > 5) {
        grab.held = true;
        orbit.setPointerCapture(event.pointerId);
        orbit.classList.add("is-held");
        if (saver) endSaver();
        ball.mode = "held";
        ball.vx = ball.vy = 0;
      }
      if (grab.held) {
        grab.samples.push({ t: event.timeStamp, x: event.clientX, y: event.clientY });
        while (grab.samples.length > 2 && event.timeStamp - grab.samples[0].t > 90) grab.samples.shift();
      }
    } else if (scrubDrag && event.pointerId === scrubDrag.pointerId) {
      scrub((event.clientY - scrubDrag.y) * 2 * MINUTE);
      scrubDrag.y = event.clientY;
    }
  });

  function release(event) {
    if (grab && event.pointerId === grab.pointerId) {
      if (grab.held) {
        const first = grab.samples[0];
        const last = grab.samples[grab.samples.length - 1];
        const dt = first && last ? (last.t - first.t) / 1000 : 0;
        let vx = dt > 0.008 ? (last.x - first.x) / dt : 0;
        let vy = dt > 0.008 ? (last.y - first.y) / dt : 0;
        const speed = Math.hypot(vx, vy);
        if (speed > MAX_THROW) {
          vx *= MAX_THROW / speed;
          vy *= MAX_THROW / speed;
        }
        ball.vx = vx;
        ball.vy = vy;
        // Grabbing off-center puts spin on the throw, like flicking a coin.
        const r = Math.max(60, Math.hypot(grab.dx, grab.dy));
        ball.spin += ((grab.dx * vy - grab.dy * vx) / (r * r)) * (180 / Math.PI) * 0.6;
        ball.mode = "free";
        suppressClick = true;
        orbit.classList.remove("is-held");
      }
      grab = null;
    }
    if (scrubDrag && event.pointerId === scrubDrag.pointerId) scrubDrag = null;
  }
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);

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

  // ---- Screensaver ----

  function setDvdColor(index) {
    saver.color = index % DVD_COLORS.length;
    document.body.style.setProperty("--dvd", rgb(DVD_COLORS[saver.color]));
  }

  function startSaver() {
    const speed = Math.max(110, Math.min(window.innerWidth, window.innerHeight) * 0.22);
    const heading = 0.4 + Math.random() * 0.7 + (Math.PI / 2) * Math.floor(Math.random() * 4);
    saver = { sx: Math.abs(speed * Math.cos(heading)), sy: Math.abs(speed * Math.sin(heading)), assisted: false, hitX: -1, hitY: -2, color: 0 };
    ball.mode = "saver";
    ball.vx = speed * Math.cos(heading);
    ball.vy = speed * Math.sin(heading);
    setDvdColor(Math.floor(Math.random() * DVD_COLORS.length));
    document.body.classList.add("is-screensaver");
  }

  function endSaver() {
    saver = null;
    document.body.classList.remove("is-screensaver");
  }

  function wake() {
    lastActivity = performance.now();
    if (ball.mode === "saver") {
      endSaver();
      ball.mode = "home";
      ball.vx = ball.vy = 0;
    }
  }
  ["pointermove", "pointerdown", "wheel", "keydown", "touchstart"].forEach((type) =>
    window.addEventListener(type, wake, { passive: true })
  );

  function celebrate(cornerX, cornerY) {
    corners++;
    if (storage) storage.setItem("corners", String(corners));
    ball.evx += 5;
    ball.evy += 5;

    const colors = DVD_COLORS.map(rgb);
    for (let i = 0; i < 46; i++) {
      const particle = document.createElement("span");
      particle.className = "particle";
      particle.style.left = `${cornerX}px`;
      particle.style.top = `${cornerY}px`;
      particle.style.background = colors[i % colors.length];
      document.body.appendChild(particle);
      const angle = Math.random() * (Math.PI / 2);
      const distance = 120 + Math.random() * 320;
      const dx = Math.cos(angle) * distance * (cornerX > 0 ? -1 : 1);
      const dy = Math.sin(angle) * distance * (cornerY > 0 ? -1 : 1);
      particle
        .animate(
          [
            { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
            { transform: `translate(calc(${dx}px - 50%), calc(${dy}px - 50%)) scale(0.3)`, opacity: 0 },
          ],
          { duration: 900 + Math.random() * 900, easing: "cubic-bezier(0.1, 0.8, 0.3, 1)" }
        )
        .finished.then(() => particle.remove());
    }

    setText(cornerLabel.querySelector("[data-corner-count]"), corners === 1 ? "your first one" : `that's ${corners}`);
    cornerLabel.classList.remove("is-visible");
    void cornerLabel.offsetWidth;
    cornerLabel.classList.add("is-visible");
  }

  function stepSaver(dt, now, b) {
    const tx = (b.bx - Math.sign(ball.vx) * ball.x) / Math.abs(ball.vx);
    const ty = (b.top - Math.sign(ball.vy) * ball.y) / Math.abs(ball.vy);
    if (!saver.assisted && Math.min(tx, ty) < 1.5 && Math.abs(tx - ty) < CORNER_ASSIST) {
      const t = Math.max(0.05, Math.min(tx, ty));
      if (tx < ty) ball.vy = (Math.sign(ball.vy) * (b.top - Math.sign(ball.vy) * ball.y)) / t;
      else ball.vx = (Math.sign(ball.vx) * (b.bx - Math.sign(ball.vx) * ball.x)) / t;
      saver.assisted = true;
    }

    const { hitX, hitY } = move(dt, b, 1);
    if (hitX) {
      ball.vx = Math.sign(ball.vx) * saver.sx;
      saver.hitX = now;
    }
    if (hitY) {
      ball.vy = Math.sign(ball.vy) * saver.sy;
      saver.hitY = now;
    }
    if (hitX || hitY) {
      saver.assisted = false;
      setDvdColor(saver.color + 1);
      if (Math.abs(saver.hitX - saver.hitY) < 50) {
        celebrate(ball.x > 0 ? window.innerWidth : 0, ball.y > 0 ? window.innerHeight : 0);
        saver.hitX = -1;
        saver.hitY = -2;
      }
    }
  }

  // ---- Per-frame update ----

  let lastTransform = "";
  let lastSpin = "";
  function stepBall(dt, now) {
    const targetScale = ball.mode === "saver" ? saverScale() : 1;
    ball.scale = lerp(ball.scale, targetScale, ease(ball.mode === "saver" ? 2.5 : 6, dt));
    const b = bounds(ball.scale, ball.mode === "saver");

    if (ball.mode === "held" && grab) {
      const last = grab.samples[grab.samples.length - 1];
      if (last) {
        const tx = last.x - window.innerWidth / 2 - grab.dx;
        const ty = last.y - window.innerHeight / 2 - grab.dy;
        const nx = clamp(tx, -b.bx, b.bx);
        const ny = clamp(ty, -b.top, b.bottom);
        ball.vx = lerp(ball.vx, (nx - ball.x) / Math.max(dt, 1e-3), 0.5);
        ball.vy = lerp(ball.vy, (ny - ball.y) / Math.max(dt, 1e-3), 0.5);
        // Pushing past a wall while holding squishes the ball against it.
        if (Math.abs(tx) > b.bx) {
          ball.ex = lerp(ball.ex, -clamp((Math.abs(tx) - b.bx) / (b.r * 2), 0, MAX_SQUASH), 0.4);
          ball.wallX = Math.sign(tx);
        }
        if (ty > b.bottom || ty < -b.top) {
          const limit = ty > 0 ? b.bottom : b.top;
          ball.ey = lerp(ball.ey, -clamp((Math.abs(ty) - limit) / (b.r * 2), 0, MAX_SQUASH), 0.4);
          ball.wallY = Math.sign(ty);
        }
        ball.x = nx;
        ball.y = ny;
      }
      stepSpin(dt, true);
    } else if (ball.mode === "free") {
      const decay = Math.exp(-FRICTION * dt);
      ball.vx *= decay;
      ball.vy *= decay;
      move(dt, b, RESTITUTION);
      stepSpin(dt, false);
      if (Math.hypot(ball.vx, ball.vy) < 6 && Math.abs(ball.spin) < 2) {
        ball.vx = ball.vy = 0;
        ball.mode = "rest";
      }
    } else if (ball.mode === "saver") {
      stepSaver(dt, now, b);
      stepSpin(dt, true);
    } else if (ball.mode === "home") {
      ball.x = lerp(ball.x, 0, ease(5, dt));
      ball.y = lerp(ball.y, 0, ease(5, dt));
      stepSpin(dt, true);
      if (Math.hypot(ball.x, ball.y) < 0.5 && Math.abs(ball.scale - 1) < 0.002) {
        ball.x = ball.y = 0;
        ball.mode = "rest";
      }
    } else {
      stepSpin(dt, true);
    }
    stepJelly(dt);

    // Stretch along the direction of travel, and keep a squashed edge pressed to its wall.
    const speed = ball.mode === "rest" ? 0 : Math.hypot(ball.vx, ball.vy);
    const gap = Math.min(b.bx - Math.abs(ball.x), ball.y > 0 ? b.bottom - ball.y : b.top + ball.y);
    const stretch = Math.min(MAX_STRETCH, speed * STRETCH) * clamp(gap / (b.r * 0.35), 0, 1);
    const heading = Math.atan2(ball.vy, ball.vx) * (180 / Math.PI);
    const px = ball.x + ball.wallX * b.r * Math.max(0, -ball.ex);
    const py = ball.y + ball.wallY * b.r * Math.max(0, -ball.ey);
    const parts = [`translate(${px.toFixed(2)}px, ${py.toFixed(2)}px)`];
    if (stretch > 0.002) {
      parts.push(`rotate(${heading.toFixed(2)}deg) scale(${(1 + stretch).toFixed(4)}, ${(1 / (1 + stretch)).toFixed(4)}) rotate(${(-heading).toFixed(2)}deg)`);
    }
    parts.push(`scale(${(ball.scale * (1 + ball.ex)).toFixed(4)}, ${(ball.scale * (1 + ball.ey)).toFixed(4)})`);
    const transform = parts.join(" ");
    if (transform !== lastTransform) {
      orbit.style.transform = transform;
      lastTransform = transform;
    }
    const spin = Math.abs(ball.angle % 360) < 0.01 ? "" : `rotate(${(ball.angle % 360).toFixed(3)}deg)`;
    if (spin !== lastSpin) {
      ring.style.transform = spin;
      lastSpin = spin;
    }
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;

    if (scrubOffset !== 0 && !scrubDrag && now - lastScrub > RETURN_DELAY) {
      scrubOffset = reduceMotion.matches ? 0 : scrubOffset * Math.exp(-dt * 2.2);
      if (Math.abs(scrubOffset) < 30e3) scrubOffset = 0;
    }

    const idle = now - lastActivity > SCREENSAVER_DELAY && !grab && !scrubDrag && !document.hidden;
    if (idle && (ball.mode === "rest" || ball.mode === "free") && !reduceMotion.matches) startSaver();
    stepBall(dt, now);

    const sky = renderSky(new Date(Date.now() + baseOffset + scrubOffset), baseOffset === 0 && scrubOffset === 0);
    if (ball.mode === "saver") {
      setText(caption, corners ? `corners hit: ${corners}` : "waiting for a corner…");
      setText(hint, "move to wake");
    } else {
      setText(caption, sky);
      setText(hint, coarsePointer.matches ? "throw the ring · drag the sky to move the sun" : "throw the ring · scroll to move the sun");
    }
    window.requestAnimationFrame(frame);
  }

  if (new URLSearchParams(window.location.search).has("screensaver")) lastActivity = -SCREENSAVER_DELAY;
  scatterStars();
  fitRing();
  window.requestAnimationFrame(frame);
})();
