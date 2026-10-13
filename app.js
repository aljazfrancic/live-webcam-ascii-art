/*
 * ASCII Cam: live webcam ASCII art in the browser.
 * Zero dependencies. Every frame is processed locally; nothing ever leaves the device.
 *
 * Per frame:
 *   source (camera / demo / frozen frame)
 *     → drawImage into a tiny sampler canvas (1 px per cell, 2×4 px per cell for Braille)
 *     → luma, temporal smoothing, auto levels and a tone curve, folded into lookup tables
 *     → one glyph index + one colour per cell, packed as RGBA
 *     → WebGL: a single full-screen draw call samples a glyph atlas texture
 *       Canvas 2D fallback: glyphs composited in JS, one putImageData per frame
 */
(() => {
  "use strict";

  // ---- Character sets (each ramp is re-sorted by measured ink coverage) ----
  const CHARSETS = {
    classic:  { label: "Classic",  sample: ".:-=+*#%@", chars: " .:-=+*#%@" },
    detailed: { label: "Detailed", sample: "$@B%8&WM#*", chars: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$" },
    blocks:   { label: "Blocks",   sample: "░▒▓█", chars: " ░▒▓█", stretch: true },
    braille:  { label: "Braille",  sample: "⣿⣷⣦⣄⡀", braille: true },
    binary:   { label: "Binary",   sample: "010110", chars: " 01" },
    custom:   { label: "Custom",   sample: "your own" },
  };
  const CHARSET_KEYS = Object.keys(CHARSETS);
  const EDGE_CHARS = ["|", "/", "-", "\\"]; // indexed by gradient direction, see traceEdges()

  // ---- Palettes: a fixed ink colour, the camera's own colours, or a gradient by brightness ----
  const PALETTES = {
    phosphor: { label: "Phosphor",   bg: "#020805", fg: "#5dff9a" },
    amber:    { label: "Amber",      bg: "#0b0602", fg: "#ffb340" },
    ice:      { label: "Ice",        bg: "#02070b", fg: "#7fdcff" },
    mono:     { label: "Mono",       bg: "#0a0a0a", fg: "#f2f0ea" },
    paper:    { label: "Paper",      bg: "#f2ede1", fg: "#1f1d19", light: true, accent: "#f2ede1" },
    color:    { label: "True color", bg: "#000000", mode: "source", accent: "#d7a8ff" },
    thermal:  { label: "Thermal",    bg: "#000000", mode: "gradient", accent: "#ff9d3d", stops: ["#1b0536", "#6a1180", "#c92d5d", "#f76b2c", "#fdc040", "#fffbd0"] },
    synth:    { label: "Synthwave",  bg: "#07020f", mode: "gradient", accent: "#ff4fc1", stops: ["#2c0a5a", "#8a1fb5", "#ff2fa0", "#ff9d5c", "#60f3ff"] },
  };
  const PALETTE_KEYS = Object.keys(PALETTES);

  const DEFAULTS = Object.freeze({
    charset: "classic",
    custom: " .:-=+*oO#@",
    palette: "phosphor",
    detail: 0,          // columns; 0 = pick from the screen size
    brightness: 0,      // -100 … 100
    contrast: 0,        // -100 … 100
    autoLevels: true,
    smooth: true,
    invert: false,
    mirror: true,
    edges: false,
    stats: false,
    fps: 30,
    camera: "",         // preferred deviceId
  });

  const DETAIL_MIN = 24;
  const DETAIL_MAX = 320;
  const FPS_CHOICES = [12, 24, 30, 60];
  const DEMO_FPS = 30;
  const CHAR_ASPECT = 0.6;              // monospace cell width / height
  const MIN_CELL_H = 5;                 // device pixels
  const MAX_CELL_H = 120;
  const MAX_DPR = 2;                    // beyond 2× the extra pixels cost more than they show
  const MAX_CANVAS_PIXELS = 3840 * 2160;
  const SMOOTHING = 0.5;                // weight of the newest frame in the temporal average
  const LEVELS_EASE = 0.15;
  const MIN_LEVELS_RANGE = 56;          // stops auto levels from amplifying sensor noise in flat scenes
  const EDGE_THRESHOLD = 170;           // Sobel magnitude on the 0–255 ink scale
  const SNAPSHOT_TARGET = 2400;         // snapshots are re-rendered to roughly this long side
  const REC_MAX_MS = 60000;
  const STORE_KEY = "ascii-cam:v2";
  const IDLE_HINT = "Your video never leaves this device.";
  const GLYPH_FONT = 'ui-monospace, Menlo, Consolas, "Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono", "Roboto Mono", monospace';

  // Braille cells are 2×4 dots: [column, row, bit] in Unicode dot order.
  const BRAILLE_DOTS = [
    [0, 0, 0x01], [0, 1, 0x02], [0, 2, 0x04], [1, 0, 0x08],
    [1, 1, 0x10], [1, 2, 0x20], [0, 3, 0x40], [1, 3, 0x80],
  ];
  // 4×4 ordered-dither thresholds on the 0–255 ink scale.
  const BAYER = Uint8Array.from([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5], (v) => v * 16 + 8);

  // ---- Helpers ----
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const params = new URLSearchParams(location.search);

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  function onMediaChange(query, fn) {
    if (query.addEventListener) query.addEventListener("change", fn);
    else if (query.addListener) query.addListener(fn);
  }

  // Unique, printable characters; Array.from keeps astral symbols (emoji) whole.
  function cleanChars(value) {
    const out = [];
    for (const ch of Array.from(String(value || ""))) {
      const cp = ch.codePointAt(0);
      if (cp < 32 || (cp >= 0x7f && cp < 0xa0) || out.includes(ch)) continue;
      out.push(ch);
      if (out.length >= 64) break;
    }
    return out.join("");
  }

  // ---- Settings (persisted per browser; storage may be unavailable) ----
  function loadSettings() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(STORE_KEY));
    } catch {
      raw = null;
    }
    const s = { ...DEFAULTS };
    if (raw && typeof raw === "object") {
      for (const key of Object.keys(DEFAULTS)) {
        if (typeof raw[key] === typeof DEFAULTS[key]) s[key] = raw[key];
      }
    }
    if (!has(CHARSETS, s.charset)) s.charset = DEFAULTS.charset;
    if (!has(PALETTES, s.palette)) s.palette = DEFAULTS.palette;
    s.custom = cleanChars(s.custom) || DEFAULTS.custom;
    s.detail = s.detail ? clamp(Math.round(s.detail) || 0, DETAIL_MIN, DETAIL_MAX) : 0;
    s.brightness = clamp(Math.round(s.brightness) || 0, -100, 100);
    s.contrast = clamp(Math.round(s.contrast) || 0, -100, 100);
    if (!FPS_CHOICES.includes(s.fps)) s.fps = DEFAULTS.fps;
    return s;
  }

  const settings = loadSettings();
  let saveTimer = 0;

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSettings, 300);
  }

  function flushSettings() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    } catch {
      // Private mode or storage disabled: settings simply won't persist.
    }
  }

  // ---- DOM ----
  const root = document.documentElement;
  const app = $("app");
  const stage = $("stage");
  let canvas = $("screen");
  const video = $("cam");
  const hint = $("hint");
  const hintText = $("hint-text");
  const kbdHint = $("kbd-hint");
  const statusEl = $("status");
  const statsEl = $("stats");
  const flashEl = $("flash");
  const toastEl = $("toast");
  const notice = $("notice");
  const noticeTitle = $("notice-title");
  const noticeText = $("notice-text");
  const noticeRetry = $("notice-retry");
  const noticeClose = $("notice-close");
  const btnMain = $("btn-main");
  const mainLabel = $("main-label");
  const btnPause = $("btn-pause");
  const pauseIcon = $("pause-icon");
  const btnStop = $("btn-stop");
  const btnFlip = $("btn-flip");
  const btnSettings = $("btn-settings");
  const btnCopy = $("btn-copy");
  const btnRecord = $("btn-record");
  const recIcon = $("rec-icon");
  const btnFullscreen = $("btn-fullscreen");
  const fsIcon = $("fs-icon");
  const btnHelp = $("btn-help");
  const panel = $("panel");
  const btnPanelClose = $("btn-panel-close");
  const charsetGroup = $("charset-group");
  const paletteGroup = $("palette-group");
  const fpsGroup = $("fps-group");
  const customField = $("custom-field");
  const customInput = $("custom-chars");
  const detailIn = $("detail");
  const detailOut = $("detail-out");
  const brightnessIn = $("brightness");
  const brightnessOut = $("brightness-out");
  const contrastIn = $("contrast");
  const contrastOut = $("contrast-out");
  const switches = {
    autoLevels: $("auto-levels"),
    smooth: $("smooth"),
    invert: $("invert"),
    mirror: $("mirror"),
    edges: $("edges"),
    stats: $("show-stats"),
  };
  const edgesSwitch = $("edges-switch");
  const cameraField = $("camera-field");
  const cameraSelect = $("camera-select");
  const btnReset = $("btn-reset");
  const help = $("help");
  const helpClose = $("help-close");

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const coarsePointer = matchMedia("(pointer: coarse)");

  // ---- Runtime state ----
  let state = "idle"; // idle (demo) | starting | live | paused
  let palette = PALETTES[settings.palette];
  let renderer = null;
  let atlas = null;
  let srcW = 0;
  let srcH = 0;
  const layout = { cols: 0, rows: 0, cw: 0, ch: 0, offX: 0, offY: 0 };
  const frame = {
    cols: 0, rows: 0, cw: 0, ch: 0, offX: 0, offY: 0,
    cells: new Uint8Array(0),
    useColor: false,
    fg: [1, 1, 1], bg: [0, 0, 0], fg255: [255, 255, 255], bg255: [0, 0, 0], fgCss: "#ffffff", bgCss: "#000000",
  };
  // What is on screen right now, for copy-as-text and snapshots.
  const shown = { cols: 0, rows: 0, atlas: null, frame: null };
  const cam = { stream: null, token: 0, busy: false, deviceId: "", facing: "", devices: [] };
  const frozen = document.createElement("canvas");

  // ---------------------------------------------------------------------------
  // Glyph atlas: every glyph drawn once into a 16-column grid of equal cells
  // ---------------------------------------------------------------------------
  const measureCtx = document.createElement("canvas").getContext("2d");
  const calibrations = new Map();

  function rampChars() {
    const set = CHARSETS[settings.charset];
    const chars = Array.from(new Set(Array.from(set.chars != null ? set.chars : settings.custom)));
    if (chars.length < 2) chars.unshift(chars[0] === " " ? "." : " ");
    return chars;
  }

  // Union of all glyph ink boxes at 100px, relative to (advance centre, baseline).
  function glyphBox(chars, weight) {
    const ctx = measureCtx;
    ctx.font = `${weight} 100px ${GLYPH_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    let half = 0, up = -Infinity, down = -Infinity;
    for (const ch of chars) {
      const m = ctx.measureText(ch);
      const l = m.actualBoundingBoxLeft || 0, r = m.actualBoundingBoxRight || 0;
      const a = m.actualBoundingBoxAscent || 0, d = m.actualBoundingBoxDescent || 0;
      if (l + r < 1 || a + d < 1) continue; // blank
      half = Math.max(half, l, r);
      up = Math.max(up, a);
      down = Math.max(down, d);
    }
    if (!half || up + down < 1) return { half: 30, up: 75, down: 22 };
    return { half, up, down };
  }

  function paintGlyphs(ctx, chars, cw, ch, weight, box, stretch) {
    const height = box.up + box.down;
    let sx = cw / (2 * box.half);
    let sy = ch / height;
    if (!stretch) sx = sy = Math.min(sx, sy) * 0.96;
    const baseline = Math.round((ch - height * sy) / 2 + box.up * sy);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = `${weight} ${stretch ? 100 : (100 * sx).toFixed(2)}px ${GLYPH_FONT}`;
    for (let i = 0; i < chars.length; i++) {
      const x = (i & 15) * cw, y = (i >> 4) * ch;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, cw, ch);
      ctx.clip();
      if (stretch) {
        ctx.setTransform(sx, 0, 0, sy, x + cw / 2, y + baseline);
        ctx.fillText(chars[i], 0, 0);
      } else {
        ctx.fillText(chars[i], x + cw / 2, y + baseline);
      }
      ctx.restore();
    }
  }

  function paintBraille(ctx, cw, ch) {
    ctx.fillStyle = "#fff";
    const r = Math.max(0.6, Math.min(cw * 0.17, ch * 0.1));
    const xs = [cw * 0.3, cw * 0.7];
    const ys = [0.125, 0.375, 0.625, 0.875].map((f) => ch * f);
    for (let g = 1; g < 256; g++) {
      const x0 = (g & 15) * cw, y0 = (g >> 4) * ch;
      ctx.beginPath();
      for (const [col, row, bit] of BRAILLE_DOTS) {
        if (!(g & bit)) continue;
        ctx.moveTo(x0 + xs[col] + r, y0 + ys[row]);
        ctx.arc(x0 + xs[col], y0 + ys[row], r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  // Measures how much ink each glyph really puts on screen in this browser's font,
  // then builds ink (0–255) → glyph. Ramps no longer depend on a hand-tuned order.
  function calibrate(chars, weight, stretch) {
    const key = `${weight}|${stretch ? 1 : 0}|${chars.join("")}`;
    let cal = calibrations.get(key);
    if (cal) return cal;
    const cw = 24, ch = 40, n = chars.length;
    const cv = document.createElement("canvas");
    cv.width = 16 * cw;
    cv.height = Math.ceil(n / 16) * ch;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    const box = glyphBox(chars, weight);
    paintGlyphs(ctx, chars, cw, ch, weight, box, stretch);
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const cover = new Float32Array(n);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const x0 = (i & 15) * cw, y0 = (i >> 4) * ch;
      let sum = 0;
      for (let y = y0; y < y0 + ch; y++) {
        for (let p = (y * cv.width + x0) * 4 + 3, end = p + cw * 4; p < end; p += 4) sum += px[p];
      }
      cover[i] = sum / (cw * ch * 255);
      lo = Math.min(lo, cover[i]);
      hi = Math.max(hi, cover[i]);
    }
    // Blend coverage with rank so every glyph gets a share of the tonal range
    // while dense glyphs still land on bright tones.
    const order = Array.from(cover.keys()).sort((a, b) => cover[a] - cover[b]);
    const pos = new Float32Array(n);
    order.forEach((g, rank) => {
      pos[g] = 0.5 * ((cover[g] - lo) / (hi - lo || 1)) + 0.5 * (rank / (n - 1 || 1));
    });
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      const target = v / 255;
      let best = order[0], err = Infinity;
      for (let i = 0; i < n; i++) {
        const e = Math.abs(pos[i] - target);
        if (e < err) { err = e; best = i; }
      }
      lut[v] = best;
    }
    cal = { box, cover, lut };
    if (calibrations.size > 32) calibrations.clear();
    calibrations.set(key, cal);
    return cal;
  }

  function buildAtlas(cw, ch, weight) {
    const set = CHARSETS[settings.charset];
    const canvasEl = document.createElement("canvas");
    let chars, lut = null, edgeBase = -1, blank;
    if (set.braille) {
      chars = Array.from({ length: 256 }, (_, g) => String.fromCharCode(0x2800 + g));
      blank = new Uint8Array(256);
      blank[0] = 1;
      canvasEl.width = 16 * cw;
      canvasEl.height = 16 * ch;
      paintBraille(canvasEl.getContext("2d"), cw, ch);
    } else {
      const ramp = rampChars();
      chars = ramp.concat(EDGE_CHARS);
      edgeBase = ramp.length;
      const cal = calibrate(ramp, weight, !!set.stretch);
      lut = cal.lut;
      blank = new Uint8Array(chars.length);
      for (let i = 0; i < ramp.length; i++) blank[i] = cal.cover[i] < 0.002 ? 1 : 0;
      canvasEl.width = 16 * cw;
      canvasEl.height = Math.ceil(chars.length / 16) * ch;
      paintGlyphs(canvasEl.getContext("2d"), chars, cw, ch, weight, cal.box, !!set.stretch);
    }
    return { canvas: canvasEl, cw, ch, chars, blank, lut, edgeBase, braille: !!set.braille, weight, key: "" };
  }

  function ensureAtlas() {
    const key = `${settings.charset}\u0000${settings.charset === "custom" ? settings.custom : ""}\u0000${layout.cw}x${layout.ch}`;
    if (atlas && atlas.key === key) return;
    atlas = buildAtlas(layout.cw, layout.ch, layout.ch <= 14 ? "bold" : "normal");
    atlas.key = key;
    if (renderer) renderer.setAtlas(atlas);
  }

  // ---------------------------------------------------------------------------
  // Renderers. Both take the same packed frame: RGBA per cell, alpha = glyph index.
  // ---------------------------------------------------------------------------
  const VERT_SRC = "attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }";
  const FRAG_SRC = `precision highp float;
uniform sampler2D uCells;
uniform sampler2D uAtlas;
uniform vec2 uGrid;
uniform vec2 uCell;
uniform vec2 uOrigin;
uniform vec2 uAtlasSize;
uniform vec3 uFg;
uniform vec3 uBg;
uniform float uUseColor;
void main() {
  vec2 p = vec2(gl_FragCoord.x - uOrigin.x, uOrigin.y - gl_FragCoord.y);
  vec2 cell = floor(p / uCell);
  vec4 c = texture2D(uCells, (cell + 0.5) / uGrid);
  float g = floor(c.a * 255.0 + 0.5);
  float row = floor(g / 16.0);
  vec2 glyph = vec2(g - row * 16.0, row);
  float ink = texture2D(uAtlas, (glyph * uCell + p - cell * uCell) / uAtlasSize).a;
  gl_FragColor = vec4(mix(uBg, mix(uFg, c.rgb, uUseColor), ink), 1.0);
}`;

  // Returns a renderer, null (no usable context) or "replace" (context taken but unusable).
  function createGLRenderer(cv, force) {
    let gl = null;
    try {
      gl = cv.getContext("webgl", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: "low-power",
        // Software WebGL is slower than plain Canvas 2D for this job.
        failIfMajorPerformanceCaveat: !force,
      });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    if (!hp || hp.precision < 20) return "replace"; // pixel maths needs highp

    let u = null, cellsTex = null, atlasTex = null, cellsW = 0, cellsH = 0, atlasRef = null, lost = false;

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
      return s;
    }

    function texture() {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    function setup() {
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT_SRC));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
      gl.bindAttribLocation(prog, 0, "aPos");
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(prog) || "program link failed");
      gl.useProgram(prog);
      u = {};
      for (const name of ["uCells", "uAtlas", "uGrid", "uCell", "uOrigin", "uAtlasSize", "uFg", "uBg", "uUseColor"]) {
        u[name] = gl.getUniformLocation(prog, name);
      }
      gl.uniform1i(u.uCells, 0);
      gl.uniform1i(u.uAtlas, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.DITHER);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      cellsTex = texture();
      atlasTex = texture();
      cellsW = cellsH = 0;
    }

    function uploadAtlas() {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasRef.canvas);
    }

    try {
      setup();
    } catch (err) {
      console.warn("ASCII Cam: WebGL renderer unavailable, using Canvas 2D.", err);
      return "replace";
    }

    cv.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      lost = true;
    });
    cv.addEventListener("webglcontextrestored", () => {
      try {
        setup();
        lost = false;
        if (atlasRef) uploadAtlas();
        invalidate();
      } catch (err) {
        console.warn("ASCII Cam: could not restore WebGL.", err);
      }
    });

    return {
      name: "WebGL",
      setAtlas(a) {
        atlasRef = a;
        if (!lost) uploadAtlas();
      },
      draw(f) {
        if (lost || !atlasRef) return;
        const W = cv.width, H = cv.height, gw = f.cols * f.cw, gh = f.rows * f.ch;
        gl.viewport(0, 0, W, H);
        gl.clearColor(f.bg[0], f.bg[1], f.bg[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.viewport(f.offX, H - f.offY - gh, gw, gh);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, cellsTex);
        const data = f.cells.subarray(0, f.cols * f.rows * 4);
        if (cellsW !== f.cols || cellsH !== f.rows) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, f.cols, f.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
          cellsW = f.cols;
          cellsH = f.rows;
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, f.cols, f.rows, gl.RGBA, gl.UNSIGNED_BYTE, data);
        }
        gl.uniform2f(u.uGrid, f.cols, f.rows);
        gl.uniform2f(u.uCell, f.cw, f.ch);
        gl.uniform2f(u.uOrigin, f.offX, H - f.offY);
        gl.uniform2f(u.uAtlasSize, atlasRef.canvas.width, atlasRef.canvas.height);
        gl.uniform3fv(u.uFg, f.fg);
        gl.uniform3fv(u.uBg, f.bg);
        gl.uniform1f(u.uUseColor, f.useColor ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
    };
  }

  // Canvas 2D fallback for machines without (hardware) WebGL: glyphs are composited in JS
  // into one ImageData and pushed with a single putImageData. On slow CPUs that is several
  // times faster than issuing thousands of drawImage calls per frame.
  function create2DRenderer(cv) {
    const ctx = cv.getContext("2d", { alpha: false });
    const littleEndian = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;
    const pack = littleEndian
      ? (r, g, b) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0
      : (r, g, b) => ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;
    let atlasRef = null, alpha = null, tinted = null, tintKey = "", img = null, out = null, clearKey = "";

    // Per-glyph coverage, glyph-major and row-major, so a cell is one contiguous run.
    function readAlpha(a) {
      const { cw, ch } = a, w = a.canvas.width, size = cw * ch;
      const src = a.canvas.getContext("2d").getImageData(0, 0, w, a.canvas.height).data;
      const res = new Uint8Array(a.chars.length * size);
      for (let g = 0; g < a.chars.length; g++) {
        const x0 = (g & 15) * cw, y0 = (g >> 4) * ch;
        for (let y = 0; y < ch; y++) {
          for (let x = 0, s = ((y0 + y) * w + x0) * 4 + 3, d = g * size + y * cw; x < cw; x++, s += 4) res[d + x] = src[s];
        }
      }
      return res;
    }

    return {
      name: "Canvas 2D",
      setAtlas(a) {
        atlasRef = a;
        alpha = readAlpha(a);
        tintKey = "";
      },
      draw(f) {
        if (!atlasRef) return;
        const { cols, rows, cw, ch, cells } = f;
        const gw = cols * cw, gh = rows * ch, size = cw * ch;
        const key = `${cv.width}x${cv.height}|${f.offX},${f.offY},${gw}x${gh}|${f.bgCss}`;
        if (key !== clearKey) {
          ctx.fillStyle = f.bgCss;
          ctx.fillRect(0, 0, cv.width, cv.height);
          clearKey = key;
        }
        if (!img || img.width !== gw || img.height !== gh) {
          img = ctx.createImageData(gw, gh);
          out = new Uint32Array(img.data.buffer);
        }
        const [br, bgr, bb] = f.bg255;
        if (!f.useColor) {
          // Fixed ink colour: pre-blend every glyph pixel once, then frames are plain copies.
          const tk = f.fgCss + f.bgCss;
          if (tintKey !== tk) {
            const [fr, fgr, fb] = f.fg255;
            tinted = new Uint32Array(alpha.length);
            for (let i = 0; i < alpha.length; i++) {
              const a = alpha[i] / 255;
              tinted[i] = pack(Math.round(br + (fr - br) * a), Math.round(bgr + (fgr - bgr) * a), Math.round(bb + (fb - bb) * a));
            }
            tintKey = tk;
          }
          for (let y = 0, i = 3; y < rows; y++) {
            for (let x = 0; x < cols; x++, i += 4) {
              let s = cells[i] * size;
              for (let yy = 0, d = y * ch * gw + x * cw; yy < ch; yy++, d += gw) {
                for (let xx = 0; xx < cw; xx++) out[d + xx] = tinted[s++];
              }
            }
          }
        } else {
          const bg32 = pack(br, bgr, bb);
          for (let y = 0, i = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++, i += 4) {
              const dr = cells[i] - br, dg = cells[i + 1] - bgr, db = cells[i + 2] - bb;
              let s = cells[i + 3] * size;
              for (let yy = 0, d = y * ch * gw + x * cw; yy < ch; yy++, d += gw) {
                for (let xx = 0; xx < cw; xx++) {
                  const a = alpha[s++];
                  out[d + xx] = a === 0 ? bg32 : pack(
                    br + ((dr * a * 257 + 32896) >> 16),
                    bgr + ((dg * a * 257 + 32896) >> 16),
                    bb + ((db * a * 257 + 32896) >> 16),
                  );
                }
              }
            }
          }
        }
        ctx.putImageData(img, f.offX, f.offY);
      },
    };
  }

  function createRenderer() {
    const pref = params.get("renderer"); // ?renderer=webgl|canvas to override detection
    if (pref !== "canvas") {
      const gl = createGLRenderer(canvas, pref === "webgl");
      if (gl && gl !== "replace") return gl;
      if (gl === "replace") {
        // A canvas keeps its first context type, so Canvas 2D needs a fresh element.
        const fresh = canvas.cloneNode(false);
        canvas.replaceWith(fresh);
        canvas = fresh;
      }
    }
    return create2DRenderer(canvas);
  }

  // ---------------------------------------------------------------------------
  // Analysis: source pixels → glyph + colour per cell
  // ---------------------------------------------------------------------------
  const sampler = document.createElement("canvas");
  const sctx = sampler.getContext("2d", { willReadFrequently: true });
  const hist = new Uint32Array(256);
  const toneLut = new Uint8Array(256);  // tone curve for colours
  const inkLut = new Uint8Array(256);   // luma → ink (flipped for light backgrounds / invert)
  const glyphLut = new Uint8Array(256); // luma → glyph index
  const levels = { lo: 0, hi: 255, fresh: true };
  let lum = new Float32Array(0);
  let cells = new Uint8Array(0);
  let inkBuf = new Uint8Array(0);
  let magBuf = new Float32Array(0);
  let dirBuf = new Uint8Array(0);
  let gradLut = null;
  let freshTemporal = true;

  function analyze(src, continuous) {
    const { cols, rows } = layout;
    const braille = atlas.braille;
    const sw = braille ? cols * 2 : cols;
    const sh = braille ? rows * 4 : rows;
    const n = sw * sh;
    if (sampler.width !== sw || sampler.height !== sh) {
      sampler.width = sw;
      sampler.height = sh;
      freshTemporal = true;
    }
    if (lum.length !== n) {
      lum = new Float32Array(n);
      freshTemporal = true;
    }
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "medium";
    const flipX = settings.mirror && src.el !== demo; // mirroring is for camera frames only
    sctx.setTransform(flipX ? -1 : 1, 0, 0, 1, flipX ? sw : 0, 0);
    sctx.drawImage(src.el, 0, 0, src.w, src.h, 0, 0, sw, sh);
    const px = sctx.getImageData(0, 0, sw, sh).data;

    const a = continuous && settings.smooth && !freshTemporal ? SMOOTHING : 1;
    freshTemporal = false;
    hist.fill(0);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const y = (px[p] * 77 + px[p + 1] * 150 + px[p + 2] * 29) >> 8;
      const v = (lum[i] += (y - lum[i]) * a);
      hist[v | 0]++;
    }
    updateLevels(n, continuous);
    buildLuts();

    if (cells.length !== cols * rows * 4) cells = new Uint8Array(cols * rows * 4);
    if (braille) brailleCells(px, sw, cols, rows);
    else asciiCells(px, cols, rows);
    frame.cells = cells;
  }

  function updateLevels(n, continuous) {
    if (!settings.autoLevels) return;
    const cut = Math.max(1, Math.floor(n * 0.01));
    let lo = 0, hi = 255;
    for (let acc = 0; lo < 255; lo++) {
      acc += hist[lo];
      if (acc > cut) break;
    }
    for (let acc = 0; hi > 0; hi--) {
      acc += hist[hi];
      if (acc > cut) break;
    }
    if (levels.fresh || !continuous) {
      levels.lo = lo;
      levels.hi = hi;
      levels.fresh = false;
    } else {
      levels.lo += (lo - levels.lo) * LEVELS_EASE;
      levels.hi += (hi - levels.hi) * LEVELS_EASE;
    }
  }

  function buildLuts() {
    let lo = 0, hi = 255;
    if (settings.autoLevels) {
      lo = levels.lo;
      hi = levels.hi;
      if (hi - lo < MIN_LEVELS_RANGE) {
        const mid = (lo + hi) / 2;
        lo = mid - MIN_LEVELS_RANGE / 2;
        hi = mid + MIN_LEVELS_RANGE / 2;
      }
    }
    const k = Math.pow(3, settings.contrast / 100);
    const b = settings.brightness / 200;
    const flip = settings.invert !== !!palette.light; // dark ink on paper means more ink in shadows
    const span = hi - lo;
    const map = atlas.lut;
    for (let v = 0; v < 256; v++) {
      let x = ((v - lo) / span - 0.5) * k + 0.5 + b;
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      const t = Math.round(x * 255);
      toneLut[v] = t;
      const ink = flip ? 255 - t : t;
      inkLut[v] = ink;
      if (map) glyphLut[v] = map[ink];
    }
  }

  function asciiCells(px, cols, rows) {
    const n = cols * rows;
    const mode = palette.mode;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const v = lum[i] | 0;
      cells[p + 3] = glyphLut[v];
      if (mode === "source") {
        cells[p] = toneLut[px[p]];
        cells[p + 1] = toneLut[px[p + 1]];
        cells[p + 2] = toneLut[px[p + 2]];
      } else if (mode === "gradient") {
        const g = inkLut[v] * 3;
        cells[p] = gradLut[g];
        cells[p + 1] = gradLut[g + 1];
        cells[p + 2] = gradLut[g + 2];
      }
    }
    if (settings.edges) traceEdges(cols, rows, mode);
  }

  // Sobel on the ink grid, thinned with non-maximum suppression, drawn as | / - \.
  function traceEdges(cols, rows, mode) {
    const n = cols * rows;
    if (inkBuf.length !== n) {
      inkBuf = new Uint8Array(n);
      magBuf = new Float32Array(n);
      dirBuf = new Uint8Array(n);
    }
    for (let i = 0; i < n; i++) inkBuf[i] = inkLut[lum[i] | 0];
    magBuf.fill(0);
    const aspect = layout.cw / layout.ch; // cells are taller than wide
    const t2 = EDGE_THRESHOLD * EDGE_THRESHOLD;
    const ink = inkBuf;
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1, i = y * cols + 1; x < cols - 1; x++, i++) {
        const tl = ink[i - cols - 1], tc = ink[i - cols], tr = ink[i - cols + 1];
        const ml = ink[i - 1], mr = ink[i + 1];
        const bl = ink[i + cols - 1], bc = ink[i + cols], br = ink[i + cols + 1];
        const gx = tr + 2 * mr + br - tl - 2 * ml - bl;
        const gy = bl + 2 * bc + br - tl - 2 * tc - tr;
        const m = gx * gx + gy * gy;
        if (m < t2) continue;
        magBuf[i] = m;
        const ax = Math.abs(gx), ay = Math.abs(gy) * aspect;
        // 0: |  1: /  2: -  3: \   (the edge runs perpendicular to the gradient)
        dirBuf[i] = ay < ax * 0.4142 ? 0 : ax < ay * 0.4142 ? 2 : (gx > 0) === (gy > 0) ? 1 : 3;
      }
    }
    const base = atlas.edgeBase;
    const top = gradLut ? 255 * 3 : 0;
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1, i = y * cols + 1; x < cols - 1; x++, i++) {
        const m = magBuf[i];
        if (!m) continue;
        const d = dirBuf[i];
        const o = d === 0 ? 1 : d === 2 ? cols : d === 1 ? cols + 1 : cols - 1;
        if (m < magBuf[i - o] || m < magBuf[i + o]) continue;
        const p = i * 4;
        cells[p + 3] = base + d;
        if (mode === "source") {
          const r = cells[p], g = cells[p + 1], b = cells[p + 2];
          const s = 255 / Math.max(r, g, b, 1);
          cells[p] = r * s;
          cells[p + 1] = g * s;
          cells[p + 2] = b * s;
        } else if (mode === "gradient") {
          cells[p] = gradLut[top];
          cells[p + 1] = gradLut[top + 1];
          cells[p + 2] = gradLut[top + 2];
        }
      }
    }
  }

  function brailleCells(px, sw, cols, rows) {
    const mode = palette.mode;
    for (let cy = 0, p = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++, p += 4) {
        let bits = 0, sum = 0, r = 0, g = 0, b = 0;
        for (let k = 0; k < 8; k++) {
          const dot = BRAILLE_DOTS[k];
          const sx = cx * 2 + dot[0], sy = cy * 4 + dot[1], si = sy * sw + sx;
          const v = inkLut[lum[si] | 0];
          sum += v;
          if (v > BAYER[((sy & 3) << 2) | (sx & 3)]) bits |= dot[2];
          if (mode === "source") {
            const q = si * 4;
            r += px[q];
            g += px[q + 1];
            b += px[q + 2];
          }
        }
        cells[p + 3] = bits;
        if (mode === "source") {
          cells[p] = toneLut[r >> 3];
          cells[p + 1] = toneLut[g >> 3];
          cells[p + 2] = toneLut[b >> 3];
        } else if (mode === "gradient") {
          const gi = (sum >> 3) * 3;
          cells[p] = gradLut[gi];
          cells[p + 1] = gradLut[gi + 1];
          cells[p + 2] = gradLut[gi + 2];
        }
      }
    }
  }

  function buildGradient(stops) {
    const rgb = stops.map(hexToRgb), segs = rgb.length - 1, lut = new Uint8Array(768);
    for (let v = 0; v < 256; v++) {
      const t = (v / 255) * segs, i = Math.min(segs - 1, Math.floor(t)), f = t - i;
      for (let c = 0; c < 3; c++) lut[v * 3 + c] = Math.round(rgb[i][c] + (rgb[i + 1][c] - rgb[i][c]) * f);
    }
    return lut;
  }

  function applyPalette() {
    palette = PALETTES[settings.palette];
    frame.useColor = !!palette.mode;
    frame.bgCss = palette.bg;
    frame.bg255 = hexToRgb(palette.bg);
    frame.bg = frame.bg255.map((c) => c / 255);
    frame.fgCss = palette.fg || "#ffffff";
    frame.fg255 = hexToRgb(frame.fgCss);
    frame.fg = frame.fg255.map((c) => c / 255);
    gradLut = palette.mode === "gradient" ? buildGradient(palette.stops) : null;
    const accent = palette.accent || palette.fg;
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-rgb", hexToRgb(accent).join(" "));
    root.style.setProperty("--stage-bg", palette.bg);
  }

  // ---------------------------------------------------------------------------
  // Layout: fit the character grid into the stage with integer device-pixel cells
  // ---------------------------------------------------------------------------
  function autoDetail() {
    const w = Math.min(window.innerWidth || 1024, (window.screen && screen.width) || 4096);
    const lowEnd = (navigator.hardwareConcurrency || 8) <= 2 || (navigator.deviceMemory || 8) <= 2;
    return clamp(Math.round(w / 9) * 2, 64, lowEnd ? 96 : 160);
  }

  function sizeCanvas() {
    if (rec) return; // a recording needs a fixed resolution; CSS scales the canvas meanwhile
    const r = stage.getBoundingClientRect();
    const cssW = Math.max(1, r.width), cssH = Math.max(1, r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR, Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH)));
    const W = Math.max(1, Math.round(cssW * dpr));
    const H = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
  }

  function relayout() {
    const W = canvas.width, H = canvas.height;
    const src = currentSource();
    const ratio = src ? src.h / src.w : H / W;
    let cols = clamp(settings.detail || autoDetail(), 8, Math.max(8, Math.floor(W / 3)));
    let fit = null;
    while (!fit) {
      for (let ch = MAX_CELL_H; ch >= MIN_CELL_H; ch--) {
        const cw = Math.max(3, Math.round(ch * CHAR_ASPECT));
        const rows = Math.max(1, Math.round((cols * ratio * cw) / ch));
        if (cols * cw <= W && rows * ch <= H) {
          fit = { cols, rows, cw, ch };
          break;
        }
      }
      if (!fit && cols <= 8) fit = { cols, rows: Math.max(1, Math.floor(H / MIN_CELL_H)), cw: 3, ch: MIN_CELL_H };
      if (!fit) cols = Math.max(8, Math.floor(cols * 0.9));
    }
    layout.cols = fit.cols;
    layout.rows = fit.rows;
    layout.cw = fit.cw;
    layout.ch = fit.ch;
    layout.offX = (W - fit.cols * fit.cw) >> 1;
    layout.offY = (H - fit.rows * fit.ch) >> 1;
    Object.assign(frame, layout);
    ensureAtlas();
    detailOut.textContent = `${layout.cols} × ${layout.rows}`;
  }

  function onResize() {
    sizeCanvas();
    sizeDemo();
    relayout();
    renderNow();
  }

  // ---------------------------------------------------------------------------
  // Idle demo: a tiny procedural scene shown through the same pipeline
  // ---------------------------------------------------------------------------
  const demo = document.createElement("canvas");
  const dctx = demo.getContext("2d");
  const DEMO_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const stars = Array.from({ length: 60 }, (_, i) => {
    const r = (n) => ((Math.sin(i * 127.1 + n * 311.7) * 43758.5453) % 1 + 1) % 1; // stable pseudo-random
    return [r(1), r(2), 1.2 + r(3) * 1.8, r(4) * 6.28];
  });
  let title = null;

  function sizeDemo() {
    const w = stage.clientWidth || 640, h = stage.clientHeight || 480;
    const W = 480, H = Math.round(clamp((W * h) / w, 180, 1100));
    if (demo.width !== W || demo.height !== H) {
      demo.width = W;
      demo.height = H;
      title = null;
    }
  }

  function sphere(x, y, r, t, stops) {
    const lx = x + Math.cos(t) * r * 0.5, ly = y - r * 0.42 + Math.sin(t) * r * 0.16;
    const g = dctx.createRadialGradient(lx, ly, r * 0.04, x, y, r * 1.05);
    for (const [at, col] of stops) g.addColorStop(at, col);
    dctx.fillStyle = g;
    dctx.beginPath();
    dctx.arc(x, y, r, 0, Math.PI * 2);
    dctx.fill();
  }

  function drawDemo(now) {
    const t = reducedMotion.matches ? 2.6 : now / 1000;
    const w = demo.width, h = demo.height, c = dctx;
    const portrait = h > w * 1.15;
    c.fillStyle = "#000";
    c.fillRect(0, 0, w, h);
    c.fillStyle = "#fff";
    for (const [sx, sy, size, phase] of stars) {
      c.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(t * 0.9 + phase));
      c.fillRect(sx * w, sy * h, size, size);
    }
    c.globalAlpha = 1;
    const R = Math.min(w, h) * (portrait ? 0.27 : 0.22);
    const cx = w / 2, cy = h * (portrait ? 0.3 : 0.36);
    const orbit = t * 0.8;
    const mx = cx + Math.cos(orbit) * R * 1.6, my = cy - R * 0.1 + Math.sin(orbit) * R * 0.32, mr = R * 0.25;
    const moon = [[0, "#ffffff"], [0.25, "#a6ecff"], [0.7, "#2f7bc2"], [1, "#0a1d30"]];
    if (Math.sin(orbit) < 0) sphere(mx, my, mr, t * 0.6 + 1, moon);
    sphere(cx, cy, R, t * 0.6, [[0, "#ffffff"], [0.18, "#ffd9a8"], [0.55, "#e0523a"], [1, "#2a0b07"]]);
    if (Math.sin(orbit) >= 0) sphere(mx, my, mr, t * 0.6 + 1, moon);
    if (!title) {
      const lines = portrait ? ["ASCII", "CAM"] : ["ASCII CAM"];
      c.font = `900 100px ${DEMO_FONT}`;
      const widest = Math.max(...lines.map((line) => c.measureText(line).width));
      const size = Math.min((100 * w * 0.86) / widest, h * (portrait ? 0.15 : 0.22));
      title = { lines, size, y: h * (portrait ? 0.68 : 0.8) - (lines.length - 1) * size * 0.5 };
    }
    c.font = `900 ${title.size}px ${DEMO_FONT}`;
    c.fillStyle = "#fff";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.lineJoin = "round";
    c.lineWidth = title.size * 0.06; // a stroke thickens thin bars so they survive downsampling
    c.strokeStyle = "#fff";
    title.lines.forEach((line, i) => {
      const y = title.y + i * title.size * 1.02;
      c.strokeText(line, cx, y);
      c.fillText(line, cx, y);
    });
  }

  // ---------------------------------------------------------------------------
  // Render loop. Live video is paced by requestVideoFrameCallback (only new camera
  // frames are processed) with a requestAnimationFrame fallback; both honour the FPS cap.
  // ---------------------------------------------------------------------------
  let loopKind = "";
  let loopHandle = 0;
  let lastTick = -Infinity;
  let vfcSeen = false;
  let vfcBroken = false;
  let vfcWatchdog = 0;
  let soonHandle = 0;
  const stat = { frames: 0, work: 0, since: 0, total: 0, last: 0 };

  function currentSource() {
    if (state === "live") return cam.stream && video.videoWidth ? { el: video, w: video.videoWidth, h: video.videoHeight } : null;
    if (state === "paused") return frozen.width ? { el: frozen, w: frozen.width, h: frozen.height } : null;
    if (state === "idle") return { el: demo, w: demo.width, h: demo.height };
    return null;
  }

  function render(continuous) {
    const src = currentSource();
    if (!src || !renderer) return false;
    const t0 = performance.now();
    if (src.w !== srcW || src.h !== srcH) {
      srcW = src.w;
      srcH = src.h;
      relayout();
    }
    analyze(src, continuous);
    renderer.draw(frame);
    shown.cols = layout.cols;
    shown.rows = layout.rows;
    shown.atlas = atlas;
    shown.frame = frame;
    noteStats(performance.now() - t0, continuous);
    return true;
  }

  function renderNow() {
    if (state === "idle") drawDemo(performance.now());
    render(false);
  }

  function renderSoon() {
    if (soonHandle) return;
    soonHandle = requestAnimationFrame(() => {
      soonHandle = 0;
      renderNow();
    });
  }

  // Settings changed: a running loop picks it up on its next frame, otherwise redraw once.
  function invalidate() {
    if (!loopKind) renderSoon();
  }

  function stopLoop() {
    if (loopKind === "vfc") video.cancelVideoFrameCallback(loopHandle);
    else if (loopKind === "raf") cancelAnimationFrame(loopHandle);
    loopKind = "";
    loopHandle = 0;
    clearTimeout(vfcWatchdog);
  }

  function startLoop() {
    stopLoop();
    if (document.hidden) return;
    lastTick = -Infinity;
    stat.since = 0;
    if (state === "live" && !vfcBroken && typeof video.requestVideoFrameCallback === "function") {
      loopKind = "vfc";
      vfcSeen = false;
      loopHandle = video.requestVideoFrameCallback(onVideoFrame);
      vfcWatchdog = setTimeout(checkVideoFrames, 1500);
    } else if (state === "live" || (state === "idle" && !reducedMotion.matches)) {
      loopKind = "raf";
      loopHandle = requestAnimationFrame(onAnimationFrame);
    } else {
      renderSoon();
    }
  }

  function checkVideoFrames() {
    if (loopKind !== "vfc" || vfcSeen) return;
    if (cam.stream && !video.paused && video.readyState >= 2) {
      vfcBroken = true; // frames are arriving but callbacks are not: poll with rAF instead
      startLoop();
    } else {
      vfcWatchdog = setTimeout(checkVideoFrames, 1500);
    }
  }

  function onVideoFrame(now) {
    vfcSeen = true;
    loopHandle = video.requestVideoFrameCallback(onVideoFrame);
    tick(now);
  }

  function onAnimationFrame(now) {
    loopHandle = requestAnimationFrame(onAnimationFrame);
    tick(now);
  }

  function tick(now) {
    const interval = 1000 / (state === "idle" ? Math.min(settings.fps, DEMO_FPS) : settings.fps);
    if (now - lastTick < interval - 2) return;
    // Keep an even cadence (24 fps on a 60 Hz display alternates 2 and 3 frames) and
    // resynchronise after a stall instead of bursting.
    lastTick = now - lastTick > interval * 2 ? now : lastTick + interval;
    if (state === "idle") drawDemo(now);
    render(true);
  }

  function noteStats(ms, continuous) {
    stat.total++;
    stat.last = ms;
    if (!settings.stats) return;
    const label = `${layout.cols}×${layout.rows} · ${renderer.name}`;
    if (!continuous) {
      statsEl.textContent = `${ms.toFixed(1)} ms · ${label}`;
      return;
    }
    const now = performance.now();
    stat.frames++;
    stat.work += ms;
    if (!stat.since) {
      stat.since = now;
      stat.frames = 0;
      stat.work = 0;
    } else if (now - stat.since >= 1000) {
      const fps = Math.round((stat.frames * 1000) / (now - stat.since));
      statsEl.textContent = `${fps} fps · ${(stat.work / stat.frames).toFixed(1)} ms · ${label}`;
      stat.frames = 0;
      stat.work = 0;
      stat.since = now;
    }
  }

  // ---------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------
  function stopTracks(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.removeEventListener("ended", onTrackEnded);
      track.stop();
    }
  }

  async function openStream(deviceId) {
    // ~640 px wide is plenty for even the densest grid and far cheaper to read back on slow
    // devices. Only the width is hinted: constraining both would make the browser crop the
    // picture to that aspect ratio (a 16:9 webcam would lose its sides).
    const constraints = { width: { ideal: 640 }, frameRate: { ideal: 30 } };
    if (deviceId) constraints.deviceId = { exact: deviceId };
    else constraints.facingMode = "user";
    try {
      return await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
    } catch (err) {
      const name = err && err.name;
      if (name === "OverconstrainedError" || (deviceId && name === "NotFoundError")) {
        // The remembered camera is gone: take any camera instead.
        return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, frameRate: { ideal: 30 } }, audio: false });
      }
      throw err;
    }
  }

  function withTimeout(promise, ms, message) {
    let timer = 0;
    promise.catch(() => {}); // a late rejection after the timeout must not go unhandled
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { name: "TimeoutError" })), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function videoReady(timeout) {
    return new Promise((resolve) => {
      if (video.videoWidth) return resolve();
      const check = () => {
        if (video.videoWidth) done();
      };
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener("loadedmetadata", check);
        video.removeEventListener("resize", check);
        resolve();
      };
      const timer = setTimeout(done, timeout);
      video.addEventListener("loadedmetadata", check);
      video.addEventListener("resize", check);
    });
  }

  // Opens and attaches a stream. Resolves false if a newer start/stop superseded it.
  async function connect(deviceId) {
    const token = cam.token;
    const stream = await openStream(deviceId);
    if (token !== cam.token) {
      stopTracks(stream);
      return false;
    }
    try {
      video.srcObject = stream;
      await withTimeout(video.play(), 10000, "The camera didn't start in time.");
      await videoReady(4000);
      if (!video.videoWidth) throw Object.assign(new Error("The camera didn't send any video."), { name: "NoVideoError" });
    } catch (err) {
      stopTracks(stream);
      if (video.srcObject === stream) video.srcObject = null;
      throw err;
    }
    if (token !== cam.token) {
      stopTracks(stream);
      if (video.srcObject === stream) video.srcObject = null;
      return false;
    }
    cam.stream = stream;
    const track = stream.getVideoTracks()[0];
    track.addEventListener("ended", onTrackEnded);
    const info = track.getSettings ? track.getSettings() : {};
    cam.deviceId = info.deviceId || "";
    // Selfie cameras behave like a mirror, rear cameras don't. Only react to a change of
    // direction so a deliberately switched-off mirror stays off.
    const facing = info.facingMode === "user" || info.facingMode === "environment" ? info.facingMode : "";
    if (facing && facing !== cam.facing && (cam.facing || facing === "environment")) {
      settings.mirror = facing === "user";
      persist();
      syncControls();
    }
    if (facing) cam.facing = facing;
    freshTemporal = true;
    levels.fresh = true;
    return true;
  }

  async function startCamera() {
    if (state !== "idle") return;
    hideNotice();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (window.isSecureContext === false) showNotice("Secure connection needed", "Browsers only allow camera access on https:// pages and localhost.", false);
      else showNotice("Camera not supported", "This browser can't use cameras. Try a recent Chrome, Edge, Firefox or Safari.", false);
      return;
    }
    const token = ++cam.token;
    setState("starting");
    try {
      if (!(await connect(settings.camera))) return;
      setState("live");
      requestWakeLock();
      refreshDevices();
    } catch (err) {
      if (token !== cam.token) return;
      setState("idle");
      showCameraError(err);
    }
  }

  function stopCamera() {
    cam.token++; // cancels any start or switch still in flight
    cam.busy = false;
    if (rec) stopRecording();
    stopTracks(cam.stream);
    cam.stream = null;
    video.srcObject = null;
    btnFlip.disabled = false;
    cameraSelect.disabled = false;
    releaseWakeLock();
    if (state !== "idle") setState("idle");
  }

  async function switchCamera(deviceId) {
    if ((state !== "live" && state !== "paused") || cam.busy) return;
    if (rec) stopRecording();
    cam.busy = true;
    btnFlip.disabled = true;
    cameraSelect.disabled = true;
    const token = ++cam.token;
    // Phones often refuse to open a second camera while the first is still running.
    stopTracks(cam.stream);
    cam.stream = null;
    try {
      if (!(await connect(deviceId))) return;
      if (state === "paused") setState("live");
      else startLoop();
      refreshDevices();
    } catch (err) {
      if (token !== cam.token) return;
      stopCamera();
      showCameraError(err);
    } finally {
      if (token === cam.token) {
        cam.busy = false;
        btnFlip.disabled = false;
        cameraSelect.disabled = false;
      }
    }
  }

  function flipCamera() {
    const list = cam.devices;
    if (list.length < 2 || cam.busy || (state !== "live" && state !== "paused")) return;
    const i = list.findIndex((d) => d.deviceId === cam.deviceId);
    const next = list[(i + 1) % list.length];
    settings.camera = next.deviceId;
    persist();
    switchCamera(next.deviceId);
  }

  function onTrackEnded(e) {
    if (!cam.stream || !cam.stream.getTracks().includes(e.target)) return;
    stopCamera();
    toast("The camera was disconnected");
  }

  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let list = [];
    try {
      list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput" && d.deviceId);
    } catch {
      list = [];
    }
    cam.devices = list;
    btnFlip.hidden = list.length < 2;
    cameraField.hidden = list.length < 2;
    cameraSelect.replaceChildren(...list.map((d, i) => {
      const opt = el("option", "", d.label || `Camera ${i + 1}`);
      opt.value = d.deviceId;
      return opt;
    }));
    const current = cam.deviceId || settings.camera;
    if (list.some((d) => d.deviceId === current)) cameraSelect.value = current;
  }

  function showCameraError(err) {
    const name = (err && err.name) || "";
    let title = "Couldn't start the camera";
    let text = (err && err.message) || "Something went wrong. Please try again.";
    if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
      title = "Camera access is blocked";
      text = "Allow camera access for this site (usually via the icon in the address bar), then try again.";
    } else if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
      title = "No camera found";
      text = "Connect a camera, then try again.";
    } else if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
      title = "The camera is busy";
      text = "Another app or browser tab may be using it. Close it, then try again.";
    }
    showNotice(title, text, true);
  }

  function pause() {
    if (state !== "live" || !video.videoWidth) return;
    frozen.width = video.videoWidth;
    frozen.height = video.videoHeight;
    frozen.getContext("2d").drawImage(video, 0, 0);
    setState("paused");
  }

  function resume() {
    if (state === "paused") setState("live");
  }

  function setState(next) {
    state = next;
    app.dataset.state = next;
    const on = next === "live" || next === "paused";
    btnMain.disabled = next === "starting";
    btnMain.setAttribute("aria-label", on ? "Save snapshot" : next === "starting" ? "Starting camera" : "Start camera");
    btnMain.title = on ? "Save snapshot (S)" : "Start camera (Space)";
    mainLabel.textContent = next === "starting" ? "Starting…" : "Start camera";
    btnPause.setAttribute("aria-pressed", String(next === "paused"));
    btnPause.setAttribute("aria-label", next === "paused" ? "Resume" : "Pause");
    btnPause.title = next === "paused" ? "Resume (Space)" : "Pause (Space)";
    pauseIcon.setAttribute("href", next === "paused" ? "#i-play" : "#i-pause");
    btnRecord.disabled = !rec && !(next === "live" && recFormat);
    hint.hidden = on;
    hintText.textContent = next === "starting" ? "Waiting for the camera. Allow access if your browser asks." : IDLE_HINT;
    kbdHint.hidden = next !== "idle";
    canvas.setAttribute("aria-label", on ? "Live ASCII art made from your camera" : "Animated ASCII art preview");
    updateStatus();
    startLoop();
  }

  function updateStatus() {
    let kind = "", text = "";
    if (rec) {
      const s = Math.floor((performance.now() - rec.started) / 1000);
      kind = "rec";
      text = `Rec ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    } else if (state === "live") {
      kind = "live";
      text = "Live";
    } else if (state === "paused") {
      kind = "paused";
      text = "Paused";
    }
    statusEl.hidden = !kind;
    statusEl.dataset.kind = kind;
    statusEl.textContent = text;
  }

  // ---------------------------------------------------------------------------
  // Output: snapshot, copy as text, recording, sharing
  // ---------------------------------------------------------------------------
  async function saveBlob(blob, name) {
    // On phones the share sheet is the natural way to save to the photo library.
    if (coarsePointer.matches && navigator.canShare && typeof File === "function") {
      try {
        const file = new File([blob], name, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          return "shared";
        }
      } catch (err) {
        if (err && err.name === "AbortError") return "cancelled";
        // Not allowed (e.g. the user gesture expired): fall back to a download.
      }
    }
    const url = URL.createObjectURL(blob);
    const a = el("a", "offscreen");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000); // revoking at once can cancel the download
    return "downloaded";
  }

  async function snapshot() {
    if (!shown.atlas) return;
    flash();
    const { cols, rows } = shown;
    const base = shown.atlas;
    // Re-render at a larger cell size so snapshots stay crisp even from a phone.
    const scale = clamp(Math.floor(SNAPSHOT_TARGET / Math.max(cols * base.cw, rows * base.ch)), 1, 4);
    const cw = base.cw * scale, ch = base.ch * scale, pad = Math.round(ch * 1.5);
    const out = document.createElement("canvas");
    out.width = cols * cw + pad * 2;
    out.height = rows * ch + pad * 2;
    const r = create2DRenderer(out);
    r.setAtlas(scale === 1 ? base : buildAtlas(cw, ch, base.weight));
    r.draw({ ...shown.frame, cols, rows, cw, ch, offX: pad, offY: pad });
    const blob = await new Promise((resolve) => out.toBlob(resolve, "image/png"));
    out.width = out.height = 0;
    if (!blob) {
      toast("Couldn't create the image");
      return;
    }
    const how = await saveBlob(blob, `ascii-cam-${stamp()}.png`);
    if (how === "downloaded") toast("Snapshot saved");
  }

  function frameText() {
    const { cols, rows, atlas: a } = shown;
    const data = shown.frame.cells, lines = [];
    for (let y = 0; y < rows; y++) {
      let line = "";
      for (let x = 0, p = y * cols * 4 + 3; x < cols; x++, p += 4) line += a.chars[data[p]];
      lines.push(line.replace(/\s+$/, ""));
    }
    return lines.join("\n");
  }

  async function copyText() {
    if (!shown.atlas) return;
    const text = frameText();
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      const ta = el("textarea", "offscreen");
      ta.value = text;
      ta.setAttribute("readonly", "");
      document.body.append(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    toast(ok ? `Copied ${shown.cols} × ${shown.rows} characters` : "Couldn't access the clipboard");
  }

  const REC_TYPES = [
    ["video/mp4;codecs=avc1.42E01E", "mp4"],
    ["video/mp4", "mp4"],
    ["video/webm;codecs=vp9", "webm"],
    ["video/webm;codecs=vp8", "webm"],
    ["video/webm", "webm"],
  ];
  const recFormat = (() => {
    if (typeof MediaRecorder !== "function" || typeof MediaRecorder.isTypeSupported !== "function") return null;
    if (typeof HTMLCanvasElement.prototype.captureStream !== "function") return null;
    return REC_TYPES.find(([type]) => {
      try {
        return MediaRecorder.isTypeSupported(type);
      } catch {
        return false;
      }
    }) || null;
  })();
  let rec = null;

  function startRecording() {
    if (rec || !recFormat || state !== "live") return;
    const [mimeType, ext] = recFormat;
    let stream = null, recorder = null;
    try {
      stream = canvas.captureStream(Math.min(settings.fps, 30));
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8e6 });
    } catch {
      stopTracks(stream);
      toast("Recording isn't available in this browser");
      return;
    }
    const session = { recorder, stream, chunks: [], ext, type: mimeType.split(";")[0], started: performance.now(), timer: 0, limit: 0, done: false };
    recorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size) session.chunks.push(e.data);
    });
    recorder.addEventListener("stop", () => finishRecording(session));
    recorder.addEventListener("error", () => {
      toast("Recording failed");
      if (rec === session) stopRecording();
    });
    try {
      recorder.start(1000);
    } catch {
      stopTracks(stream);
      toast("Recording failed to start");
      return;
    }
    rec = session;
    session.timer = setInterval(updateStatus, 500);
    session.limit = setTimeout(() => {
      if (rec !== session) return;
      stopRecording();
      toast("Recordings stop after 60 seconds");
    }, REC_MAX_MS);
    btnRecord.setAttribute("aria-pressed", "true");
    btnRecord.setAttribute("aria-label", "Stop recording");
    btnRecord.title = "Stop recording (R)";
    recIcon.setAttribute("href", "#i-stop");
    updateStatus();
  }

  function stopRecording() {
    const session = rec;
    if (!session) return;
    rec = null;
    clearInterval(session.timer);
    clearTimeout(session.limit);
    try {
      if (session.recorder.state !== "inactive") session.recorder.stop();
      else finishRecording(session);
    } catch {
      finishRecording(session);
    }
    btnRecord.setAttribute("aria-pressed", "false");
    btnRecord.setAttribute("aria-label", "Record video");
    btnRecord.title = "Record video (R)";
    recIcon.setAttribute("href", "#i-record");
    btnRecord.disabled = !(state === "live" && recFormat);
    updateStatus();
    onResize(); // the canvas size was locked while recording
  }

  async function finishRecording(session) {
    if (session.done) return;
    session.done = true;
    stopTracks(session.stream);
    const blob = new Blob(session.chunks, { type: session.type });
    if (!blob.size) {
      toast("Nothing was recorded");
      return;
    }
    const how = await saveBlob(blob, `ascii-cam-${stamp()}.${session.ext}`);
    if (how === "downloaded") toast("Video saved");
  }

  const fsEnabled = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function toggleFullscreen() {
    if (!fsEnabled) return;
    try {
      const result = fullscreenElement()
        ? (document.exitFullscreen || document.webkitExitFullscreen).call(document)
        : (root.requestFullscreen || root.webkitRequestFullscreen).call(root, { navigationUI: "hide" });
      if (result && result.catch) result.catch(() => {});
    } catch {
      // Refused (no user gesture, iframe without permission, …): nothing to do.
    }
  }

  function syncFullscreen() {
    const on = !!fullscreenElement();
    fsIcon.setAttribute("href", on ? "#i-shrink" : "#i-expand");
    btnFullscreen.setAttribute("aria-label", on ? "Exit full screen" : "Enter full screen");
  }

  let wakeLock = null;

  async function requestWakeLock() {
    if (!navigator.wakeLock || wakeLock || document.hidden) return;
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (state !== "live" && state !== "paused") {
        lock.release().catch(() => {});
        return;
      }
      wakeLock = lock;
      lock.addEventListener("release", () => {
        if (wakeLock === lock) wakeLock = null;
      });
    } catch {
      wakeLock = null;
    }
  }

  function releaseWakeLock() {
    if (!wakeLock) return;
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  let toastTimer = 0;

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  function flash() {
    if (reducedMotion.matches) return;
    flashEl.classList.remove("go");
    void flashEl.offsetWidth; // restart the animation
    flashEl.classList.add("go");
  }

  function showNotice(title, text, retry) {
    noticeTitle.textContent = title;
    noticeText.textContent = text;
    noticeRetry.hidden = !retry;
    notice.hidden = false;
  }

  function hideNotice() {
    notice.hidden = true;
  }

  function togglePanel(open = panel.hidden) {
    panel.hidden = !open;
    btnSettings.setAttribute("aria-expanded", String(open));
  }

  function openHelp() {
    if (help.open) return;
    if (typeof help.showModal === "function") help.showModal();
    else help.setAttribute("open", "");
  }

  function closeHelp() {
    if (typeof help.close === "function") help.close();
    else help.removeAttribute("open");
  }

  function radio(name, value, label, content) {
    const wrap = el("label", label);
    const input = el("input");
    input.type = "radio";
    input.name = name;
    input.value = value;
    wrap.append(input, content);
    return wrap;
  }

  function buildControls() {
    CHARSET_KEYS.forEach((key, i) => {
      const set = CHARSETS[key];
      const box = el("span", "opt-box");
      box.append(el("b", "", set.label), el("small", "", set.sample));
      const opt = radio("charset", key, "opt", box);
      opt.title = `${set.label} (${i + 1})`;
      charsetGroup.append(opt);
    });
    for (const key of PALETTE_KEYS) {
      const p = PALETTES[key];
      const chip = el("span", "sw-chip");
      chip.setAttribute("aria-hidden", "true");
      chip.style.setProperty("--sw-bg", p.bg);
      if (p.mode === "gradient") chip.style.setProperty("--sw-grad", `linear-gradient(0deg, ${p.stops.join(", ")})`);
      else if (p.mode === "source") chip.style.setProperty("--sw-grad", "conic-gradient(#ff5e5e, #ffd84d, #5dff9a, #4dc7ff, #b77bff, #ff5e5e)");
      else chip.style.setProperty("--sw-fg", p.fg);
      const box = el("span", "sw-box");
      box.append(chip, el("span", "", p.label));
      paletteGroup.append(radio("palette", key, p.mode ? "swatch is-gradient" : "swatch", box));
    }
    for (const fps of FPS_CHOICES) fpsGroup.append(radio("fps", String(fps), "chip", el("span", "", `${fps} fps`)));
    btnFullscreen.hidden = !fsEnabled;
    btnRecord.hidden = !recFormat;
  }

  function setRange(input, value) {
    input.value = String(value);
    const min = Number(input.min), max = Number(input.max);
    const p = ((Number(input.value) - min) / (max - min)) * 100;
    const bipolar = input.hasAttribute("data-bipolar");
    input.style.setProperty("--from", `${bipolar ? Math.min(p, 50) : 0}%`);
    input.style.setProperty("--to", `${bipolar ? Math.max(p, 50) : p}%`);
  }

  const signed = (v) => (v > 0 ? `+${v}` : String(v));

  function syncControls() {
    for (const [group, value] of [[charsetGroup, settings.charset], [paletteGroup, settings.palette], [fpsGroup, String(settings.fps)]]) {
      for (const input of group.querySelectorAll("input")) input.checked = input.value === value;
    }
    customField.hidden = settings.charset !== "custom";
    if (document.activeElement !== customInput) customInput.value = settings.custom;
    setRange(detailIn, settings.detail || autoDetail());
    setRange(brightnessIn, settings.brightness);
    setRange(contrastIn, settings.contrast);
    brightnessOut.textContent = signed(settings.brightness);
    contrastOut.textContent = signed(settings.contrast);
    for (const [key, input] of Object.entries(switches)) input.checked = settings[key];
    const braille = !!CHARSETS[settings.charset].braille;
    switches.edges.disabled = braille;
    edgesSwitch.classList.toggle("is-disabled", braille);
    edgesSwitch.title = braille ? "Edges are not available with Braille" : "Edges (E)";
    statsEl.hidden = !settings.stats;
  }

  function update(patch) {
    const changed = Object.keys(patch).filter((key) => has(DEFAULTS, key) && settings[key] !== patch[key]);
    if (!changed.length) return;
    for (const key of changed) settings[key] = patch[key];
    const touched = (key) => changed.includes(key);
    persist();
    if (touched("palette")) applyPalette();
    if (touched("mirror") || touched("charset")) freshTemporal = true;
    if (touched("autoLevels")) levels.fresh = true;
    if (touched("charset") || touched("custom") || touched("detail")) relayout();
    syncControls();
    invalidate();
  }

  function cycle(list, current, step) {
    return list[(list.indexOf(current) + step + list.length) % list.length];
  }

  function onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat && e.key === " ") return;
    const t = e.target;
    const tag = t && t.tagName;
    const typing = t && (t.isContentEditable || tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && !/^(range|checkbox|radio)$/.test(t.type)));
    if (typing) {
      if (e.key === "Escape") t.blur();
      return;
    }
    if (help.open) return; // the dialog handles Escape itself
    if ((e.key === " " || e.key === "Enter") && t && t.closest && t.closest("button, a, select, input[type=checkbox], input[type=radio]")) return;
    const live = state === "live" || state === "paused";
    let handled = true;
    switch (e.key) {
      case " ":
        if (state === "idle") startCamera();
        else if (state === "live") pause();
        else if (state === "paused") resume();
        break;
      case "s": case "S": snapshot(); break;
      case "c": case "C": copyText(); break;
      case "r": case "R": if (rec) stopRecording(); else startRecording(); break;
      case "f": case "F": toggleFullscreen(); break;
      case "o": case "O": togglePanel(); break;
      case "?": case "h": case "H": openHelp(); break;
      case "p": update({ palette: cycle(PALETTE_KEYS, settings.palette, 1) }); break;
      case "P": update({ palette: cycle(PALETTE_KEYS, settings.palette, -1) }); break;
      case "[": update({ detail: clamp((settings.detail || autoDetail()) - 8, DETAIL_MIN, DETAIL_MAX) }); break;
      case "]": update({ detail: clamp((settings.detail || autoDetail()) + 8, DETAIL_MIN, DETAIL_MAX) }); break;
      case "i": case "I": update({ invert: !settings.invert }); break;
      case "e": case "E": if (!CHARSETS[settings.charset].braille) update({ edges: !settings.edges }); break;
      case "m": case "M": update({ mirror: !settings.mirror }); break;
      case "l": case "L": update({ autoLevels: !settings.autoLevels }); break;
      case "v": case "V": if (live) flipCamera(); break;
      case "x": case "X": if (live || state === "starting") stopCamera(); break;
      case "Escape":
        if (!notice.hidden) hideNotice();
        else if (!panel.hidden) {
          togglePanel(false);
          btnSettings.focus();
        } else handled = false;
        break;
      default:
        if (e.key.length === 1 && e.key >= "1" && e.key <= String(CHARSET_KEYS.length)) update({ charset: CHARSET_KEYS[Number(e.key) - 1] });
        else handled = false;
    }
    if (handled) e.preventDefault();
  }

  function onVisibility() {
    if (document.hidden) {
      stopLoop();
      return;
    }
    startLoop();
    if (state === "live" || state === "paused") requestWakeLock();
  }

  function bindEvents() {
    btnMain.addEventListener("click", () => {
      if (state === "idle") startCamera();
      else if (state === "live" || state === "paused") snapshot();
    });
    btnPause.addEventListener("click", () => (state === "paused" ? resume() : pause()));
    btnStop.addEventListener("click", stopCamera);
    btnFlip.addEventListener("click", flipCamera);
    btnSettings.addEventListener("click", () => togglePanel());
    btnPanelClose.addEventListener("click", () => {
      togglePanel(false);
      btnSettings.focus();
    });
    btnCopy.addEventListener("click", copyText);
    btnRecord.addEventListener("click", () => (rec ? stopRecording() : startRecording()));
    btnFullscreen.addEventListener("click", toggleFullscreen);
    btnHelp.addEventListener("click", openHelp);
    helpClose.addEventListener("click", closeHelp);
    help.addEventListener("click", (e) => {
      if (e.target !== help) return; // only the backdrop, not the dialog's own padding
      const r = help.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeHelp();
    });
    noticeClose.addEventListener("click", hideNotice);
    noticeRetry.addEventListener("click", () => {
      hideNotice();
      startCamera();
    });

    charsetGroup.addEventListener("change", (e) => update({ charset: e.target.value }));
    paletteGroup.addEventListener("change", (e) => update({ palette: e.target.value }));
    fpsGroup.addEventListener("change", (e) => update({ fps: Number(e.target.value) }));
    customInput.addEventListener("input", () => {
      const value = cleanChars(customInput.value);
      if (value) update({ custom: value });
    });
    customInput.addEventListener("blur", () => {
      customInput.value = settings.custom;
    });
    detailIn.addEventListener("input", () => update({ detail: Number(detailIn.value) }));
    brightnessIn.addEventListener("input", () => update({ brightness: Number(brightnessIn.value) }));
    contrastIn.addEventListener("input", () => update({ contrast: Number(contrastIn.value) }));
    brightnessIn.addEventListener("dblclick", () => update({ brightness: 0 }));
    contrastIn.addEventListener("dblclick", () => update({ contrast: 0 }));
    for (const [key, input] of Object.entries(switches)) input.addEventListener("change", () => update({ [key]: input.checked }));
    cameraSelect.addEventListener("change", () => {
      settings.camera = cameraSelect.value;
      persist();
      switchCamera(cameraSelect.value);
    });
    btnReset.addEventListener("click", () => {
      update({ ...DEFAULTS, camera: settings.camera });
      toast("Settings reset");
    });

    // A mouse or touch click shouldn't leave focus on a button or toggle, otherwise Space
    // would re-trigger it instead of pausing. Keyboard activation (detail 0) keeps focus.
    document.addEventListener("click", (e) => {
      if (e.detail === 0) return;
      setTimeout(() => {
        const a = document.activeElement;
        if (a && a.matches && a.matches("button, input[type=checkbox], input[type=radio]")) a.blur();
      });
    });
    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("webkitfullscreenchange", syncFullscreen);
    window.addEventListener("pagehide", () => {
      if (saveTimer) flushSettings();
    });
    if (window.ResizeObserver) {
      new ResizeObserver(onResize).observe(stage);
      // Zooming changes devicePixelRatio without resizing the stage in CSS pixels.
      let dpr = window.devicePixelRatio;
      window.addEventListener("resize", () => {
        if (window.devicePixelRatio === dpr) return;
        dpr = window.devicePixelRatio;
        onResize();
      });
    } else {
      window.addEventListener("resize", onResize);
    }
    onMediaChange(reducedMotion, startLoop);
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    }
  }

  // ---------------------------------------------------------------------------
  // Start-up
  // ---------------------------------------------------------------------------
  buildControls();
  applyPalette();
  renderer = createRenderer();
  sizeCanvas();
  sizeDemo();
  relayout();
  syncControls();
  bindEvents();
  setState("idle");
  refreshDevices(); // with a remembered permission the camera list is available right away

  if (params.has("debug")) {
    window.asciiCam = {
      get state() { return state; },
      get renderer() { return renderer.name; },
      get loop() { return loopKind; },
      get recording() { return !!rec; },
      layout, settings, stat, frameText,
    };
  }
})();
