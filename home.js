(() => {
  "use strict";

  const RING_RADIUS = 210;
  const RING_GAP = 28;
  const BASE_FONT_SIZE = 17;
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
  const IDLE_SPIN = 4; // deg/s, slow orbit so the ring text stays readable at rest

  const orbit = document.querySelector("[data-orbit]");
  const ring = document.querySelector("[data-ring]");
  const ringText = document.querySelector("[data-ring-text]");
  const textPath = ringText.querySelector("textPath");
  const caption = document.querySelector("[data-caption]");
  const status = document.querySelector("[data-status]");
  const hint = document.querySelector("[data-hint]");
  const cornerLabel = document.querySelector("[data-corner]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
  const rgb = (c) => `rgb(${c.map((v) => Math.round(v)).join(", ")})`;

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
  let hoveringLink = false;

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
    const floor = fullScreen ? 0 : window.innerHeight - caption.getBoundingClientRect().top + 8;
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

  // Spin eases toward `drift` (deg/s). `null` springs upright; `false` decays in flight only.
  function stepSpin(dt, drift) {
    if (drift === null) {
      ball.spin *= Math.exp(-1.4 * dt);
      const upright = Math.round(ball.angle / 360) * 360;
      ball.spin = lerp(ball.spin, (upright - ball.angle) * 4, ease(8, dt));
    } else if (drift === false) {
      ball.spin *= Math.exp(-1.4 * dt);
    } else {
      ball.spin = lerp(ball.spin, drift, ease(1.4, dt));
    }
    ball.angle += ball.spin * dt;
  }

  // Slow rotation at rest so the whole ring can be read without tilting your head; it pauses on links.
  function idleSpin() {
    if (reduceMotion.matches) return null;
    return hoveringLink ? 0 : IDLE_SPIN;
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
    }
  });

  function release(event) {
    if (!grab || event.pointerId !== grab.pointerId) return;
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

  ring.querySelectorAll("a").forEach((link) => {
    link.addEventListener("pointerenter", () => { hoveringLink = true; });
    link.addEventListener("pointerleave", () => { hoveringLink = false; });
    link.addEventListener("focus", () => { hoveringLink = true; });
    link.addEventListener("blur", () => { hoveringLink = false; });
  });

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
      stepSpin(dt, null);
    } else if (ball.mode === "free") {
      const decay = Math.exp(-FRICTION * dt);
      ball.vx *= decay;
      ball.vy *= decay;
      move(dt, b, RESTITUTION);
      stepSpin(dt, false);
      if (Math.hypot(ball.vx, ball.vy) < 6) {
        ball.vx = ball.vy = 0;
        ball.mode = "rest";
      }
    } else if (ball.mode === "saver") {
      stepSaver(dt, now, b);
      stepSpin(dt, null);
    } else if (ball.mode === "home") {
      ball.x = lerp(ball.x, 0, ease(5, dt));
      ball.y = lerp(ball.y, 0, ease(5, dt));
      stepSpin(dt, null);
      if (Math.hypot(ball.x, ball.y) < 0.5 && Math.abs(ball.scale - 1) < 0.002) {
        ball.x = ball.y = 0;
        ball.mode = "rest";
      }
    } else {
      stepSpin(dt, idleSpin());
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

    const idle = now - lastActivity > SCREENSAVER_DELAY && !grab && !document.hidden;
    if (idle && (ball.mode === "rest" || ball.mode === "free") && !reduceMotion.matches) startSaver();
    stepBall(dt, now);

    const saving = ball.mode === "saver";
    if (status.hidden === saving) status.hidden = !saving;
    if (saving) setText(status, corners ? `corners hit: ${corners}` : "waiting for a corner…");
    setText(hint, saving ? "move to wake" : "throw the ring");
    window.requestAnimationFrame(frame);
  }

  if (new URLSearchParams(window.location.search).has("screensaver")) lastActivity = -SCREENSAVER_DELAY;
  fitRing();
  window.requestAnimationFrame(frame);
})();
