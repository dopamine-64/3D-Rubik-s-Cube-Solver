const FACE_ORDER = ["U", "R", "F", "D", "L", "B"];
const FACE_NAMES = {
  U: "Up",
  R: "Right",
  F: "Front",
  D: "Down",
  L: "Left",
  B: "Back"
};

const COLOR_CLASSES = ["white", "yellow", "red", "orange", "blue", "green"];

// NOTE: we intentionally do NOT hard-code which color belongs on which face
// (e.g. "green is always Front"). Physical cubes are sold with different
// color arrangements, and even for a "standard" cube the user might have
// held it in any rotation while capturing. Instead, whichever color shows
// up at a face's own center sticker IS that face's color — see
// buildColorToFaceMapping() below, which derives this from what was
// actually captured.

// Reference hues (in degrees, 0-360) for the 5 saturated cube colors.
// White is handled separately (low saturation / high brightness), since hue
// is meaningless for it. Hue-based matching is far more robust to lighting
// changes (shadows, camera white balance, brightness) than raw RGB distance.
const HUE_REFERENCE = [
  { name: "red", hue: 5 },
  { name: "orange", hue: 30 },
  { name: "yellow", hue: 55 },
  { name: "green", hue: 130 },
  { name: "blue", hue: 215 }
];

const state = {
  captures: {},   // face -> { canvas, dataUrl }
  detected: {},   // face -> array(9) of color names
  solution: [],
  currentFaceIndex: 0,
  stream: null,
  facingMode: "environment",
  activeColor: "white", // currently selected paint color for manual correction
  vis: null, // 3D visualizer state: { snapshots, moves, faceToColor, step }
  viewRot: { x: -28, y: -35 } // user-draggable 3D cube orientation, in degrees
};

const cameraWrap = document.getElementById("cameraWrap");
const cameraVideo = document.getElementById("cameraVideo");
const cameraOffMsg = document.getElementById("cameraOffMsg");
const cameraToggleBtn = document.getElementById("cameraToggleBtn");
const currentFaceLabel = document.getElementById("currentFaceLabel");
const captureHint = document.getElementById("captureHint");
const thumbsRow = document.getElementById("thumbsRow");
const detectBtn = document.getElementById("detectBtn");
const solveBtn = document.getElementById("solveBtn");
const resetBtn = document.getElementById("resetBtn");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("statusText");
const solutionStepsEl = document.getElementById("solutionSteps");
const paletteEl = document.getElementById("palette");
const solutionOverlayEl = document.getElementById("solutionOverlay");
const solutionCloseBtn = document.getElementById("solutionCloseBtn");
const cube3dWrap = document.getElementById("cube3dWrap");
const cube3dSceneEl = document.getElementById("cube3dScene");
const cube3dEl = document.getElementById("cube3d");
const stepLabelEl = document.getElementById("stepLabel");
const nextStepBtn = document.getElementById("nextStepBtn");
const prevStepBtn = document.getElementById("prevStepBtn");
const restartStepBtn = document.getElementById("restartStepBtn");

function init() {
  FACE_ORDER.forEach((face) => {
    state.detected[face] = new Array(9).fill(null);
  });

  buildThumbs();
  createNet();
  bindPalette();
  build3DCube();
  applyViewRotation();
  bindCubeDrag();
  updateFaceLabel();
  bindActions();
  warmUpSolver();
  updateProgressTrack();
}

function bindActions() {
  cameraToggleBtn.addEventListener("click", toggleCamera);
  detectBtn.addEventListener("click", detectAllFaces);
  solveBtn.addEventListener("click", solveCube);
  resetBtn.addEventListener("click", resetAll);
  nextStepBtn.addEventListener("click", handleNextStep);
  prevStepBtn.addEventListener("click", handlePrevStep);
  restartStepBtn.addEventListener("click", handleRestartStep);
  solutionCloseBtn.addEventListener("click", hideSolutionOverlay);
  solutionOverlayEl.addEventListener("click", (e) => {
    if (e.target === solutionOverlayEl) hideSolutionOverlay();
  });
  bindSpacebarCapture();
}

// Capture is spacebar-only now (no on-screen "Capture" button, no file
// upload fallback) — press Space while the camera is on to grab whichever
// face is currently selected. Ignored while the solution overlay is open,
// or while focus sits on an interactive element (so Space still activates
// buttons normally).
function bindSpacebarCapture() {
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") {
      if (e.key === "Escape" && !solutionOverlayEl.classList.contains("hidden")) {
        hideSolutionOverlay();
      }
      return;
    }
    if (!solutionOverlayEl.classList.contains("hidden")) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!state.stream) return;
    e.preventDefault();
    captureCurrentFace();
  });
}

function updateStatus(message) {
  statusTextEl.textContent = message;
}

/* ---------- Camera ---------- */

function toggleCamera() {
  if (state.stream) {
    stopCamera();
    cameraOffMsg.classList.remove("hidden");
    cameraToggleBtn.textContent = "Turn on camera";
    updateStatus("Camera turned off. Turn it back on, or set colors manually below.");
  } else {
    startCamera();
  }
}

