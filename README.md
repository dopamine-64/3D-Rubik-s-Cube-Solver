# 3D Rubik's Cube Solver

A minimal, single-page Rubik's Cube solver. Capture photos of all 6 faces,
let it detect the sticker colors automatically (with manual correction),
then get a full step-by-step solution.

## How it works

1. Click **Turn on camera** (top-right of the "Capture faces" panel) to
   start a single live camera view — no separate upload box per face. The
   app tells you which face to show next (Up, Right, Front, Down, Left,
   Back, in that order). The button becomes **Turn off camera** once the
   stream is running, so you can stop it at any time (the browser's camera
   indicator goes away too) — everything you've already captured stays put.
2. Align that face inside the on-screen guide and **press the Spacebar** to
   capture it — there's no on-screen capture button. Colors for that face
   are detected **immediately** and the cube net on the right updates right
   away. The app then automatically advances to the next face. A thumbnail
   strip shows all 6 captures; click any thumbnail to jump back and retake
   that face (pressing Space again re-captures and re-detects it).
3. **Review** the detected colors in the cube net on the right. Pick a
   color from the palette above the net (swatches now show the real sticker
   color) and click any cell to correct it if detection got something
   wrong. If you want to force a full re-scan of every captured photo (e.g.
   after changing lighting), use **Re-detect Colors**.
4. Once all 6 faces are captured, click **Solve Cube**. The app derives
   which color belongs to which face from each face's own center sticker
   (centers never move on a real cube, so this works no matter which color
   scheme your cube uses or which way you were holding it), then validates
   that:
   - all 6 centers are distinct colors, and
   - each color appears exactly 9 times across the whole cube,

   then hands the cube state to the solver and opens the solution as a big
   overlay on top of the page (see below).

Use **Reset** (top-right of the "Check colors" panel) at any point to clear
everything and start over.

## Solution overlay

Once a solution is found, it opens as a large modal over the rest of the
page — the background is blurred behind it so the move list and 3D cube are
the clear focus. Inside the overlay:

- A 3D cube shows your actual captured colors, which you step through move
  by move: **Next Move** animates and applies exactly one move, then waits
  for you to click again — it never auto-plays through the whole solution.
- **◀ Prev** and **Restart** jump backward instantly (no re-animation) if
  you want to review an earlier point.
- The move list below highlights the move that's about to play, and marks
  completed ones, so it's always clear where you are in the solution.
- Close the overlay with the **×** button, by pressing **Esc**, or by
  clicking the blurred background outside the modal.

## Quicker manual color entry

Setting colors by hand used to mean clicking a cell repeatedly to cycle
through all 6 colors — slow if you're building much of the cube manually.
Instead there's a color palette above the net: pick a color once (each
swatch is drawn in its real sticker color), then just click cells to paint
them that color instantly (an eraser swatch clears a cell). Each face in
the net is also labeled with its letter and name (U · Up, R · Right, F ·
Front, D · Down, L · Left, B · Back) so it's clear which physical side of
the cube you're editing.

## Solving without any photos

Capturing photos is entirely optional. You can build the whole cube state
by hand instead: pick a color from the palette and click cells in the
"Check colors" net until every sticker has a color. **Solve Cube** enables
itself as soon as all 54 stickers are set, regardless of whether any face
was ever photographed — you can also mix the two: capture some faces and
manually fill in the rest.

## Getting the shortest solution

The underlying solving library (cube.js, see below) has a real quirk: its
search never checks whether the cube it's handed is already "basically
solved" before it starts recursing, so a cube that's genuinely only 1–2
turns from solved could come back with a needlessly long solution padded
with moves that just cancel each other out. This app fixes that in two
layers before showing you anything:

1. **Brute-force short-circuit** — for any cube within 4 moves of solved
   (which covers "I made one wrong turn" type cases exactly), the app
   searches directly for the true shortest sequence rather than trusting
   the general-purpose solver.
2. **Algorithm reduction** — whatever solution comes out (brute-force or
   the full two-phase solver for harder scrambles) is passed through a
   cleanup pass that cancels adjacent same-face moves (`R R'` → nothing,
   `R R` → `R2`, etc.) and moves separated only by a commuting opposite-face
   move (`R L R'` → `L`, since `R` and `L` turn independent layers) — the
   same kind of "algorithm simplification" other cube-solving apps do
   before displaying a result.

Every final solution is also replayed against the original cube state
before being shown, so you're never shown a "solution" that doesn't
actually solve the cube.

## Solver library

This project uses [cube.js](https://github.com/ldez/cubejs) (loaded from a
CDN) for solving. Two files are required from it:

- `lib/cube.min.js` — basic cube state/move modeling
- `lib/solve.min.js` — Herbert Kociemba's two-phase solving algorithm, which
  is what actually adds the `solve()` / `initSolver()` methods

(An earlier version of this app only loaded `cube.min.js`, which is why
`cube.solve` would fail with "not a function" — `solve()` lives in the
second file.) It builds its move-pruning tables the first time you solve,
which can take a couple of seconds — the app tries to warm this up quietly
in the background as soon as the page loads.

## Notes on color detection

Detection runs entirely in-browser with the Canvas API — no server or ML
model required — and happens automatically the instant you capture (or
retake) a face:

- Sampling is restricted to the same square shown by the on-screen guide
  overlay, so background/hands around the cube aren't averaged into the
  sticker colors.
- Each of the 9 stickers is sampled as a small averaged patch (not a single
  pixel) to reduce noise and glare.
- Colors are classified in **HSV** (hue/saturation/value) rather than raw
  RGB distance: white/light stickers are detected by low saturation and high
  brightness, and the 5 saturated colors (red, orange, yellow, green, blue)
  are matched by hue, which stays stable across different lighting and
  exposure levels far better than RGB does.

It still works best with clear, evenly lit photos with the cube filling the
guide square — which is why manual correction (click any cell) is built
into the UI for the cases it gets wrong.

Possible upgrades if you want even stronger accuracy:
- Automatic perspective correction / sticker-grid detection instead of
  fixed relative sample points
- Auto-capture when the guide square is well-aligned

## Next ideas

- Backend (e.g. OpenCV) processing for more accurate detection
- Auto-play through the whole solution with adjustable speed (currently
  intentionally click-through-only, one move per tap)
- Reverse-animate **Prev** instead of snapping back instantly
