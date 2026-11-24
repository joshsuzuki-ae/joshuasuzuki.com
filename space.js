(() => {
  "use strict";

  const canvas = document.querySelector("[data-space]");
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const demo = new URLSearchParams(window.location.search).get("space") === "demo";

  // Seconds. `first` is the delay after load, `every` the gap after each event.
  const CADENCE = demo
    ? {
        star: { first: [0.3, 1], every: [1.5, 3.5] },
        train: { first: [0.5, 1], every: [9, 12] },
        rocket: { first: [1, 2], every: [12, 15] },
      }
    : {
        star: { first: [1.5, 4], every: [6, 16] },
        train: { first: [8, 12], every: [25, 50] },
        rocket: { first: [15, 20], every: [45, 90] },
      };
  const MAX_ACTIVE = demo ? 3 : 2;
  const RETRY = [1.5, 4];
  const TAU = Math.PI * 2;

  // Rocket, in CSS px at DPR 1. The origin is the stage-separation plane; +y runs toward the engines.
  const BOOSTER_LEN = 19;
  const BODY_HALF = 1.75;
  const BODY = "#dfe3ea";
  const INTERSTAGE = "#2b2e33";
  const COAST = 0.5; // seconds between booster cutoff and second-stage ignition
  const GRAVITY = 45; // px/s², for the falling booster
  const TRAIL = 360;
  const PUFF_STEP = 3; // px between smoke puffs

  // Starfield: drifts right to left and slightly down, like a view out a side window.
  const STAR_DENSITY = 170 / (1440 * 900); // stars per px²
  const STAR_MAX = 220;
  const STAR_MIN = 90;
  const DRIFT_X = -0.97;
  const DRIFT_Y = 0.24;
  const STAR_MARGIN = 4; // px beyond each edge, so stars wrap out of sight
  const LAYERS = [
    { share: 0.5, speed: [2, 5], size: 1.1, alpha: [0.3, 0.55] },
    { share: 0.32, speed: [7, 11], size: 1.4, alpha: [0.4, 0.7] },
    { share: 0.18, speed: [13, 20], size: 3, alpha: [0.55, 0.85] },
  ];

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
  const sign = () => (Math.random() < 0.5 ? -1 : 1);

  // ---- Sprites, rendered once ----

  function sprite(w, h, paint) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    paint(c.getContext("2d"), w, h);
    return c;
  }

  const radial = (stops) =>
    sprite(64, 64, (g, w, h) => {
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      stops.forEach(([at, color]) => grad.addColorStop(at, color));
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    });

  const SOFT = radial([[0, "rgba(255, 255, 255, 1)"], [0.25, "rgba(255, 255, 255, 0.5)"], [1, "rgba(255, 255, 255, 0)"]]);
  const WARM = radial([[0, "rgba(255, 226, 170, 1)"], [0.3, "rgba(255, 150, 70, 0.45)"], [1, "rgba(255, 90, 30, 0)"]]);
  const SMOKE = radial([[0, "rgba(214, 218, 228, 1)"], [0.5, "rgba(200, 205, 216, 0.45)"], [1, "rgba(190, 196, 208, 0)"]]);

  // A tapering wedge: transparent point on the left, full-width head on the right.
  const STREAK = sprite(256, 16, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "rgba(255, 255, 255, 0)");
    grad.addColorStop(0.7, "rgba(255, 255, 255, 0.3)");
    grad.addColorStop(1, "rgba(255, 255, 255, 1)");
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(w, 0);
    g.lineTo(w, h);
    g.closePath();
    g.fill();
  });

  // Exhaust plume hanging down from the nozzle at the top edge.
  const FLAME = sprite(32, 96, (g) => {
    g.translate(16, 6);
    g.scale(1, 5.6);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, 16);
    grad.addColorStop(0, "rgba(255, 250, 235, 1)");
    grad.addColorStop(0.2, "rgba(255, 214, 140, 0.9)");
    grad.addColorStop(0.5, "rgba(255, 140, 60, 0.45)");
    grad.addColorStop(1, "rgba(255, 80, 20, 0)");
    g.fillStyle = grad;
    g.fillRect(-16, -2, 32, 18);
  });

  // ---- Canvas ----

  let dpr = 1;
  let W = 0;
  let H = 0;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    field.count = Math.round(clamp(W * H * STAR_DENSITY, STAR_MIN, STAR_MAX));
    if (!running) paintStill();
  }

  // Positions later drawing at (x, y) in CSS px, rotated clockwise by `angle`.
  function place(x, y, angle, scale) {
    const c = Math.cos(angle) * dpr * scale;
    const s = Math.sin(angle) * dpr * scale;
    ctx.setTransform(c, s, -s, c, x * dpr, y * dpr);
  }

  function clear() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // ---- Starfield ----
  // Positions are normalized to the viewport so a resize just stretches the field.
  // The list is seeded and fixed; smaller screens draw a prefix of it.

  const field = (() => {
    let seed = 20171999;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const between = ([lo, hi]) => lo + random() * (hi - lo);
    const f = {
      u: new Float32Array(STAR_MAX),
      v: new Float32Array(STAR_MAX),
      speed: new Float32Array(STAR_MAX),
      size: new Float32Array(STAR_MAX),
      alpha: new Float32Array(STAR_MAX),
      phase: new Float32Array(STAR_MAX),
      rate: new Float32Array(STAR_MAX),
      sprite: new Uint8Array(STAR_MAX),
      count: 0,
      time: 0,
    };
    for (let i = 0; i < STAR_MAX; i++) {
      let roll = random();
      let layer = 0;
      while (layer < LAYERS.length - 1 && roll > LAYERS[layer].share) roll -= LAYERS[layer++].share;
      const l = LAYERS[layer];
      f.u[i] = random();
      f.v[i] = random();
      f.speed[i] = between(l.speed);
      f.size[i] = l.size * (0.85 + random() * 0.3);
      f.alpha[i] = between(l.alpha);
      f.phase[i] = random() * TAU;
      f.rate[i] = random() < 0.35 ? 0.6 + random() * 1.6 : 0;
      f.sprite[i] = layer === LAYERS.length - 1 ? 1 : 0;
    }
    return f;
  })();

  const DOT = radial([[0, "rgba(255, 255, 255, 1)"], [0.35, "rgba(255, 255, 255, 0.85)"], [1, "rgba(255, 255, 255, 0)"]]);

  function drawStars(dt, still) {
    const fw = W + STAR_MARGIN * 2;
    const fh = H + STAR_MARGIN * 2;
    const dx = (DRIFT_X * dt) / fw;
    const dy = (DRIFT_Y * dt) / fh;
    field.time += dt;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fff";
    for (let i = 0; i < field.count; i++) {
      let u = field.u[i] + dx * field.speed[i];
      let v = field.v[i] + dy * field.speed[i];
      u -= Math.floor(u);
      v -= Math.floor(v);
      field.u[i] = u;
      field.v[i] = v;
      const x = u * fw - STAR_MARGIN;
      const y = v * fh - STAR_MARGIN;
      const rate = field.rate[i];
      ctx.globalAlpha = field.alpha[i] * (rate && !still ? 0.72 + 0.28 * Math.sin(field.time * rate + field.phase[i]) : 1);
      const s = field.size[i];
      if (field.sprite[i]) ctx.drawImage(DOT, x - s / 2, y - s / 2, s, s);
      else ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
  }

  // ---- Shooting stars ----

  function spawnStar() {
    const bright = Math.random() < 0.15;
    const dir = sign();
    const dip = rand(0.15, 0.5);
    const reach = clamp(Math.min(W, H) * rand(0.3, 0.5), 140, 420) * (bright ? 1.35 : 1);
    return {
      kind: "star",
      age: 0,
      duration: rand(0.5, 0.9) * (bright ? 1.15 : 1),
      x: (dir > 0 ? rand(0.05, 0.7) : rand(0.3, 0.95)) * W,
      y: rand(0.04, 0.55) * H,
      dx: Math.cos(dip) * dir,
      dy: Math.sin(dip),
      angle: dir > 0 ? dip : Math.PI - dip,
      reach,
      tail: reach * (bright ? 0.5 : 0.4),
      alpha: bright ? 0.9 : rand(0.4, 0.6),
      width: bright ? 2 : 1.3,
      head: bright ? 7 : 4,
    };
  }

  function stepStar(s, dt) {
    s.age += dt;
    const p = s.age / s.duration;
    if (p >= 1) return false;
    const travel = s.reach * p * (1.25 - 0.25 * p);
    const len = Math.min(travel, s.tail) * (1 - 0.4 * smoothstep(0.7, 1, p));
    ctx.globalAlpha = s.alpha * smoothstep(0, 0.12, p) * (1 - smoothstep(0.55, 1, p));
    place(s.x + s.dx * travel, s.y + s.dy * travel, s.angle, 1);
    ctx.drawImage(STREAK, -len, -s.width / 2, len, s.width);
    ctx.drawImage(SOFT, -s.head / 2, -s.head / 2, s.head, s.head);
    return true;
  }

  // ---- Starlink train ----

  function spawnTrain() {
    const count = randInt(12, 24);
    const dir = sign();
    const slope = rand(0.04, 0.2) * sign();
    const norm = Math.hypot(1, slope);
    const spacing = rand(9, 13) * (W < 600 ? 0.8 : 1);
    const margin = 24;
    const distance = (W + 2 * margin) * norm + (count - 1) * spacing;
    const phase = new Float32Array(count);
    const gain = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      phase[i] = Math.random() * TAU;
      gain[i] = rand(0.85, 1);
    }
    return {
      kind: "train",
      age: 0,
      count,
      spacing,
      phase,
      gain,
      dx: dir / norm,
      dy: slope / norm,
      x: dir > 0 ? -margin : W + margin,
      y: rand(0.12, 0.5) * H - slope * (W / 2 + margin),
      travel: 0,
      distance,
      speed: distance / rand(10, 18),
      alpha: rand(0.4, 0.55),
      flicker: rand(2, 4),
    };
  }

  function stepTrain(t, dt) {
    t.age += dt;
    t.travel += t.speed * dt;
    if (t.travel >= t.distance) return false;
    const edge = Math.min(220, W * 0.2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fff";
    for (let i = 0; i < t.count; i++) {
      const along = t.travel - i * t.spacing;
      const x = t.x + t.dx * along;
      const y = t.y + t.dy * along;
      const fade = smoothstep(0, edge, x) * smoothstep(W, W - edge, x) * smoothstep(0, 20, y) * smoothstep(H, H - 20, y);
      if (fade <= 0) continue;
      ctx.globalAlpha = t.alpha * t.gain[i] * fade * (0.85 + 0.15 * Math.sin(t.age * t.flicker + t.phase[i]));
      ctx.beginPath();
      ctx.arc(x, y, 0.8, 0, TAU);
      ctx.fill();
    }
    return true;
  }

  // ---- Falcon 9 launch ----

  function spawnRocket() {
    const dir = sign();
    const trail = new Float32Array(TRAIL * 4);
    for (let i = 0; i < TRAIL; i++) trail[i * 4 + 2] = Infinity;
    return {
      kind: "rocket",
      age: 0,
      duration: rand(7, 10),
      dir,
      size: W < 600 ? 0.85 : 1,
      x: (dir > 0 ? rand(0.08, 0.22) : rand(0.78, 0.92)) * W,
      y: H + 16,
      travel: 0,
      heading: 0,
      vx: 0,
      vy: 0,
      reach: clamp(H * 1.15, 420, 1100),
      // Pitch over harder on wide screens so the arc stays in view on tall ones.
      pitch: rand(0.8, 1) * clamp(W / H, 0.5, 1.15),
      sepAt: rand(0.58, 0.66),
      sepAge: -1,
      booster: null,
      trail,
      trailHead: 0,
      emitX: NaN,
      emitY: 0,
      wind: rand(4, 10) * sign(),
    };
  }

  function emit(r, x, y, weight) {
    if (Number.isNaN(r.emitX)) {
      r.emitX = x;
      r.emitY = y;
    }
    const dist = Math.hypot(x - r.emitX, y - r.emitY);
    const steps = Math.min(8, Math.floor(dist / PUFF_STEP));
    for (let k = 1; k <= steps; k++) {
      const i = r.trailHead * 4;
      const f = k / steps;
      r.trail[i] = lerp(r.emitX, x, f);
      r.trail[i + 1] = lerp(r.emitY, y, f);
      r.trail[i + 2] = 0;
      r.trail[i + 3] = weight;
      r.trailHead = (r.trailHead + 1) % TRAIL;
    }
    if (steps) {
      r.emitX = x;
      r.emitY = y;
    }
  }

  function drawBooster() {
    ctx.fillStyle = INTERSTAGE;
    ctx.fillRect(-BODY_HALF, 0, BODY_HALF * 2, 1.6);
    ctx.fillStyle = BODY;
    ctx.fillRect(-BODY_HALF, 1.6, BODY_HALF * 2, BOOSTER_LEN - 1.6);
  }

  function drawUpperStage() {
    ctx.fillStyle = BODY;
    ctx.fillRect(-BODY_HALF, -7, BODY_HALF * 2, 7);
    ctx.beginPath();
    ctx.moveTo(-2.1, -7);
    ctx.lineTo(-2.1, -10.5);
    ctx.quadraticCurveTo(-2.1, -14, 0, -14.5);
    ctx.quadraticCurveTo(2.1, -14, 2.1, -10.5);
    ctx.lineTo(2.1, -7);
    ctx.closePath();
    ctx.fill();
  }

  function stepRocket(r, dt) {
    r.age += dt;
    const p = Math.min(1, r.age / r.duration);
    const flying = r.age < r.duration;

    if (flying) {
      const travel = r.reach * Math.pow(p, 1.8);
      const ds = travel - r.travel;
      r.travel = travel;
      r.heading = r.pitch * Math.pow(p, 1.3);
      const mx = Math.sin(r.heading) * r.dir * ds;
      const my = -Math.cos(r.heading) * ds;
      r.x += mx;
      r.y += my;
      if (dt > 0) {
        r.vx = mx / dt;
        r.vy = my / dt;
      }
      if (r.sepAge < 0 && p >= r.sepAt) {
        r.sepAge = 0;
        r.booster = { x: r.x, y: r.y, vx: r.vx * 0.92, vy: r.vy * 0.92, angle: r.heading * r.dir, spin: -r.dir * rand(0.6, 1.1), age: 0 };
      }
    }
    if (r.sepAge >= 0) r.sepAge += dt;

    const separated = r.sepAge >= 0;
    const angle = r.heading * r.dir;
    const scale = r.size * lerp(1, 0.75, p);
    const fade = 1 - smoothstep(0.82, 1, p);
    const nozzle = (separated ? 1 : BOOSTER_LEN + 0.5) * scale;
    const ex = r.x - Math.sin(angle) * nozzle;
    const ey = r.y + Math.cos(angle) * nozzle;
    const burning = flying && (!separated || r.sepAge > COAST);
    if (burning) emit(r, ex, ey, separated ? 0.7 : 1);
    else r.emitX = NaN;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Glow on the horizon as it clears the pad.
    if (burning && ey > H - 180) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.3 * smoothstep(H + 50, H + 10, ey) * (1 - smoothstep(H - 20, H - 170, ey));
      ctx.drawImage(WARM, ex - 70, H - 70, 140, 140);
      ctx.globalCompositeOperation = "source-over";
    }

    let alive = flying;
    const trail = r.trail;
    for (let i = 0; i < TRAIL * 4; i += 4) {
      const age = trail[i + 2];
      const weight = trail[i + 3];
      const life = 1.2 + 1.6 * weight;
      if (age >= life) continue;
      alive = true;
      trail[i + 2] = age + dt;
      trail[i] += r.wind * weight * dt;
      const k = age / life;
      const radius = (1.4 + 8 * k) * Math.sqrt(weight) * r.size;
      ctx.globalAlpha = 0.15 * weight * Math.pow(1 - k, 1.6);
      ctx.drawImage(SMOKE, trail[i] - radius, trail[i + 1] - radius, radius * 2, radius * 2);
    }

    const b = r.booster;
    if (b && b.age < 3) {
      alive = true;
      b.age += dt;
      b.vy += GRAVITY * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.angle += b.spin * dt;
      ctx.globalAlpha = 0.8 * (1 - smoothstep(0.6, 3, b.age));
      place(b.x, b.y, b.angle, scale);
      drawBooster();
    }

    if (!flying) return alive;

    if (separated && r.sepAge < 0.4) {
      const f = r.sepAge / 0.4;
      const size = (6 + 16 * f) * scale;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.7 * (1 - f);
      ctx.drawImage(SOFT, r.x - size / 2, r.y - size / 2, size, size);
      ctx.globalCompositeOperation = "source-over";
    }

    if (burning) {
      const flicker = 0.85 + Math.random() * 0.3;
      ctx.globalCompositeOperation = "lighter";
      place(ex, ey, angle, scale);
      ctx.globalAlpha = (separated ? 0.5 : 0.85) * fade;
      const fw = separated ? 3.6 : 5;
      const fl = (separated ? 11 : 15) * flicker;
      ctx.drawImage(FLAME, -fw / 2, -0.5, fw, fl);
      ctx.globalAlpha = (separated ? 0.2 : 0.4) * fade * flicker;
      ctx.drawImage(WARM, -12, -9, 24, 24);
      ctx.globalCompositeOperation = "source-over";
    }

    ctx.globalAlpha = 0.85 * fade;
    place(r.x, r.y, angle, scale);
    if (!separated) drawBooster();
    drawUpperStage();
    return true;
  }

  // ---- Scheduling and the loop ----

  const STEP = { star: stepStar, train: stepTrain, rocket: stepRocket };
  const SPAWN = { star: spawnStar, train: spawnTrain, rocket: spawnRocket };
  const active = [];
  const next = {};
  let clock = 0; // seconds of visible time
  let running = false;
  let raf = 0;
  let last = 0;

  const schedule = (kind, [lo, hi]) => {
    next[kind] = clock + rand(lo, hi);
  };
  Object.keys(CADENCE).forEach((kind) => schedule(kind, CADENCE[kind].first));

  function onScreen(kind) {
    for (let i = 0; i < active.length; i++) if (active[i].kind === kind) return true;
    return false;
  }

  function spawnDue() {
    for (const kind in SPAWN) {
      if (clock < next[kind]) continue;
      if (active.length >= MAX_ACTIVE || (kind !== "star" && onScreen(kind))) {
        schedule(kind, RETRY);
        continue;
      }
      active.push(SPAWN[kind]());
      schedule(kind, CADENCE[kind].every);
    }
  }

  function frame(now) {
    raf = 0;
    const elapsed = Math.max(0, (now - last) / 1000);
    last = now;
    clock += elapsed;
    const dt = Math.min(0.05, elapsed);
    spawnDue();
    clear();
    drawStars(dt, false);
    let kept = 0;
    for (let i = 0; i < active.length; i++) {
      const event = active[i];
      if (STEP[event.kind](event, dt)) active[kept++] = event;
    }
    active.length = kept;
    ctx.globalAlpha = 1;
    if (running) raf = window.requestAnimationFrame(frame);
  }

  // Reduced motion gets a still starfield and no events.
  function paintStill() {
    clear();
    drawStars(0, true);
    ctx.globalAlpha = 1;
  }

  function start() {
    if (running || reduceMotion.matches || document.hidden) return;
    running = true;
    last = performance.now();
    raf = window.requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    window.cancelAnimationFrame(raf);
    raf = 0;
  }

  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  reduceMotion.addEventListener("change", () => {
    if (!reduceMotion.matches) return start();
    stop();
    active.length = 0;
    paintStill();
  });
  window.addEventListener("resize", resize);

  resize();
  start();
})();