async function startCamera() {
  try {
    stopCamera();
    const constraints = {
      video: {
        facingMode: { ideal: state.facingMode },
        width: { ideal: 1280 },
        height: { ideal: 960 }
      },
      audio: false
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.stream = stream;
    cameraVideo.srcObject = stream;

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    cameraWrap.classList.toggle("using-back", settings.facingMode !== "user");

    cameraOffMsg.classList.add("hidden");
    cameraToggleBtn.textContent = "Turn off camera";
    updateStatus("Camera ready. Align a face inside the frame and press Space to capture.");
  } catch (err) {
    updateStatus(
      "Couldn't access the camera (" + err.message + "). You can set colors manually below instead."
    );
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
}

/* ---------- Capture flow ---------- */

function currentFace() {
  return FACE_ORDER[state.currentFaceIndex];
}

function updateFaceLabel() {
  const face = currentFace();
  currentFaceLabel.textContent = `${FACE_NAMES[face]} (${face})`;
  const already = !!state.captures[face];
  captureHint.textContent = already
    ? "Already captured — press Space again to retake this face."
    : "Turn on the camera, fill the frame with just this face, then press Space to capture.";
}

function captureCurrentFace() {
  if (!cameraVideo.videoWidth) {
    updateStatus("Camera isn't ready yet — give it a moment and try again.");
    return;
  }
  const face = currentFace();
  const canvas = document.createElement("canvas");
  canvas.width = cameraVideo.videoWidth;
  canvas.height = cameraVideo.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  // Only mirror the drawn frame if we're mirroring the live preview (front camera).
  if (getComputedStyle(cameraVideo).transform !== "none" && !cameraWrap.classList.contains("using-back")) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(cameraVideo, 0, 0, canvas.width, canvas.height);

  storeCapture(face, canvas, true);
  advanceAfterCapture();
}

function storeCapture(face, canvas, isLive) {
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  state.captures[face] = { canvas, dataUrl, isLive: !!isLive };
  renderThumb(face);

  // Detect colors for this face immediately so the net updates right away —
  // no need to wait and press "Detect Colors" separately.
  try {
    detectFaceFromCanvas(face, canvas, !!isLive);
    updateStatus(`Captured ${FACE_NAMES[face]} — colors detected. Click any cell to correct it.`);
  } catch (err) {
    state.detected[face] = new Array(9).fill(null);
    updateStatus(`Captured ${FACE_NAMES[face]}, but color detection failed: ${err.message}`);
  }
  renderNet();
  checkReady();
}

function advanceAfterCapture() {
  const nextIncomplete = FACE_ORDER.findIndex((f) => !state.captures[f]);
  state.currentFaceIndex = nextIncomplete === -1
    ? Math.min(state.currentFaceIndex + 1, FACE_ORDER.length - 1)
    : nextIncomplete;
  updateFaceLabel();
  highlightActiveThumb();
}

function checkReady() {
  const allCaptured = FACE_ORDER.every((f) => state.captures[f]);
  // "Detect Colors" only makes sense once every face has been captured (it
  // re-scans the captured photos). Solving, on the other hand, only needs
  // every sticker to have a color assigned — which can come from detection
  // OR purely from manual clicks, with no camera/photos involved at all.
  detectBtn.disabled = !allCaptured;
  updateSolveAvailability();
}

function allColorsAssigned() {
  return FACE_ORDER.every(
    (f) => state.detected[f] && state.detected[f].every((c) => !!c)
  );
}

function updateSolveAvailability() {
  solveBtn.disabled = !allColorsAssigned();
  updateProgressTrack();
}

function updateProgressTrack() {
  const scanDone = allColorsAssigned();
  const solveDone = !!state.vis;
  const isDone = (step) => (step === 1 && scanDone) || (step >= 2 && solveDone);
  const isActive = (step) =>
    (step === 1 && !scanDone) ||
    (step === 2 && scanDone && !solveDone) ||
    (step === 3 && solveDone);

  document.querySelectorAll(".progress-step").forEach((el) => {
    const step = Number(el.dataset.step);
    el.classList.toggle("done", isDone(step));
    el.classList.toggle("active", isActive(step));
  });

  // Mirror the same state onto each panel's own step badge, so the "which
  // step am I on" signal is consistent wherever it appears in the UI.
  document.querySelectorAll("[data-step-panel]").forEach((el) => {
    const step = Number(el.dataset.stepPanel);
    const badge = el.querySelector(".panel-index");
    if (!badge) return;
    badge.classList.toggle("done", isDone(step));
    badge.classList.toggle("active", isActive(step));
  });
}

/* ---------- Thumbnails (also used to jump/retake a face) ---------- */

function buildThumbs() {
  thumbsRow.innerHTML = "";
  FACE_ORDER.forEach((face, idx) => {
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "thumb empty";
    thumb.dataset.face = face;
    thumb.textContent = `${face}`;
    thumb.title = `${FACE_NAMES[face]} — click to (re)capture`;
    thumb.addEventListener("click", () => {
      state.currentFaceIndex = idx;
      updateFaceLabel();
      highlightActiveThumb();
    });
    thumbsRow.appendChild(thumb);
  });
  highlightActiveThumb();
}

function renderThumb(face) {
  const thumb = thumbsRow.querySelector(`.thumb[data-face="${face}"]`);
  if (!thumb) return;
  const capture = state.captures[face];
  thumb.innerHTML = "";
  thumb.classList.remove("empty");
  if (capture) {
    const img = document.createElement("img");
    img.src = capture.dataUrl;
    thumb.appendChild(img);
    const label = document.createElement("span");
    label.className = "thumb-label";
    label.textContent = face;
    thumb.appendChild(label);
    const retake = document.createElement("span");
    retake.className = "retake-badge";
    retake.textContent = "retake";
    thumb.appendChild(retake);
  } else {
    thumb.classList.add("empty");
    thumb.textContent = face;
  }
}

function highlightActiveThumb() {
  thumbsRow.querySelectorAll(".thumb").forEach((t) => {
    t.classList.toggle("active", t.dataset.face === currentFace());
  });
}

/* ---------- Cube net preview + manual correction ---------- */

function createNet() {
  document.querySelectorAll(".face-preview").forEach((faceEl) => {
    const face = faceEl.dataset.face;
    faceEl.innerHTML = "";
    for (let i = 0; i < 9; i++) {
      const c = document.createElement("button");
      c.type = "button";
      c.className = "cell";
      c.dataset.index = i;
      c.dataset.face = face;
      c.title = "Click to paint with the selected color";
      c.addEventListener("click", () => paintCellWithActiveColor(face, i));
      faceEl.appendChild(c);
    }
  });
}

// Quick palette: pick a color once, then just click cells to paint them —
// far faster than cycling through 6 colors per click, especially when
// setting up a cube entirely by hand.
function bindPalette() {
  paletteEl.querySelectorAll(".swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeColor = btn.dataset.color || null; // "" (eraser) -> null
      paletteEl.querySelectorAll(".swatch").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });
}

function paintCellWithActiveColor(faceKey, index) {
  state.detected[faceKey][index] = state.activeColor;
  renderNet();
  updateSolveAvailability();
}

function paintCell(cell, color) {
  cell.className = "cell";
  if (color) cell.classList.add(color);
}

function renderNet() {
  document.querySelectorAll(".face-preview").forEach((faceEl) => {
    const face = faceEl.dataset.face;
    const cells = faceEl.querySelectorAll(".cell");
    cells.forEach((cell, i) => paintCell(cell, state.detected[face][i]));
  });
}

/* ---------- Real color detection from captured photos ---------- */

// Manually re-run detection on every captured face (useful after retaking
// a face via the file fallback, or just to refresh after nudging the cube).
async function detectAllFaces() {
  const uploaded = FACE_ORDER.every((f) => state.captures[f]);
  if (!uploaded) {
    updateStatus("Please capture all 6 face photos first.");
    return;
  }

  detectBtn.disabled = true;
  updateStatus("Re-detecting colors from captured photos…");

  for (const face of FACE_ORDER) {
    try {
      const capture = state.captures[face];
      detectFaceFromCanvas(face, capture.canvas, capture.isLive);
    } catch (err) {
      updateStatus(`Could not read image for ${FACE_NAMES[face]}: ${err.message}`);
      detectBtn.disabled = false;
      return;
    }
  }

  renderNet();
  updateStatus("Colors detected. Review and click any cell to correct it, then solve.");
  detectBtn.disabled = false;
  updateSolveAvailability();
}

// Works out the pixel rectangle that's actually visible to the user, matching
// what the CSS `object-fit: cover` preview (and its guide square) shows —
// otherwise we'd sample background/hand pixels instead of the cube stickers.
function getVisibleRect(canvasWidth, canvasHeight, targetAspect) {
  const nativeAspect = canvasWidth / canvasHeight;
  let visW, visH, visX, visY;
  if (nativeAspect > targetAspect) {
    visH = canvasHeight;
    visW = canvasHeight * targetAspect;
    visX = (canvasWidth - visW) / 2;
    visY = 0;
  } else {
    visW = canvasWidth;
    visH = canvasWidth / targetAspect;
    visX = 0;
    visY = (canvasHeight - visH) / 2;
  }
  return { x: visX, y: visY, w: visW, h: visH };
}

function detectFaceFromCanvas(face, canvas, isLive) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  // For live captures, restrict sampling to the same square the user saw the
  // on-screen guide overlay on (inset 12% inside a 4:3 preview) — otherwise
  // we'd average in background pixels around the cube. Uploaded fallback
  // photos have no guide overlay, so sample a generous centered square instead.
  let region;
  if (isLive) {
    const visible = getVisibleRect(canvas.width, canvas.height, 4 / 3);
    const inset = 0.12;
    region = {
      x: visible.x + visible.w * inset,
      y: visible.y + visible.h * inset,
      w: visible.w * (1 - 2 * inset),
      h: visible.h * (1 - 2 * inset)
    };
  } else {
    const inset = 0.15;
    region = {
      x: canvas.width * inset,
      y: canvas.height * inset,
      w: canvas.width * (1 - 2 * inset),
      h: canvas.height * (1 - 2 * inset)
    };
  }

  // 3x3 grid of sample centers within that region.
  const fracs = [1 / 6, 3 / 6, 5 / 6];
  const patchSize = Math.max(4, Math.floor(Math.min(region.w, region.h) * 0.12));

  const detected = [];
  for (const fy of fracs) {
    for (const fx of fracs) {
      const cx = Math.floor(region.x + region.w * fx);
      const cy = Math.floor(region.y + region.h * fy);
      const half = Math.floor(patchSize / 2);
      const sx = Math.max(0, Math.min(canvas.width - 1, cx - half));
      const sy = Math.max(0, Math.min(canvas.height - 1, cy - half));
      const w = Math.min(patchSize, canvas.width - sx);
      const h = Math.min(patchSize, canvas.height - sy);
      const { data } = ctx.getImageData(sx, sy, Math.max(1, w), Math.max(1, h));

      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);

      detected.push(classifyStickerColor(r, g, b));
    }
  }

  state.detected[face] = detected;
}

function rgbToHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
  }
  if (h < 0) h += 360;

  const s = max === 0 ? 0 : delta / max;
  const v = max;
  return { h, s, v };
}

function hueDistance(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// Classifies a sampled RGB patch as one of the 6 cube colors using HSV,
// which is far more robust to brightness/lighting changes than raw RGB
// distance (a shadowed white sticker is still "white": low saturation, and
// a bright yellow under sun is still "yellow": hue ~55, regardless of value).
function classifyStickerColor(r, g, b) {
  const { h, s, v } = rgbToHsv(r, g, b);

  // Very dark patch (e.g. shadow, gap between stickers) — fall back to
  // nearest hue anyway rather than guessing black, since black isn't a
  // valid cube color.
  if (s < 0.22 && v > 0.5) {
    return "white";
  }

  let best = null;
  let bestDist = Infinity;
  for (const ref of HUE_REFERENCE) {
    const dist = hueDistance(h, ref.hue);
    if (dist < bestDist) {
      bestDist = dist;
      best = ref.name;
    }
  }
  return best;
}

/* ---------- Validation + solving ---------- */

// Derives which color belongs to which face from what was actually
// captured: whatever color shows up at a face's own center sticker is that
// face's color (centers never move on a real cube, no matter how the user
// held it while capturing). This works for any color arrangement/orientation
// instead of assuming a fixed scheme like "green is always Front".
function buildColorToFaceMapping() {
  const mapping = {};
  for (const face of FACE_ORDER) {
    const center = state.detected[face] && state.detected[face][4];
    if (center) mapping[center] = face;
  }
  return mapping;
}

function buildCubeString(colorToFace) {
  const all = [];
  for (const face of FACE_ORDER) {
    const stickers = state.detected[face];
    if (!stickers || stickers.some((c) => !c)) {
      throw new Error(`Face ${FACE_NAMES[face]} is incomplete.`);
    }
    stickers.forEach((color) => {
      const mapped = colorToFace[color];
      if (!mapped) throw new Error(`Unknown color "${color}".`);
      all.push(mapped);
    });
  }
  return all.join("");
}

function validateColorCounts() {
  const counts = {};
  FACE_ORDER.forEach((face) => {
    (state.detected[face] || []).forEach((color) => {
      if (color) counts[color] = (counts[color] || 0) + 1;
    });
  });
  for (const color of COLOR_CLASSES) {
    if (counts[color] !== 9) {
      throw new Error(
        `Each color must appear exactly 9 times. "${color}" appears ${counts[color] || 0} time(s).`
      );
    }
  }
}

function validateCenters() {
  // Each face's center defines that face's color, so all 6 centers must be
  // distinct colors — if two faces share a center color (or one is missing),
  // something was captured wrong or a cell needs manual correction.
  const centers = FACE_ORDER.map((face) => state.detected[face] && state.detected[face][4]);
  const seen = new Map();
  centers.forEach((color, idx) => {
    const face = FACE_ORDER[idx];
    if (!color) {
      throw new Error(`Center of ${FACE_NAMES[face]} face wasn't detected. Correct it manually.`);
    }
    if (seen.has(color)) {
      const otherFace = seen.get(color);
      throw new Error(
        `${FACE_NAMES[face]} and ${FACE_NAMES[otherFace]} both show ${color} as their center — ` +
          `each face needs a distinct center color. Correct the miscalled one manually.`
      );
    }
    seen.set(color, face);
  });
}

function warmUpSolver() {
  setTimeout(() => {
    try {
      if (window.Cube && typeof Cube.initSolver === "function") {
        Cube.initSolver();
      }
    } catch (e) {
      // Non-fatal — solve() will still build tables on demand.
    }
  }, 50);
}

/* ---------- Move optimization ---------- */
//
// cube.js's own two-phase search never checks whether the cube it's handed
// is *already* a phase-1/phase-2 solution before it starts recursing — it
// always spends at least one "search step" first. In practice that means a
// cube just 1–2 turns from solved can come back with several redundant
// moves tacked on that simply cancel each other out (e.g. "... R U U' ...").
// We fix this in two ways:
//   1. Try a fast brute-force search first for cubes that are only a few
//      moves from solved — this finds the *actual* shortest solution
//      directly, the same way most simple cube solvers short-circuit easy
//      cases instead of always running the full algorithm.
//   2. Post-process whatever solution we do get (brute-force or two-phase)
//      by canceling adjacent same-face moves and moves separated only by a
//      commuting opposite-face move (R and L commute, U and D commute, F
//      and B commute) — standard "algorithm reduction", the same kind of
//      cleanup other cube-solving apps apply before showing you a solution.

const ALL_MOVES = [];
["U", "R", "F", "D", "L", "B"].forEach((face) => {
  ALL_MOVES.push(face, face + "2", face + "'");
});

const OPPOSITE_FACE = { U: "D", D: "U", L: "R", R: "L", F: "B", B: "F" };

function faceOf(move) {
  return move[0];
}

function powerOf(move) {
  if (move.length === 1) return 1;
  if (move[1] === "2") return 2;
  return 3; // trailing '
}

function moveFromFacePower(face, power) {
  const p = ((power % 4) + 4) % 4;
  if (p === 0) return null;
  if (p === 1) return face;
  if (p === 2) return face + "2";
  return face + "'";
}

// Fast brute-force search for cubes that are only a handful of turns from
// solved — guarantees the truly shortest solution for these easy cases
// (this is what directly fixes "1-move scramble solved in 15 moves").
function bruteForceSolve(cube, maxDepth) {
  if (cube.isSolved()) return [];

  function search(currentCube, depthLeft, lastFace, path) {
    if (depthLeft === 0) return null;
    for (const move of ALL_MOVES) {
      const face = faceOf(move);
      // Skip repeating the same face twice in a row — any such pair is
      // always reachable more directly with a single move on that face.
      if (face === lastFace) continue;
      const next = currentCube.clone();
      next.move(move);
      const nextPath = path.concat(move);
      if (next.isSolved()) return nextPath;
      if (depthLeft > 1) {
        const found = search(next, depthLeft - 1, face, nextPath);
        if (found) return found;
      }
    }
    return null;
  }

  for (let depth = 1; depth <= maxDepth; depth++) {
    const found = search(cube, depth, null, []);
    if (found) return found;
  }
  return null;
}

// Standard algorithm-reduction pass: repeatedly cancel same-face moves that
// are adjacent, or separated only by a single move on a commuting
// (opposite) face.
function optimizeMoves(moves) {
  let list = moves.slice();
  let changed = true;
  while (changed) {
    changed = false;

    for (let i = 0; i < list.length - 1; i++) {
      if (faceOf(list[i]) === faceOf(list[i + 1])) {
        const merged = moveFromFacePower(faceOf(list[i]), powerOf(list[i]) + powerOf(list[i + 1]));
        list = list.slice(0, i).concat(merged ? [merged] : [], list.slice(i + 2));
        changed = true;
        break;
      }
    }
    if (changed) continue;

    for (let i = 0; i < list.length - 2; i++) {
      const a = faceOf(list[i]);
      const mid = faceOf(list[i + 1]);
      const b = faceOf(list[i + 2]);
      if (a === b && OPPOSITE_FACE[a] === mid) {
        const merged = moveFromFacePower(a, powerOf(list[i]) + powerOf(list[i + 2]));
        const replacement = merged ? [merged, list[i + 1]] : [list[i + 1]];
        list = list.slice(0, i).concat(replacement, list.slice(i + 3));
        changed = true;
        break;
      }
    }
  }
  return list;
}

// Safety net: replay the final move list on a fresh cube built from the same
// facelet string, and only trust it if it actually reaches solved.
function verifySolution(cubeString, moves) {
  try {
    const check = Cube.fromString(cubeString);
    if (moves.length) check.move(moves.join(" "));
    return check.isSolved();
  } catch (e) {
    return false;
  }
}

function solveCubeString(cubeString) {
  const seed = Cube.fromString(cubeString);

  // Cheap first: is this cube just a few turns from solved? (Handles the
  // "single move" case exactly, and anything up to 4 moves away.)
  let moves = bruteForceSolve(seed.clone(), 4);

  if (!moves) {
    const raw = seed.clone().solve();
    moves = raw ? raw.trim().split(/\s+/).filter(Boolean) : [];
  }

  moves = optimizeMoves(moves);

  if (!verifySolution(cubeString, moves)) {
    // Extremely unlikely, but never show a solution we haven't verified —
    // fall back to the library's raw (unoptimized) output instead.
    const raw = seed.clone().solve();
    moves = raw ? raw.trim().split(/\s+/).filter(Boolean) : [];
  }

  return moves;
}

/* ---------- 3D solution visualizer ---------- */
//
// Renders the cube as 27 little "cubie" boxes positioned in 3D space with
// CSS transforms. Rather than tracking cubie identity/rotation through each
// move (complex and error-prone), we use a simpler, robust trick: the 27
// cubies stay at FIXED grid positions the whole time. Each of their visible
// sticker faces is wired, once, to a fixed index (0-53) in the standard
// facelet string format cube.js uses (U R F D L B, 9 stickers each, in
// reading order). To show a move happening, we visually spin the *physical*
// cubies belonging to that layer, and once the spin finishes, repaint every
// sticker's color from the actual post-move facelet string. The animation
// is just for show — correctness always comes from repainting real solved
// state, never from tracking the animation itself.

const STICKER_HEX = {
  white: "#f9fafb",
  yellow: "#facc15",
  red: "#ef4444",
  orange: "#f97316",
  blue: "#3b82f6",
  green: "#22c55e"
};
const INNER_PLASTIC = "#1f2937";

const CUBIE_STEP = 40; // px between cubie centers
const FACE_HALF = 19; // px, half the cubie face size (matches CSS .cubie-face 38px)

// Static template for orienting each of a cubie's 6 potential sticker faces
// outward. This is the standard construction used in most CSS cube demos.
const FACE_TRANSFORM = {
  front: `translateZ(${FACE_HALF}px)`,
  back: `rotateY(180deg) translateZ(${FACE_HALF}px)`,
  right: `rotateY(90deg) translateZ(${FACE_HALF}px)`,
  left: `rotateY(-90deg) translateZ(${FACE_HALF}px)`,
  top: `rotateX(90deg) translateZ(${FACE_HALF}px)`,
  bottom: `rotateX(-90deg) translateZ(${FACE_HALF}px)`
};

// Grid coordinates: x: -1=Left..1=Right, y: -1=Up..1=Down, z: -1=Back..1=Front.
// (y is inverted from "math up" on purpose — it matches the CSS/screen axis
// directly, which is what keeps the rotation-direction math below simple
// and correct instead of fighting a sign flip everywhere.)

// Facelet reading order (matches the standard Kociemba/cube.js convention,
// verified directly against cube.js's own corner-facelet table): for each
// face, stickers are read row-major, top-to-bottom, left-to-right *as seen
// looking directly at that face from outside*.
function uIndex(x, z) {
  const row = z === 1 ? 2 : z === 0 ? 1 : 0; // back row first, front row last
  const col = x === -1 ? 0 : x === 0 ? 1 : 2;
  return row * 3 + col;
}
function dIndex(x, z) {
  const row = z === 1 ? 0 : z === 0 ? 1 : 2; // front row first, back row last
  const col = x === -1 ? 0 : x === 0 ? 1 : 2;
  return row * 3 + col;
}
function fIndex(x, y) {
  const row = y === -1 ? 0 : y === 0 ? 1 : 2; // top row first, bottom row last
  const col = x === -1 ? 0 : x === 0 ? 1 : 2;
  return row * 3 + col;
}
function bIndex(x, y) {
  const row = y === -1 ? 0 : y === 0 ? 1 : 2;
  const col = x === 1 ? 0 : x === 0 ? 1 : 2; // mirrored: right first (viewed from behind)
  return row * 3 + col;
}
function rIndex(y, z) {
  const row = y === -1 ? 0 : y === 0 ? 1 : 2;
  const col = z === 1 ? 0 : z === 0 ? 1 : 2; // front first, back last
  return row * 3 + col;
}
function lIndex(y, z) {
  const row = y === -1 ? 0 : y === 0 ? 1 : 2;
  const col = z === -1 ? 0 : z === 0 ? 1 : 2; // back first, front last
  return row * 3 + col;
}

// Which axis and rotation sign each move's clockwise (unprimed) turn uses.
// These signs are NOT hand-derived guesses — they were verified by
// simulating every quarter/double/prime move on the real cube.js library
// and confirming the predicted sticker permutation (for this exact grid +
// facelet-index scheme) exactly matches cube.js's actual result, including
// a chained 12-move sequence end-to-end.
const AXIS_FOR_FACE = { U: "Y", D: "Y", R: "X", L: "X", F: "Z", B: "Z" };
const BASE_ANGLE = { U: -90, D: 90, R: 90, L: -90, F: 90, B: -90 };
const LAYER_PREDICATE = {
  U: (x, y, z) => y === -1,
  D: (x, y, z) => y === 1,
  R: (x, y, z) => x === 1,
  L: (x, y, z) => x === -1,
  F: (x, y, z) => z === 1,
  B: (x, y, z) => z === -1
};

let cubieEls = [];
let cubieFaceByIndex = new Array(54).fill(null);
let layerPivotEl = null;

function build3DCube() {
  cube3dEl.innerHTML = "";
  cubieEls = [];
  cubieFaceByIndex = new Array(54).fill(null);
  layerPivotEl = null;

  [-1, 0, 1].forEach((x) => {
    [-1, 0, 1].forEach((y) => {
      [-1, 0, 1].forEach((z) => {
        const cubie = document.createElement("div");
        cubie.className = "cubie";
        cubie.dataset.x = x;
        cubie.dataset.y = y;
        cubie.dataset.z = z;
        cubie.style.transform = `translate3d(${x * CUBIE_STEP}px, ${y * CUBIE_STEP}px, ${z * CUBIE_STEP}px)`;

        addCubieFace(cubie, "right", x === 1 ? 9 + rIndex(y, z) : null);
        addCubieFace(cubie, "left", x === -1 ? 36 + lIndex(y, z) : null);
        addCubieFace(cubie, "top", y === -1 ? 0 + uIndex(x, z) : null);
        addCubieFace(cubie, "bottom", y === 1 ? 27 + dIndex(x, z) : null);
        addCubieFace(cubie, "front", z === 1 ? 18 + fIndex(x, y) : null);
        addCubieFace(cubie, "back", z === -1 ? 45 + bIndex(x, y) : null);

        cube3dEl.appendChild(cubie);
        cubieEls.push(cubie);
      });
    });
  });
}

// ---- Draggable orientation --------------------------------------------
// The cube's overall orientation (as opposed to any single layer's turning
// animation) is just a rotateX/rotateY on the outer .cube3d element, kept
// in state.viewRot so it survives repaints. A slight scale makes it more
// prominent inside the larger solution overlay.
const VIEW_SCALE = 1.3;

function applyViewRotation() {
  cube3dEl.style.transform =
    `scale(${VIEW_SCALE}) rotateX(${state.viewRot.x}deg) rotateY(${state.viewRot.y}deg)`;
}

function bindCubeDrag() {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const sensitivity = 0.4;

  function pointFromEvent(e) {
    if (e.touches && e.touches.length) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
  }

  function pointerDown(e) {
    dragging = true;
    const p = pointFromEvent(e);
    lastX = p.x;
    lastY = p.y;
    cube3dSceneEl.classList.add("dragging");
    e.preventDefault();
  }

  function pointerMove(e) {
    if (!dragging) return;
    const p = pointFromEvent(e);
    const dx = p.x - lastX;
    const dy = p.y - lastY;
    lastX = p.x;
    lastY = p.y;
    // Dragging left/right spins around Y freely (so you can walk all the way
    // around the cube); up/down is clamped so the view never flips upside
    // down mid-drag, which would feel disorienting.
    state.viewRot.y += dx * sensitivity;
    state.viewRot.x = Math.max(-85, Math.min(85, state.viewRot.x - dy * sensitivity));
    applyViewRotation();
    e.preventDefault();
  }

  function pointerUp() {
    dragging = false;
    cube3dSceneEl.classList.remove("dragging");
  }

  cube3dSceneEl.addEventListener("mousedown", pointerDown);
  window.addEventListener("mousemove", pointerMove);
  window.addEventListener("mouseup", pointerUp);
  cube3dSceneEl.addEventListener("touchstart", pointerDown, { passive: false });
  window.addEventListener("touchmove", pointerMove, { passive: false });
  window.addEventListener("touchend", pointerUp);
}

function addCubieFace(cubie, direction, globalIndex) {
  const face = document.createElement("div");
  face.className = "cubie-face";
  face.style.transform = FACE_TRANSFORM[direction];
  face.style.background = INNER_PLASTIC;
  cubie.appendChild(face);
  if (globalIndex !== null) {
    cubieFaceByIndex[globalIndex] = face;
  }
}

// Repaints every sticker from a 54-char facelet string (cube.js's own
// asString() format: letters U/R/F/D/L/B denoting which ORIGINAL face-color
// each sticker belongs to) translated through faceToColor (derived from the
// cube's actual captured colors) into real sticker colors.
function render3DCube(faceletStr, faceToColor) {
  for (let i = 0; i < 54; i++) {
    const el = cubieFaceByIndex[i];
    if (!el) continue;
    const color = faceToColor[faceletStr[i]];
    el.style.background = STICKER_HEX[color] || "#9ca3af";
  }
}

function ensureLayerPivot() {
  if (!layerPivotEl) {
    layerPivotEl = document.createElement("div");
    layerPivotEl.style.position = "absolute";
    layerPivotEl.style.top = "0";
    layerPivotEl.style.left = "0";
    layerPivotEl.style.width = "0";
    layerPivotEl.style.height = "0";
    layerPivotEl.style.transformStyle = "preserve-3d";
    layerPivotEl.style.transform = "none";
    cube3dEl.appendChild(layerPivotEl);
  }
  return layerPivotEl;
}

// Visually spins the 9 cubies belonging to `move`'s layer, then calls
// onDone() once the spin has finished (colors are repainted by the caller
// afterward, from real solved state — see the comment at the top of this
// section).
function animateLayerMove(move, onDone) {
  const face = faceOf(move);
  const power = powerOf(move);
  const axis = AXIS_FOR_FACE[face];
  const multiplier = power === 3 ? -1 : power; // 1,2,3 -> 1,2,-1 (prime = reverse)
  const angle = BASE_ANGLE[face] * multiplier;
  const predicate = LAYER_PREDICATE[face];

  const pivot = ensureLayerPivot();
  pivot.style.transition = "none";
  pivot.style.transform = "none";

  const selected = cubieEls.filter((c) =>
    predicate(Number(c.dataset.x), Number(c.dataset.y), Number(c.dataset.z))
  );
  selected.forEach((c) => pivot.appendChild(c));

  // Force reflow so the browser registers the "none" transform before we
  // animate away from it (otherwise the transition can get skipped).
  // eslint-disable-next-line no-unused-expressions
  pivot.offsetHeight;

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    pivot.removeEventListener("transitionend", finish);
    pivot.style.transition = "none";
    pivot.style.transform = "none";
    selected.forEach((c) => cube3dEl.appendChild(c));
    onDone();
  };

  requestAnimationFrame(() => {
    pivot.style.transition = "transform 420ms ease-in-out";
    pivot.style.transform = `rotate${axis}(${angle}deg)`;
  });

  pivot.addEventListener("transitionend", finish);
  setTimeout(finish, 600); // fallback in case transitionend doesn't fire
}

