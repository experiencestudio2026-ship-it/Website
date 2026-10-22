/*
 * Democracy & Space — the 3D project space.
 *
 * Every project (from projects/, via build.bat -> js/projects-data.js) is a
 * card floating in a 3D cloud. Cards always face the viewer and fade
 * with distance. The cloud rotates horizontally (drag / idle drift), cards can
 * be dragged to a new place, and clicking a card opens the project in a panel
 * over the space (URL: #<id>).
 */
(() => {
  // ---- Config -------------------------------------------------------------
  const CARD_SIZE = 230;          // longest side of a card, in px at zoom 1
  const CLOUD_SPACING = 300;      // distance between lattice points
  const CLOUD_JITTER = 80;        // random offset per card
  const FOCAL = 1000;             // perspective strength (lower = stronger)
  const CAMERA_DIST = 1500;       // camera distance from the center
  const PITCH = -0.18;            // fixed view angle (negative = slightly from above)
  const MIN_ZOOM = 0.3;
  const MAX_ZOOM = 3;
  const ROTATE_SPEED = 0.005;     // radians per px dragged sideways (horizontal only)
  const AUTO_SPIN = 0.04;         // radians per second while idle (0 = off)
  const IDLE_DELAY = 3000;        // ms without interaction before it drifts
  const FRICTION = 0.94;          // inertia decay per 16ms
  const FOG_FAR_OPACITY = 0.8;    // opacity of the farthest cards (1 = no fading)
  const FOG_RANGE = 650;          // depth over which cards fade
  const VIDEO_LOWRES_WIDTH = 80;  // pixels across for hero videos (lower = blockier)
  const SOUND_FADE = 0.0025;      // volume change per ms when the front video changes (1 / 400ms)
  const DRAG_THRESHOLD = 6;       // px moved before a press counts as a drag
  const FIT_WIDTH = 1000;         // screens narrower than this see the space smaller
  const FIT_HEIGHT = 700;         // same for screens lower than this
  const MIN_FIT = 0.5;            // smallest scale on very small screens (phones)
  const MOVED_KEY = "moved-cards";

  // ---- Elements -----------------------------------------------------------
  const world = document.getElementById("world");
  const cardLayer = document.getElementById("cards");
  const cursorLabel = document.getElementById("cursor-label");
  const centerTitle = document.getElementById("center-title");
  const panel = document.getElementById("panel");
  const panelContent = document.getElementById("panel-content");
  const searchInput = document.getElementById("search");
  const searchResults = document.getElementById("search-results");
  const indexList = document.getElementById("index-list");

  // ---- Helpers ------------------------------------------------------------
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // deterministic "random" 0..1 from a string: same layout on every visit
  const hash = (str, salt = 0) => {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 2246822519);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };

  // every video on the site: muted autoplay (the only kind phones allow),
  // endless loop, inline on iPhones instead of fullscreen
  const autoplayVideo = (src, extra = {}) => {
    const v = document.createElement("video");
    Object.assign(v, { src, muted: true, loop: true, autoplay: true, playsInline: true, ...extra });
    ["muted", "loop", "autoplay", "playsinline"].forEach((a) => v.setAttribute(a, ""));
    v.play().catch(() => {});
    return v;
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };

  // ---- Data ---------------------------------------------------------------
  const projects = (window.PROJECTS_DATA || []).map((d) => ({
    id: d.id,
    title: d.title || d.id,
    location: d.location || "",
    author: d.author || "",
    year: d.year || "",
    size: d.size || "",
    contributor: d.contributor || "",   // the student who wrote the entry (AUTHOR = who made the project)
    credits: d.credits || "",
    text: d.text || "",
    gallery: d.gallery || [],
    heroImage: d.heroImage || null,
    heroVideo: d.heroVideo || null,
    background: d.background || null,
    invert: d.invert !== false,
  }));
  const byId = new Map(projects.map((p) => [p.id, p]));
  const metaLine = (p) => [p.location, p.author, p.year, p.size].filter(Boolean).join(" · ");

  // ---- Cloud positions ----------------------------------------------------
  // a lattice of columns x levels x rows; each card takes a random free point
  // and a small random offset
  {
    const k = Math.cbrt(Math.max(projects.length, 1) * 3);
    const cols = Math.max(2, Math.round(k * 2));
    const levels = Math.max(1, Math.round(k));
    const rows = Math.max(1, Math.round(k));
    const free = [];
    for (let l = 0; l < levels; l++)
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          free.push({
            x: (c - (cols - 1) / 2) * CLOUD_SPACING,
            y: (l - (levels - 1) / 2) * CLOUD_SPACING,
            z: (r - (rows - 1) / 2) * CLOUD_SPACING,
          });
    projects.forEach((p) => {
      const slot = free.splice(Math.floor(hash(p.id, 1) * free.length), 1)[0] || { x: 0, y: 0, z: 0 };
      p.pos = {
        x: slot.x + (hash(p.id, 2) * 2 - 1) * CLOUD_JITTER,
        y: slot.y + (hash(p.id, 3) * 2 - 1) * CLOUD_JITTER,
        z: slot.z + (hash(p.id, 4) * 2 - 1) * CLOUD_JITTER,
      };
    });
  }

  // cards the visitor dragged somewhere else (kept in this browser)
  let moved = {};
  try { moved = JSON.parse(localStorage.getItem(MOVED_KEY)) || {}; } catch (_) {}
  projects.forEach((p) => {
    const saved = moved[p.id]?.cloud;
    if (saved) p.pos = { ...saved };
  });
  const saveMoved = () => {
    try { localStorage.setItem(MOVED_KEY, JSON.stringify(moved)); } catch (_) {}
  };

  // ---- State --------------------------------------------------------------
  const view = { yaw: 0, zoom: 1 };
  let tween = null;
  let spin = 0;                   // rotation speed after a drag, radians per ms
  let lastInteraction = -Infinity;
  let hovering = 0;
  let width = 0, height = 0;
  let fit = 1;                    // whole space scaled down to fit small screens
  let titleWidth = 0;             // natural width of the center title, in px
  let openId = null;

  // ---- 3D -> screen ---------------------------------------------------------
  function project(x, y, z) {
    const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
    const x1 = x * cy + z * sy;
    const z1 = z * cy - x * sy;
    const cp = Math.cos(PITCH), sp = Math.sin(PITCH);
    const y2 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;                // towards the camera = positive
    const s = (FOCAL / Math.max(CAMERA_DIST - z2, 1)) * view.zoom * fit;
    return { x: width / 2 + x1 * s, y: height / 2 + y2 * s, s, z: z2 };
  }

  // ---- Cards --------------------------------------------------------------
  // a card's size follows its image: longest side = CARD_SIZE
  function sizeCard(p, w, h) {
    if (!w || !h) return;
    const r = w / h;
    p.card.style.width = `${r >= 1 ? CARD_SIZE : CARD_SIZE * r}px`;
    p.card.style.height = `${r >= 1 ? CARD_SIZE / r : CARD_SIZE}px`;
  }

  // hero videos are shown low-res: frames drawn into a tiny canvas, scaled up
  function lowResCanvas(video) {
    const c = document.createElement("canvas");
    const g = c.getContext("2d");
    const paint = () => {
      if (video.readyState < 2 || !video.videoWidth) return;
      const w = VIDEO_LOWRES_WIDTH;
      const h = Math.max(1, Math.round((w * video.videoHeight) / video.videoWidth));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      g.drawImage(video, 0, 0, w, h);
    };
    // every animation frame, drawing only when the video moved on (not
    // requestVideoFrameCallback: Safari may never call it for a hidden video)
    let last = -1;
    const loop = () => {
      if (video.currentTime !== last) { last = video.currentTime; paint(); }
      requestAnimationFrame(loop);
    };
    video.addEventListener("loadeddata", paint);
    loop();
    return c;
  }

  projects.forEach((p) => {
    const card = el("a", p.invert ? "card" : "card card--no-invert");
    card.href = `#${encodeURIComponent(p.id)}`;
    card.setAttribute("aria-label", [p.title, metaLine(p)].filter(Boolean).join(", "));
    card.draggable = false;
    const media = el("span", "card__media");

    const imageSrc = p.heroImage || (p.gallery[0] && p.gallery[0].src);
    if (p.heroVideo) {
      const video = autoplayVideo(p.heroVideo);
      video.addEventListener("loadedmetadata", () => sizeCard(p, video.videoWidth, video.videoHeight));
      media.append(video, lowResCanvas(video));
      p.video = video;
    } else if (imageSrc) {
      const img = document.createElement("img");
      img.src = imageSrc;
      img.alt = "";
      img.draggable = false;
      img.addEventListener("load", () => sizeCard(p, img.naturalWidth, img.naturalHeight));
      media.append(img);
    }

    card.append(media);
    cardLayer.append(card);
    p.card = card;
    sizeCard(p, 4, 3);

    // title next to the cursor; the drift pauses so the card can be clicked
    // (mouse only: on touch screens there is no cursor to follow)
    card.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse") return;
      hovering++;
      // inline span, so every line of the title gets its own black bar
      cursorLabel.replaceChildren(el("span", "cursor-label__text", p.title));
      cursorLabel.classList.add("is-visible");
    });
    card.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      hovering = Math.max(0, hovering - 1);
      cursorLabel.classList.remove("is-visible");
    });

    // pressing a card starts moving that card instead of rotating the space;
    // on touch screens a finger on a card still rotates / pinches the space
    // (cards cover much of a small screen) and a tap opens it
    card.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.stopPropagation();
      spin = 0;
      tween = null;
      lastInteraction = performance.now();
      cardDrag = { p, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      Object.assign(drag, { distance: 0, suppressClick: false });
      world.classList.add("is-dragging");
    });
  });

  window.addEventListener("pointermove", (e) => {
    cursorLabel.style.transform = `translate(${e.clientX + 16}px, ${e.clientY + 14}px)`;
  });

  function placeCards() {
    // the title sits at the center of rotation, above every card;
    // its size ignores zoom, so it always stays the same size on screen,
    // and it never gets wider than the screen
    const c = project(0, 0, 0);
    let titleScale = c.s / view.zoom;
    if (titleWidth) titleScale = Math.min(titleScale, (width * 0.9) / titleWidth);
    const titleTransform = `translate(${c.x}px, ${c.y}px) scale(${titleScale}) translate(-50%, -50%)`;
    centerTitle.style.transform = titleTransform;
    centerTitle.style.zIndex = "30000";

    projects.forEach((p) => {
      const pr = project(p.pos.x, p.pos.y, p.pos.z);
      p.depth = pr.z;                              // used to find the closest video
      p.card.style.transform =
        `translate(${pr.x}px, ${pr.y}px) scale(${pr.s}) translate(-50%, -50%)`;
      p.card.style.zIndex = String(Math.round(10000 + pr.z));
      // fog: farther cards fade into the background
      const near = clamp((pr.z + FOG_RANGE) / (2 * FOG_RANGE), 0, 1);
      p.card.style.opacity = (FOG_FAR_OPACITY + (1 - FOG_FAR_OPACITY) * near).toFixed(3);
    });
  }

  // ---- Sound: only the video closest to the viewer is heard ---------------------
  // Browsers only allow sound after the visitor interacted with the page,
  // so it starts with the first click / tap / key press (on touch screens
  // only the end of a touch counts as an interaction).
  //
  // Each card video is unmuted once, inside that first interaction, and its
  // sound runs through a Web Audio gain that fades it in and out. Toggling
  // `muted` later (outside a tap) does not work on iPhones: Safari ignores
  // `volume` and pauses a video that gets unmuted without a tap.
  // Fallback (no Web Audio, or opened as a local file, where Web Audio would
  // stay silent): fade with `volume` / `muted` as before.
  const videos = projects.filter((p) => p.video);
  let soundAllowed = false;
  let audioCtx = null;

  // resume() / suspend() return a promise only in newer browsers (old Safari: nothing)
  const ctxCall = (method) => {
    try { Promise.resolve(audioCtx && audioCtx[method]()).catch(() => {}); } catch (_) {}
  };

  const allowSound = () => {
    if (soundAllowed || !videos.length) return;
    soundAllowed = true;
    // iPhone (iOS 17+): play through the silent switch like normal video sound,
    // instead of the Web Audio default, which the switch mutes
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (_) {}
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && location.protocol !== "file:") {
      try { audioCtx = new AC(); } catch (_) { audioCtx = null; }
    }
    videos.forEach((p) => {
      if (audioCtx) {
        try {
          const gain = audioCtx.createGain();
          gain.gain.value = 0;
          const source = audioCtx.createMediaElementSource(p.video);
          source.connect(gain);                    // not chained: old Safari's connect() returns nothing
          gain.connect(audioCtx.destination);
          p.gain = gain;
          p.video.muted = false;                   // silent until its gain fades in
        } catch (_) { p.gain = null; }
      }
      if (!p.gain) p.video.volume = 0;
      p.video.play().catch(() => {});
    });
    ctxCall("resume");
  };
  // only events every browser counts as a real interaction (Safari does not count
  // pointerup); capture, so a click that ends a drag still unlocks the sound
  window.addEventListener("click", allowSound, { capture: true });
  ["touchend", "keydown"].forEach((type) =>
    window.addEventListener(type, allowSound, { passive: true, capture: true }));

  // a hidden tab stops the animation loop, so silence everything right away
  function silenceVideos() {
    ctxCall("suspend");
    videos.forEach((p) => { if (!p.gain) p.video.muted = true; });
  }

  // keep every video running: the cards always, the project's own videos while it
  // is open. Phones in power-saving mode only start videos after a first tap, and
  // browsers pause them in background tabs - so try again on both occasions.
  function resumeVideos(withPanel = true) {
    // iPhones interrupt the audio (calls, other apps); a tap brings it back
    if (audioCtx && audioCtx.state !== "running") ctxCall("resume");
    const panelVideos = openId && withPanel ? [...panelContent.querySelectorAll("video")] : [];
    [...videos.map((p) => p.video), ...panelVideos].forEach((v) => {
      if (v.paused) v.play().catch(() => {});
    });
  }
  // on a tap only the cards: a tap on a project video's pause button must stay paused
  ["pointerup", "touchend"].forEach((type) =>
    window.addEventListener(type, () => resumeVideos(false), { passive: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { silenceVideos(); return; }
    resumeVideos();
  });

  function updateSound(dt) {
    if (!soundAllowed || !videos.length) return;
    // the front video, unless a project is open (then the space is quiet)
    const audible = videos.filter((p) => !p.card.classList.contains("is-hidden"));
    const closest = openId ? null
      : audible.reduce((best, p) => (!best || p.depth > best.depth ? p : best), null);
    const step = SOUND_FADE * dt;

    videos.forEach((p) => {
      const target = p === closest ? 1 : 0;
      if (p.gain) {
        const g = p.gain.gain;
        g.value = target > g.value ? Math.min(target, g.value + step) : Math.max(target, g.value - step);
        return;
      }
      const v = p.video;
      const before = v.volume;
      v.volume = target > before ? Math.min(target, before + step) : Math.max(target, before - step);
      // some browsers (iOS) ignore volume: then switch with mute alone
      const volumeIgnored = v.volume === before && before !== target;
      v.muted = target === 0 && (v.volume <= 0.01 || volumeIgnored);
    });
  }

  // ---- Moving a card ------------------------------------------------------------
  // the card moves in the plane facing the camera, at its current depth
  let cardDrag = null;

  function moveCard(dx, dy) {
    const p = cardDrag.p;
    const s = project(p.pos.x, p.pos.y, p.pos.z).s;
    const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
    const cp = Math.cos(PITCH), sp = Math.sin(PITCH);
    // screen right and screen down, as directions in the 3D space
    const right = { x: cy, y: 0, z: sy };
    const down = { x: sp * sy, y: cp, z: -sp * cy };
    const mx = dx / s, my = dy / s;
    p.pos = {
      x: p.pos.x + right.x * mx + down.x * my,
      y: p.pos.y + right.y * mx + down.y * my,
      z: p.pos.z + right.z * mx + down.z * my,
    };
  }

  function endCardDrag() {
    const p = cardDrag.p;
    cardDrag = null;
    world.classList.remove("is-dragging");
    if (drag.distance > DRAG_THRESHOLD) {
      moved[p.id] = { cloud: { ...p.pos } };
      saveMoved();
    }
  }

  // put all cards back where they started (key R)
  function resetMoved() {
    moved = {};
    saveMoved();
    location.reload();
  }

  // ---- Camera -------------------------------------------------------------------
  function animateTo(to, duration = 600) {
    spin = 0;
    const from = {};
    for (const key of Object.keys(to)) from[key] = view[key];
    tween = { from, to, t: 0, duration };
    lastInteraction = performance.now();
  }

  function recenter() {
    view.yaw = Math.atan2(Math.sin(view.yaw), Math.cos(view.yaw)); // shortest way round
    animateTo({ yaw: 0, zoom: 1 });
  }

  // ---- Animation loop -------------------------------------------------------
  let lastTime = 0;

  function frame(time) {
    const dt = lastTime ? Math.min(time - lastTime, 50) : 16;
    lastTime = time;

    if (tween) {
      tween.t = Math.min(tween.t + dt, tween.duration);
      const e = easeInOut(tween.t / tween.duration);
      for (const key of Object.keys(tween.to)) view[key] = lerp(tween.from[key], tween.to[key], e);
      if (tween.t >= tween.duration) tween = null;
    } else if (!drag.active && !cardDrag) {
      if (Math.abs(spin) > 0.00001) {
        view.yaw += spin * dt;                     // inertia after a drag
        spin *= Math.pow(FRICTION, dt / 16);
      } else if (AUTO_SPIN && !hovering && time - lastInteraction > IDLE_DELAY) {
        view.yaw += (AUTO_SPIN * dt) / 1000;       // slow drift when idle
      }
    }

    placeCards();
    updateSound(dt);
    requestAnimationFrame(frame);
  }

  // ---- Dragging: rotate horizontally, pinch to zoom ---------------------------
  const pointers = new Map();
  const drag = { active: false, distance: 0, samples: [], suppressClick: false };

  world.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    spin = 0;
    tween = null;
    lastInteraction = performance.now();
    if (pointers.size === 1) {
      Object.assign(drag, { active: true, distance: 0, samples: [], suppressClick: false });
    }
    world.classList.add("is-dragging");
  });

  // on window, so the drag continues outside; no pointer capture (it would
  // keep clicks from reaching the cards)
  window.addEventListener("pointermove", (e) => {
    if (cardDrag && e.pointerId === cardDrag.pointerId) {
      const dx = e.clientX - cardDrag.x, dy = e.clientY - cardDrag.y;
      cardDrag.x = e.clientX;
      cardDrag.y = e.clientY;
      moveCard(dx, dy);
      drag.distance += Math.hypot(dx, dy);
      if (drag.distance > DRAG_THRESHOLD) drag.suppressClick = true;
      lastInteraction = performance.now();
      return;
    }

    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    lastInteraction = performance.now();

    if (pointers.size === 1) {
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      view.yaw += dx * ROTATE_SPEED;               // horizontal rotation only
      drag.distance += Math.hypot(dx, dy);
      drag.samples.push({ dx, t: e.timeStamp });
      if (drag.samples.length > 8) drag.samples.shift();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    } else if (pointers.size === 2) {
      const before = [...pointers.values()];
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const after = [...pointers.values()];
      const dist = (pts) => Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      view.zoom = clamp(view.zoom * (dist(after) / dist(before)), MIN_ZOOM, MAX_ZOOM);
      drag.distance += DRAG_THRESHOLD;
      drag.samples = [];
    }
    if (drag.distance > DRAG_THRESHOLD) drag.suppressClick = true;
  });

  function endPointer(e) {
    if (cardDrag && e.pointerId === cardDrag.pointerId) {
      endCardDrag();
      return;
    }
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size > 0) { drag.samples = []; return; }
    drag.active = false;
    world.classList.remove("is-dragging");
    const recent = drag.samples.filter((s) => e.timeStamp - s.t < 100);
    if (recent.length >= 2) {
      const span = Math.max(e.timeStamp - recent[0].t, 16);
      spin = (recent.reduce((a, s) => a + s.dx, 0) / span) * ROTATE_SPEED;
    }
  }
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);

  // a drag that ends on a card must not open it
  world.addEventListener("click", (e) => {
    if (drag.suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      drag.suppressClick = false;
    }
  }, true);
  world.addEventListener("dragstart", (e) => e.preventDefault());

  world.addEventListener("wheel", (e) => {
    e.preventDefault();
    tween = null;
    lastInteraction = performance.now();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height : 1;
    view.zoom = clamp(view.zoom * Math.exp(-e.deltaY * unit * 0.0015), MIN_ZOOM, MAX_ZOOM);
  }, { passive: false });

  // ---- Black circle instead of a scrollbar --------------------------------------
  // sits on the right edge of a scrolling element and moves down as it scrolls;
  // hidden when there is nothing to scroll. Returns a function to re-measure.
  const DOT = 22;
  function scrollDot(scroller) {
    const dot = el("div", "scroll-dot");
    dot.setAttribute("aria-hidden", "true");
    scroller.parentElement.append(dot);   // parent must be positioned
    const update = () => {
      const range = scroller.scrollHeight - scroller.clientHeight;
      dot.hidden = range <= 1 || scroller.offsetParent === null;
      if (dot.hidden) return;
      const progress = scroller.scrollTop / range;
      dot.style.left = `${scroller.offsetLeft + scroller.offsetWidth - DOT - 6}px`;
      dot.style.top = `${scroller.offsetTop + 6 + progress * (scroller.clientHeight - DOT - 12)}px`;
    };
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    return update;
  }

  const updatePanelDot = scrollDot(panelContent);
  const updateSearchDot = scrollDot(searchResults);

  // ---- Project panel (URL #<id>) ----------------------------------------------
  function buildPanel(p) {
    panelContent.replaceChildren();
    const meta = metaLine(p);
    if (meta) panelContent.append(el("p", "project__meta", meta));
    const title = el("h1", "project__title", p.title);
    title.id = "panel-title";
    panelContent.append(title);

    const body = el("div", "project__body");
    const text = el("div", "project__text");
    p.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
      .forEach((par) => text.append(el("p", null, par)));
    if (p.contributor) text.append(el("p", "project__credits", `Contributed by: ${p.contributor}`));
    if (p.credits) text.append(el("p", "project__credits", `Photography by: ${p.credits}`));

    const media = el("div", "project__media");
    const video = p.background || p.heroVideo;
    if (video) {
      const v = autoplayVideo(video, { controls: true });   // controls: visitors can turn the sound on
      v.addEventListener("loadedmetadata", updatePanelDot);
      const fig = el("figure", "project__figure");
      fig.append(v);
      media.append(fig);
    }
    const images = p.gallery.length ? p.gallery : p.heroImage ? [{ src: p.heroImage, caption: "" }] : [];
    images.forEach((item) => {
      const fig = el("figure", "project__figure");
      if (/\.(mp4|webm)$/i.test(item.src)) {
        // a numbered video in the gallery: plays muted in a loop, controls turn the sound on
        const v = autoplayVideo(item.src, { controls: true });
        v.addEventListener("loadedmetadata", updatePanelDot);
        fig.append(v);
      } else {
        const img = document.createElement("img");
        img.src = item.src;
        img.alt = item.caption || p.title;
        img.loading = "lazy";
        img.addEventListener("load", updatePanelDot);   // content got taller
        fig.append(img);
      }
      if (item.caption) fig.append(el("figcaption", "project__caption", item.caption));
      media.append(fig);
    });

    body.append(text, media);
    panelContent.append(body);
    panelContent.scrollTop = 0;
    updatePanelDot();
  }

  function openPanel(p) {
    if (openId !== p.id) buildPanel(p);
    openId = p.id;
    resumeVideos();                               // reopened: its videos were paused on close
    document.title = `${p.title} — Democracy & Space`;
    panel.classList.add("is-open");
    panel.setAttribute("aria-hidden", "false");
    projects.forEach((q) => q.card.classList.toggle("is-active", q === p));
    closeMenus();
    // turn the cloud so the opened card is in front
    const target = -Math.atan2(p.pos.x, p.pos.z);
    const delta = Math.atan2(Math.sin(target - view.yaw), Math.cos(target - view.yaw));
    animateTo({ yaw: view.yaw + delta }, 900);
  }

  function closePanel() {
    if (!openId) return;
    openId = null;
    document.title = "Democracy & Space";
    panel.classList.remove("is-open");
    panel.setAttribute("aria-hidden", "true");
    projects.forEach((q) => q.card.classList.remove("is-active"));
    panelContent.querySelectorAll("video").forEach((v) => v.pause());
  }

  function route() {
    const id = decodeURIComponent(location.hash.slice(1));
    const p = byId.get(id);
    if (p) openPanel(p);
    else closePanel();
  }
  window.addEventListener("hashchange", route);

  // close button, Escape, or a tap on the space next to the panel: close directly
  // (not only through a hash change) and drop the #id from the address
  function requestClose() {
    if (!openId) return;
    if (location.hash) history.pushState(null, "", location.pathname + location.search);
    closePanel();
  }
  document.getElementById("panel-close").addEventListener("click", requestClose);
  world.addEventListener("click", (e) => {
    if (openId && !e.target.closest(".card")) requestClose();
  });

  // ---- Menus (About, Index) ---------------------------------------------------
  const menuButtons = [...document.querySelectorAll("[data-menu]")];
  function closeMenus() {
    menuButtons.forEach((b) => {
      b.setAttribute("aria-expanded", "false");
      document.getElementById(`menu-${b.dataset.menu}`).hidden = true;
    });
  }
  menuButtons.forEach((b) => b.addEventListener("click", () => {
    const open = b.getAttribute("aria-expanded") !== "true";
    closeMenus();
    if (open) {
      b.setAttribute("aria-expanded", "true");
      document.getElementById(`menu-${b.dataset.menu}`).hidden = false;
    }
  }));

  const resultItem = (p) => {
    const li = el("li");
    const a = el("a", null, p.title);
    a.href = `#${encodeURIComponent(p.id)}`;
    li.append(a);
    const meta = metaLine(p);
    if (meta) li.append(el("span", "result__meta", ` — ${meta}`));
    return li;
  };
  [...projects].sort((a, b) => a.title.localeCompare(b.title))
    .forEach((p) => indexList.append(resultItem(p)));

  // image credits in the Impressum, from CREDITS: in each _info.txt
  const creditsList = document.getElementById("credits-list");
  [...projects].filter((p) => p.credits).sort((a, b) => a.title.localeCompare(b.title))
    .forEach((p) => creditsList.append(el("li", null, `${p.title}: photography by ${p.credits}`)));

  // ---- Search ("*" lists everything) -------------------------------------------
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    searchResults.replaceChildren();
    if (!q) {
      projects.forEach((p) => p.card.classList.remove("is-hidden"));
      return;
    }
    const matches = projects.filter((p) => q === "*" ||
      [p.title, p.location, p.author, p.contributor, p.year, p.text].join(" ").toLowerCase().includes(q));
    projects.forEach((p) => p.card.classList.toggle("is-hidden", !matches.includes(p)));
    if (!matches.length) searchResults.append(el("li", "result__meta", "nothing found"));
    matches.forEach((p) => searchResults.append(resultItem(p)));
    updateSearchDot();
  });

  // ---- Keyboard -----------------------------------------------------------------
  window.addEventListener("keydown", (e) => {
    if (e.target === searchInput) {
      if (e.key === "Escape") searchInput.blur();
      return;
    }
    if (e.key === "Escape") {
      requestClose();
      closeMenus();
      return;
    }
    if (openId) return;   // panel open: keys scroll the panel
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      animateTo({ yaw: view.yaw + (e.key === "ArrowLeft" ? 0.35 : -0.35) }, 300);
    } else if (e.key === "+" || e.key === "=") {
      animateTo({ zoom: clamp(view.zoom * 1.25, MIN_ZOOM, MAX_ZOOM) }, 250);
    } else if (e.key === "-" || e.key === "_") {
      animateTo({ zoom: clamp(view.zoom / 1.25, MIN_ZOOM, MAX_ZOOM) }, 250);
    } else if (e.key === "0" || e.key === "Home") {
      recenter();
    } else if (e.key === "r" || e.key === "R") {
      resetMoved();
    }
  });

  // ---- Clock under the center title: yyyy.mm.dd.hh.mm.ss ---------------------
  const clocks = document.querySelectorAll(".center-title__time");
  const two = (n) => String(n).padStart(2, "0");
  function tick() {
    const d = new Date();
    const text = [d.getFullYear(), two(d.getMonth() + 1), two(d.getDate()),
      two(d.getHours()), two(d.getMinutes()), two(d.getSeconds())].join(".");
    clocks.forEach((c) => { c.textContent = text; });
  }
  tick();
  setInterval(tick, 1000);

  // ---- Init ---------------------------------------------------------------------
  function resize() {
    width = world.clientWidth;
    height = world.clientHeight;
    fit = clamp(Math.min(width / FIT_WIDTH, height / FIT_HEIGHT), MIN_FIT, 1);
    titleWidth = centerTitle.offsetWidth;          // layout width, ignores the transform
  }
  resize();
  window.addEventListener("resize", resize);
  document.fonts?.ready.then(resize);              // the title font changes its width

  route();
  world.focus({ preventScroll: true });
  requestAnimationFrame(frame);
})();
