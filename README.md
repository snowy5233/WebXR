# WebXR Quest 3 AR Sandbox

A browser-based **AR passthrough** experience for the Meta Quest 3, built with
vanilla JavaScript + [Three.js](https://threejs.org/) + the
[WebXR Device API](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API).
Place shapes on your real surfaces, pick them up and move them around, and
wander with smooth locomotion.

No build step. Open the published URL (below) in the Meta Quest Browser.

## Features (v3)

- **AR-only**: `immersive-ar` session with passthrough camera feed composited
  over the WebGL scene (alpha-enabled context, `hit-test`, `dom-overlay`).
- **Part placement**: point at a real surface — a translucent ghost preview
  shows where the part will land — and pull the trigger to place it.
- **Shape menu**: cycle Box / Ball / Star / Pillar with **B/Y**, or via the
  in-headset menu (**A/X**). The ghost preview updates to match.
- **Move parts with grip**: squeeze the grip button while pointing at a
  placed part to pick it up; release to drop it where you like.
- **In-headset menu** (**A/X**): Shape cycle, Clear parts, Exit AR — clicked
  with the controller ray.
- **Smooth locomotion** (thumbstick, head-relative, comfort vignette).
  Teleport was removed with the VR mode.
- **Hand tracking**: hand input sources get a sphere-per-joint visual;
  the vendor controller model is hidden for hands (their `gripSpace` is
  null). Pinch fires the same select as the trigger.
- **In-headset diagnostics**: a world-space panel follows the head while
  presenting, showing live status — and, crucially, any per-frame error,
  so failures are readable inside the headset instead of a mystery black
  screen.
- Graceful desktop fallback: a flat 3D preview with a clear message when
  `immersive-ar` is unsupported.

## Input bindings

| Action | Input |
| --- | --- |
| Place a part at the reticle | **trigger** (`select`) |
| Pick up / move a placed part | **grip** (squeeze) — release to drop |
| Smooth move | **thumbstick** (x = strafe, y = forward) |
| Open/close the menu | right controller **A/X** |
| Cycle placement shape | right controller **B/Y**, or the menu |

The trigger only places a part when you're not currently holding one via
grip, so the bindings never conflict.

## Project structure

```
index.html           # Markup, overlay/fallback UI, Three.js import map
main.js              # AR session lifecycle and the render loop
src/scene.js         # Renderer, scene, camera, lights, procedural environment
src/controllers.js   # Controller setup, ray-casting, gamepad polling
src/hands.js         # Hand-tracking visuals via XRHandModelFactory
src/locomotion.js    # Smooth locomotion via offset reference spaces
src/menu.js          # In-headset menu panel (shape / clear / exit)
src/ar.js            # AR parts: shapes, hit-test reticle, preview, grip-move
src/diagnostics.js   # In-headset status/error panel
src/debug.js         # DOM debug overlay + global error handlers
style.css            # Overlay/fallback UI styling
README.md            # This file
```

Three.js is loaded from a CDN via an
[import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap)
(pinned to `three@0.169.0`) in `index.html`, so there is nothing to install.
The `src/` modules use plain ES-module imports — still no build step.

## Run it

Published via **GitHub Pages** (HTTPS, which WebXR requires):

> <https://snowy5233.github.io/WebXR/>

- **Meta Quest 3:** open the **Meta Quest Browser**, navigate to the URL,
  and tap **Enter AR**. Look at a surface — the ghost preview follows the
  reticle — and pull the trigger to place a part. Grip picks up a placed
  part; release drops it. **A/X** opens the menu; **B/Y** cycles shapes.
- **Desktop:** you'll get the flat 3D preview and a message that immersive
  AR isn't supported; that's expected (AR needs a headset with passthrough).

### Run locally instead

WebXR requires `https://` or `localhost`:

```bash
python3 -m http.server 8000   # or: npx serve .
```

For the Quest 3 to reach your machine you need HTTPS — the simplest is a
tunnel such as [ngrok](https://ngrok.com/) (`ngrok http 8000`) or Cloudflare
Tunnel, then open the `https://…` URL in the Quest browser.

## Performance notes (Quest 3)

- Minimal draw calls: passthrough (no background), a few shared-material
  parts, two lights, controller/hand models, hit-test reticle + ghost.
  Shadows are disabled.
- Part geometries and materials are shared across all placed parts; the
  ghost preview reuses the same geometry.
- All textures are procedural canvases (vignette gradient, menu, diagnostics,
  flat-preview floor/sky) — no downloads.
- `renderer.setAnimationLoop` drives the loop, which Three.js binds to the
  XRSession vsync while in XR.
- Robust frame submission: each subsystem is isolated in try/catch and
  `renderer.render()` always runs — a subsystem error can never produce a
  black screen (it's reported on the in-headset panel instead).

## Debugging in-headset

The in-world diagnostics panel (bottom of view while presenting) shows the
session state and the last per-frame error with the failing subsystem name.
The DOM overlay (top-left on the flat page) shows the same live state for
desktop runs. Leave both in place unless a change is definitely unrelated.

## Known WebXR gotchas preserved here

- **`renderer.xr.enabled = true` is required** or head tracking does nothing
  (`src/scene.js`).
- **Alpha context for AR**: `alpha: true` must be in the WebGLRenderer
  constructor — the AR compositor overlays the framebuffer on the camera feed
  via alpha; an opaque context is an all-black AR view. It cannot be enabled
  after construction.
- **`scene.background = null` during AR**, and restore it on exit, or the
  passthrough hides behind the opaque clear.
- **Locomotion sign convention**: Three.js renders the head at
  `trueHead − offsetTranslation`, so moving the rendered head in +d means
  DECREASING the offset by d. An inverted sign teleports/moves you backwards.
- **Hand input sources have a null `gripSpace`**: hide the vendor controller
  model for them and use the target-ray controller object as the grab root.
- **`createHandModel` must be called at setup time** — it builds its meshes
  from the hand's `connected` event and misses it if called inside that
  handler.
- **Never skip `renderer.render()` in XR** — no frame submitted means a
  permanent black screen. Hence the per-subsystem try/catch isolation.
- **Hit-test sources** must be created from a `viewer` reference space and
  cancelled on session end; failures degrade to "AR without reticle".

## Multiplayer (planned)

Networked multiplayer requires a signaling/state-sync backend and doesn't
fit a static GitHub Pages site. It will be added once this project moves to
a self-hosted server. `src/ar.js` (parts) and `src/locomotion.js` (player
offset) already expose the per-frame state a sync layer would serialize.

## Iterating

Next steps: server-backed multiplayer, haptics on grab/place, part rotation
while held, audio feedback.