function setupVisualizer(cubeString, moves, colorToFace) {
  const faceToColor = {};
  Object.entries(colorToFace).forEach(([color, face]) => {
    faceToColor[face] = color;
  });

  const cube = Cube.fromString(cubeString);
  const snapshots = [cube.asString()];
  moves.forEach((m) => {
    cube.move(m);
    snapshots.push(cube.asString());
  });

  state.vis = { snapshots, moves, faceToColor, step: 0 };
  cube3dWrap.classList.remove("hidden");
  render3DCube(snapshots[0], faceToColor);
  updateStepControls();
  updateProgressTrack();
}

function hideVisualizer() {
  state.vis = null;
  cube3dWrap.classList.add("hidden");
  nextStepBtn.disabled = true;
  prevStepBtn.disabled = true;
  restartStepBtn.disabled = true;
  stepLabelEl.textContent = "Press Next move to begin.";
  hideSolutionOverlay();
  updateProgressTrack();
}

// The solve results (3D playback + move list) live in a big modal overlay
// rather than inline in the page — showSolutionOverlay() just reveals it;
// the overlay's own CSS (backdrop-filter: blur) handles dimming/blurring
// everything behind it, so nothing else needs to change when it opens.
function showSolutionOverlay() {
  solutionOverlayEl.classList.remove("hidden");
}

