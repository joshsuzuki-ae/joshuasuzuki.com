/* =========================
   Utilities
========================= */

(function updateYear() {
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();

const prefersReducedMotion =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* =========================
   Header: hairline once scrolled, small-screen menu
========================= */

(function header() {
  const headerEl = document.querySelector(".site-header");
  if (!headerEl) return;

  const onScroll = () => headerEl.classList.toggle("is-scrolled", window.scrollY > 4);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  const toggle = headerEl.querySelector("[data-menu-toggle]");
  const nav = document.getElementById("site-nav");
  if (!toggle || !nav) return;

  const isOpen = () => toggle.getAttribute("aria-expanded") === "true";
  const setOpen = (open) => {
    headerEl.classList.toggle("menu-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };

  toggle.addEventListener("click", () => setOpen(!isOpen()));
  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (isOpen() && !headerEl.contains(event.target)) setOpen(false);
  });
  if (typeof window.matchMedia === "function") {
    const wide = window.matchMedia("(min-width: 761px)");
    const close = () => setOpen(false);
    if (typeof wide.addEventListener === "function") wide.addEventListener("change", close);
  }
})();

/* =========================
   Sky: San Francisco clock and the Afterglow tile caption.
   Colors are applied in <head> by theme-init.js.
========================= */

(function sky() {
  const skyApi = window.siteSky;
  if (!skyApi || !skyApi.state) return;

  const clock = document.querySelector("[data-sf-clock]");
  const clockTime = clock ? clock.querySelector("time") : null;
  const caption = document.querySelector("[data-sky-caption]");

  const timeFormat = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });

  const PHASES = {
    night: "Night over San Francisco",
    blue: "Blue hour over San Francisco",
    dawn: "Dawn over San Francisco",
    afterglow: "Afterglow over San Francisco",
    sunrise: "Sunrise over San Francisco",
    golden: "Golden hour over San Francisco",
    morning: "Morning in San Francisco",
    afternoon: "Afternoon in San Francisco",
  };

  function describe(state) {
    const parts = [PHASES[state.phase] || "San Francisco"];
    const nextEvent =
      state.nextSunset !== null &&
      (state.nextSunrise === null || state.nextSunset < state.nextSunrise)
        ? ["Sunset", state.nextSunset]
        : ["Sunrise", state.nextSunrise];
    if (nextEvent[1] !== null && !state.preview) {
      parts.push(`${nextEvent[0].toLowerCase()} at ${timeFormat.format(nextEvent[1])}`);
    }
    return `${state.preview ? "Preview" : "Live"}: ${parts.join(", ")}.`;
  }

  function render() {
    const state = skyApi.update();
    if (clock && clockTime) {
      const now = new Date(state.now);
      clockTime.dateTime = now.toISOString();
      clockTime.textContent = timeFormat.format(now);
      clock.hidden = false;
    }
    if (caption) {
      caption.textContent = describe(state);
      caption.hidden = false;
    }
  }

  render();

  // Re-render on the next minute boundary, then every minute after that.
  const msToNextMinute = 60000 - (Date.now() % 60000) + 50;
  window.setTimeout(() => {
    render();
    window.setInterval(render, 60000);
  }, msToNextMinute);
})();

/* =========================
   Scroll reveal
========================= */

(function reveal() {
  if (prefersReducedMotion || !("IntersectionObserver" in window)) return;
  const items = Array.from(document.querySelectorAll("[data-reveal]"));
  if (!items.length) return;

  // Anything already on screen stays put; only content below the fold animates.
  const fold = window.innerHeight;
  items.forEach((item) => {
    if (item.getBoundingClientRect().top < fold) item.classList.add("is-in");
  });
  document.documentElement.classList.add("reveal-armed");

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
  );
  items.forEach((item) => {
    if (!item.classList.contains("is-in")) observer.observe(item);
  });
})();

/* =========================
   Contact Form
========================= */

(function contactForm() {
  const form = document.getElementById("contact-form");
  if (!form) return;

  const statusEl = document.getElementById("contact-status");
  const submitBtn = form.querySelector('button[type="submit"]');

  const CONTACT_ENDPOINT =
    "https://8bijlmtfmi.execute-api.us-east-1.amazonaws.com/prod/contact";

  const MAX = { name: 100, email: 200, message: 5000 };
  let inFlight = false;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (inFlight) return;

    const formData = new FormData(form);

    // Honeypot: silently drop bot submissions that filled the hidden field.
    const honeypot = (formData.get("website") || "").toString();
    if (honeypot.trim() !== "") {
      statusEl.textContent = "Message sent.";
      form.reset();
      return;
    }

    const name = (formData.get("name") || "").toString().trim();
    const email = (formData.get("email") || "").toString().trim();
    const message = (formData.get("message") || "").toString().trim();

    if (!name || !email || !message) {
      statusEl.textContent = "Please fill out all fields.";
      return;
    }
    if (
      name.length > MAX.name ||
      email.length > MAX.email ||
      message.length > MAX.message
    ) {
      statusEl.textContent = "Input too long. Please shorten and try again.";
      return;
    }

    inFlight = true;
    if (submitBtn) submitBtn.disabled = true;
    statusEl.textContent = "Sending...";

    try {
      const res = await fetch(CONTACT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, message }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      form.reset();
      statusEl.textContent = "Message sent.";
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Something went wrong. Please try again.";
    } finally {
      inFlight = false;
      if (submitBtn) submitBtn.disabled = false;
    }
  });
})();
