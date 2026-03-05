(() => {
  "use strict";

  // ---- Character ramps (dark → light) ----
  const RAMPS = {
    simple:   " .:-=+*#%@",
    standard: " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
    detailed: " .`'^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
    blocks:   " ░▒▓█",
  };

  // ---- DOM refs ----
  const video        = document.getElementById("webcam");
  const asciiOutput  = document.getElementById("ascii-output");
  const btnToggle    = document.getElementById("btn-toggle");
  const btnScreenshot = document.getElementById("btn-screenshot");
  const resolutionIn = document.getElementById("resolution");
  const resolutionVal = document.getElementById("resolution-val");
  const fontSizeIn   = document.getElementById("font-size");
  const fontSizeVal  = document.getElementById("font-size-val");
  const rampSelect   = document.getElementById("ramp-select");
  const colorModeIn  = document.getElementById("color-mode");
  const invertIn     = document.getElementById("invert");
  const btnMenu      = document.getElementById("btn-menu");
  const drawer       = document.getElementById("controls-drawer");

  // ---- State ----
  let stream    = null;
  let running   = false;
  let rafId     = null;
  let cols      = parseInt(resolutionIn.value, 10);
  let fontSize  = parseInt(fontSizeIn.value, 10);
  let rampKey   = rampSelect.value;
  let colorMode = colorModeIn.checked;
  let invert    = invertIn.checked;

  const canvas = document.createElement("canvas");
  const ctx    = canvas.getContext("2d", { willReadFrequently: true });

  const TARGET_FPS  = 20;
  const FRAME_DELAY = 1000 / TARGET_FPS;
  let lastFrameTime = 0;

  // Character cells approximate a 1:2 width-to-height ratio
  const CELL_ASPECT = 0.5;

  // ---- Helpers ----
  function getRamp() {
    let ramp = RAMPS[rampKey] || RAMPS.standard;
    return invert ? ramp : [...ramp].reverse().join("");
  }

  function brightnessToChar(brightness, ramp) {
    const idx = Math.floor(brightness * (ramp.length - 1));
    return ramp[Math.min(idx, ramp.length - 1)];
  }

  // ---- Core render ----
  function renderFrame(timestamp) {
    if (!running) return;

    if (timestamp - lastFrameTime < FRAME_DELAY) {
      rafId = requestAnimationFrame(renderFrame);
      return;
    }
    lastFrameTime = timestamp;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
      rafId = requestAnimationFrame(renderFrame);
      return;
    }

    const rows = Math.round(cols * (vh / vw) * CELL_ASPECT);
    canvas.width  = cols;
    canvas.height = rows;

    ctx.drawImage(video, 0, 0, cols, rows);
    const { data } = ctx.getImageData(0, 0, cols, rows);

    const ramp = getRamp();

    if (colorMode) {
      renderColor(data, cols, rows, ramp);
    } else {
      renderMono(data, cols, rows, ramp);
    }

    rafId = requestAnimationFrame(renderFrame);
  }

  function renderMono(data, w, h, ramp) {
    let str = "";
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const brightness = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
        str += brightnessToChar(brightness, ramp);
      }
      if (y < h - 1) str += "\n";
    }
    asciiOutput.textContent = str;
  }

  function renderColor(data, w, h, ramp) {
    let html = "";
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const ch = brightnessToChar(brightness, ramp);
        const safe = ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : ch;
        html += `<span style="color:rgb(${r},${g},${b})">${safe}</span>`;
      }
      if (y < h - 1) html += "\n";
    }
    asciiOutput.innerHTML = html;
  }

  // ---- Webcam start / stop ----
  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      running = true;
      btnToggle.textContent = "Stop Camera";
      btnScreenshot.disabled = false;
      rafId = requestAnimationFrame(renderFrame);
    } catch (err) {
      asciiOutput.textContent = "Camera access denied or unavailable.\n\n" + err.message;
    }
  }

  function stopCamera() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
    btnToggle.textContent = "Start Camera";
    btnScreenshot.disabled = true;
    asciiOutput.textContent = 'Press "Start Camera" to begin.';
  }

  // ---- Screenshot ----
  function takeScreenshot() {
    const pre = asciiOutput;
    const text = pre.textContent || pre.innerText;
    const lines = text.split("\n");
    const maxLen = Math.max(...lines.map((l) => l.length));

    const measureCanvas = document.createElement("canvas");
    const mCtx = measureCanvas.getContext("2d");
    const font = `${fontSize}px "Courier New", Courier, monospace`;
    mCtx.font = font;
    const baseCharW = mCtx.measureText("M").width;
    const letterSpacing = fontSize * 0.05;
    const cellW = baseCharW + letterSpacing;
    const cellH = fontSize;

    const padding = 16;
    const imgW = Math.ceil(cellW * maxLen) + padding * 2;
    const imgH = Math.ceil(cellH * lines.length) + padding * 2;

    const shotCanvas = document.createElement("canvas");
    shotCanvas.width  = imgW;
    shotCanvas.height = imgH;
    const sCtx = shotCanvas.getContext("2d");

    sCtx.fillStyle = "#0f0f1a";
    sCtx.fillRect(0, 0, imgW, imgH);
    sCtx.font = font;
    sCtx.textBaseline = "top";

    if (colorMode && pre.children.length > 0) {
      let idx = 0;
      for (let row = 0; row < lines.length; row++) {
        const lineLen = lines[row].length;
        for (let col = 0; col < lineLen; col++) {
          const span = pre.children[idx];
          if (span) {
            sCtx.fillStyle = span.style.color || "#e0e0e0";
            sCtx.fillText(span.textContent, padding + col * cellW, padding + row * cellH);
          }
          idx++;
        }
      }
    } else {
      sCtx.fillStyle = "#e0e0e0";
      for (let row = 0; row < lines.length; row++) {
        for (let col = 0; col < lines[row].length; col++) {
          sCtx.fillText(lines[row][col], padding + col * cellW, padding + row * cellH);
        }
      }
    }

    shotCanvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ascii-art-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // ---- Event listeners ----
  btnToggle.addEventListener("click", () => {
    running ? stopCamera() : startCamera();
  });

  btnScreenshot.addEventListener("click", takeScreenshot);

  resolutionIn.addEventListener("input", () => {
    cols = parseInt(resolutionIn.value, 10);
    resolutionVal.textContent = cols;
  });

  fontSizeIn.addEventListener("input", () => {
    fontSize = parseInt(fontSizeIn.value, 10);
    fontSizeVal.textContent = fontSize + "px";
    asciiOutput.style.fontSize = fontSize + "px";
  });

  rampSelect.addEventListener("change", () => {
    rampKey = rampSelect.value;
  });

  colorModeIn.addEventListener("change", () => {
    colorMode = colorModeIn.checked;
  });

  invertIn.addEventListener("change", () => {
    invert = invertIn.checked;
  });

  btnMenu.addEventListener("click", () => {
    drawer.classList.toggle("open");
  });

  // ---- Auto-fit defaults to viewport ----
  function autoFit() {
    const vw = window.innerWidth;
    const idealCols = Math.max(40, Math.min(Math.floor(vw / 5), 200));
    cols = idealCols;
    resolutionIn.value = cols;
    resolutionVal.textContent = cols;

    if (vw < 500) {
      fontSize = 5;
    } else if (vw < 900) {
      fontSize = 6;
    } else {
      fontSize = 8;
    }
    fontSizeIn.value = fontSize;
    fontSizeVal.textContent = fontSize + "px";
    asciiOutput.style.fontSize = fontSize + "px";
  }
  autoFit();
})();