function hideSolutionOverlay() {
  solutionOverlayEl.classList.add("hidden");
}

function updateStepControls() {
  if (!state.vis) return;
  const { step, moves } = state.vis;
  nextStepBtn.disabled = step >= moves.length;
  prevStepBtn.disabled = step <= 0;
  restartStepBtn.disabled = step <= 0;
  updateChipHighlight(step);

  if (moves.length === 0) {
    stepLabelEl.textContent = "Already solved — nothing to play.";
  } else if (step >= moves.length) {
    stepLabelEl.textContent = `Solved! ${moves.length} move${moves.length === 1 ? "" : "s"} complete.`;
  } else {
    stepLabelEl.textContent = `Move ${step + 1} of ${moves.length}: ${moves[step]} — tap Next move to play it.`;
  }
}

// The inverse of a move: a plain turn undoes with a prime, a prime undoes
// with a plain turn, and a double undoes with itself (180° either way lands
// on the same spot). Used to animate Prev as an actual reverse turn instead
// of a plain snap-back.
function invertMove(move) {
  const face = faceOf(move);
  const power = powerOf(move); // 1 = plain, 2 = double, 3 = prime
  if (power === 2) return face + "2";
  if (power === 3) return face;
  return face + "'";
}

function goToStep(targetStep) {
  state.vis.step = targetStep;
  render3DCube(state.vis.snapshots[targetStep], state.vis.faceToColor);
  updateStepControls();
}

function setStepButtonsBusy(busy) {
  nextStepBtn.disabled = busy;
  prevStepBtn.disabled = busy;
  restartStepBtn.disabled = busy;
}

function handleNextStep() {
  if (!state.vis || state.vis.step >= state.vis.moves.length) return;
  setStepButtonsBusy(true);
  const move = state.vis.moves[state.vis.step];
  animateLayerMove(move, () => {
    state.vis.step += 1;
    render3DCube(state.vis.snapshots[state.vis.step], state.vis.faceToColor);
    updateStepControls();
  });
}

function handlePrevStep() {
  if (!state.vis || state.vis.step <= 0) return;
  setStepButtonsBusy(true);
  // Undo the move that led into the current step by animating its inverse,
  // then land on the previous step's already-verified snapshot — same
  // "animate for show, repaint from ground truth" approach as Next.
  const moveToUndo = state.vis.moves[state.vis.step - 1];
  const inverse = invertMove(moveToUndo);
  animateLayerMove(inverse, () => {
    state.vis.step -= 1;
    render3DCube(state.vis.snapshots[state.vis.step], state.vis.faceToColor);
    updateStepControls();
  });
}

function handleRestartStep() {
  if (!state.vis) return;
  goToStep(0);
}

function solveCube() {
  try {
    if (!window.Cube) {
      throw new Error("Solver library failed to load. Check your internet connection and reload.");
    }

    validateColorCounts();
    validateCenters();
    const colorToFace = buildColorToFaceMapping();
    const cubeString = buildCubeString(colorToFace);

    updateStatus("Solving…");
    solutionStepsEl.innerHTML = "";
    hideVisualizer();

    setTimeout(() => {
      try {
        const cube = Cube.fromString(cubeString);
        if (!cube.isSolvable || cube.isSolvable()) {
          state.solution = solveCubeString(cubeString);
          renderSolution(state.solution);
          setupVisualizer(cubeString, state.solution, colorToFace);
          showSolutionOverlay();
          if (state.solution.length === 0) {
            updateStatus("Cube is already solved.");
          } else {
            updateStatus(`Solved in ${state.solution.length} move${state.solution.length === 1 ? "" : "s"}.`);
          }
        } else {
          updateStatus("This cube state isn't a valid, solvable cube. Please recheck the colors.");
        }
      } catch (err) {
        updateStatus(
          err.message.includes("This is not a valid cube")
            ? "This isn't a valid, solvable cube state. Please recheck the detected colors."
            : err.message
        );
        solutionStepsEl.innerHTML = "";
      }
    }, 30);
  } catch (err) {
    updateStatus(err.message);
    solutionStepsEl.innerHTML = "";
  }
}

function renderSolution(steps) {
  solutionStepsEl.innerHTML = "";
  steps.forEach((move) => {
    const chip = document.createElement("span");
    chip.className = "move-chip";
    chip.textContent = move;
    solutionStepsEl.appendChild(chip);
  });
}

function updateChipHighlight(currentStep) {
  const chips = solutionStepsEl.querySelectorAll(".move-chip");
  chips.forEach((chip, i) => {
    chip.classList.toggle("done", i < currentStep);
    chip.classList.toggle("current", i === currentStep);
  });
}

function resetAll() {
  stopCamera();
  state.captures = {};
  state.solution = [];
  state.currentFaceIndex = 0;
  FACE_ORDER.forEach((face) => {
    state.detected[face] = new Array(9).fill(null);
  });
  cameraOffMsg.classList.remove("hidden");
  cameraToggleBtn.textContent = "Turn on camera";
  detectBtn.disabled = true;
  solveBtn.disabled = true;
  buildThumbs();
  updateFaceLabel();
  renderNet();
  solutionStepsEl.innerHTML = "";
  hideVisualizer();
  updateStatus("Reset complete. Capture all 6 faces to begin.");
}

window.addEventListener("beforeunload", stopCamera);

init();