# WebXR Quest 3 Demo

A browser-based WebXR experience for the Meta Quest 3, built with
vanilla JavaScript + [Three.js](https://threejs.org/) + the
[WebXR Device API](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API).

No build step. Open `index.html` through a local static server (or the
published Pages URL below) and it runs.

## Features (v2)

- A Three.js scene with a procedurally textured floor, gradient skybox,
  decorative pedestals, and basic lighting (no shadows — Quest 3 budget).
- **Enter VR** and **Enter AR** buttons using `navigator.xr`, with proper
  `immersive-vr` / `immersive-ar` session requests and a render loop bound
  via `renderer.setAnimationLoop` (which Three.js binds to the XRSession's
  `requestAnimationFrame` while in XR).
- Quest 3 controller support: controller models via Three.js's
  `XRControllerModelFactory`, plus ray-casting from each controller for
  pointing/selecting.
- **Hand tracking**: with `hand-tracking` requested as an optional feature,
  hand input sources get a sphere-per-joint visual via `XRHandModelFactory`
  (`renderer.xr.getHand()`), while the vendor controller model is hidden for
  hand sources (their `gripSpace` is null). Pinch fires the same `select`
  event as the trigger, so grabbing works identically with hands.
- **Grabbable objects + physics**: five objects (boxes, balls, an
  icosahedron) you can grab with the trigger and throw — release velocity is
  computed from the hold-pose history. A tiny custom physics step (gravity,
  floor bounce with restitution/friction, edge clamping, sleep) keeps them
  believable with zero dependencies and negligible CPU.
- One interactive cube that cycles color when triggered (with a hover
  highlight for feedback), unchanged from v1.
- **In-VR menu**: press **A/X** to open a world-space panel with clickable
  rows (Locomotion toggle, Reset objects, Exit VR), driven by the same
  controller rays.
- **AR passthrough** (Quest 3): `immersive-ar` session with `hit-test`; the
  reticle follows real surfaces and the trigger places a marker. The DOM
  overlay is reused as a `dom-overlay` root.
- Graceful fallback message when WebXR is not supported (e.g. on a desktop
  browser), with a flat 3D preview you can orbit.
- **Locomotion** (switchable at runtime; defaults to teleport):
  - **Teleport**: parabolic arc + target ring; confirm with the **grip**
    (squeeze) button to jump there instantly (comfort-mode).
  - **Smooth**: push a **thumbstick** to move relative to head-forward, with
    a comfort vignette that narrows the FOV while moving.
  - Switch with the in-VR menu, **B/Y** quick-toggle, or the desktop button.
  - Locomotion moves the player via an offset **reference space** (not the
    camera), so it composes cleanly with the `local-floor` space and never
    fights head tracking.

## Input bindings (v2)

| Action | Input |
| --- | --- |
| Grab / drop (throw) object, cycle cube color, place AR marker | **trigger** (`select`) |
| Teleport confirm | controller **grip/squeeze** button |
| Smooth move | controller **thumbstick** (x = strafe, y = forward) |
| Open/close in-VR menu | right controller **A/X** button |
| Quick locomotion toggle | right controller **B/Y** button, or the desktop toggle |

The trigger's meaning is disambiguated by what the ray hits first: a
grabbable → grab; the cube → color cycle; the menu panel → menu click; in AR
mode with no object hit → place a marker. Grab always takes priority, so the
bindings never conflict.

## Project structure

```
index.html        # Markup, overlay/fallback UI, Three.js import map, bootstrap
main.js           # WebXR session lifecycle (VR + AR) and the render loop
src/scene.js      # Renderer, scene, camera, lights, procedural textures/skybox
src/objects.js    # Interactive cube, grabbable objects, tiny physics step
src/controllers.js# Controller setup, ray-casting, gamepad polling, input dispatch
src/hands.js      # Hand-tracking visuals via XRHandModelFactory
src/locomotion.js # Teleport + smooth locomotion, offset reference spaces
src/menu.js       # In-VR world-space menu panel
src/ar.js         # Immersive-AR passthrough, hit-test, marker placement
style.css         # Overlay/fallback UI styling
README.md         # This file
```

Three.js is loaded from a CDN via an
[import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap)
(pinned to `three@0.169.0`) in `index.html`, so there is nothing to install.
The `src/` modules use plain ES-module imports — still no build step.

## Run it

The site is published via **GitHub Pages** at:

> <https://snowy5233.github.io/WebXR/>

This is an HTTPS origin, which is what WebXR requires (WebXR only works in a
secure context — `https://` or `http://localhost`). No local server needed.

- **Desktop:** open the URL in a WebXR-capable browser (e.g. Chrome). Without
  a headset you'll get the flat 3D preview and a fallback message; that's
  expected. To test the immersive paths themselves you need a WebXR device.
- **Meta Quest 3:** open the **Meta Quest Browser**, navigate to the URL
  above, and tap **Enter VR** (or **Enter AR** for passthrough).
  - Trigger grabs objects; point at the cube and trigger to cycle its color.
  - **A/X** opens the in-VR menu; **B/Y** quick-toggles locomotion.
  - Teleport (default): point at the floor, press **grip**. Smooth: push the
    thumbstick.
  - In AR: point at a real surface and pull the trigger to place a marker.
  - Hand tracking: put the controllers down — pinch to grab/select.

## Optional: run locally instead

If you'd rather run from your own machine (e.g. to test an unmerged branch),
serve the files over a local static server — WebXR requires `https://` or
`localhost`, so don't open the file directly:

```bash
# Python 3 (no install needed on most systems)
python3 -m http.server 8000

# or Node.js
npx serve .
```

Then open `http://localhost:8000/` on desktop. To reach the same server from
the Quest 3 you must use **HTTPS** (a plain `http://<your-laptop-ip>:8000`
URL will not work in the headset). The simplest way is a tunnel such as
[`ngrok`](https://ngrok.com/) or Cloudflare Tunnel:

```bash
ngrok http 8000
```

Use the resulting `https://*.ngrok-free.app` URL in the Quest 3 browser.

## Performance notes (Quest 3)

- Minimal draw calls: skybox + floor + grid + a few shared-material objects +
  two lights + controller/hand models. Shadows are disabled.
- All textures are generated procedurally on canvas (gradient skybox, floor
  checker) — no downloads, tiny memory. If photographic textures are added
  later, prefer small compressed formats (KTX2/BasisU) and reuse materials.
- The physics step is a handful of vector ops per object; objects sleep when
  at rest, so idle frames cost nearly nothing.
- `renderer.setAnimationLoop` drives the loop, which Three.js binds to the
  XRSession vsync while in XR.

## Debug overlay

A small text panel (top-left of the flat page, also visible in-headset)
reports live per-frame state: `xr.enabled`, the resolved session features and
`environmentBlendMode` (so you can confirm VR vs AR), the active `locomotion`
mode, the player offset, and each controller slot's ray pose, hand-source
flag, and model visibility. It exists to diagnose XR lifecycle issues (head
tracking, controller/hand poses, session start); leave it in place unless you
are sure a change is unrelated.

## Known WebXR gotchas in this codebase

A few non-obvious things that have already caused bugs here and are worth
preserving:

- **`renderer.xr.enabled = true` is required.** `WebXRManager.enabled`
  defaults to `false`; without it `render()` keeps using the flat desktop
  camera even while presenting, so head tracking does nothing and the view is
  locked ~3m back. Set it before presenting (see `src/scene.js`).
- **Do not call `OrbitControls.update()` while presenting.** It is bound to
  the same camera WebXRManager drives with the headset pose and would
  overwrite that pose. It's gated on `!renderer.xr.isPresenting` in the
  render loop.
- **Locomotion moves an offset reference space, not the camera.** The headset
  pose is applied on top of whatever reference space `renderer.xr` resolves
  against, so changing that space moves the player without fighting head
  tracking (see `src/locomotion.js`).
- **Hand input sources have a null `gripSpace`.** Three.js only writes the
  grip group's matrix when `gripSpace` is non-null, so a hand source on a
  controller slot leaves the vendor model frozen while the ray still tracks.
  v2 handles this explicitly: the controller model is hidden for hand
  sources (`src/controllers.js`) and hands get their own visual via
  `renderer.xr.getHand()` + `XRHandModelFactory` (`src/hands.js`). Note that
  `createHandModel` must be called at setup time — it builds its meshes from
  the hand's `connected` event, which it would miss if called from inside
  that event.
- **AR sessions need `scene.background = null`** (plus hidden skybox/floor)
  or the passthrough camera feed is hidden behind the opaque background.
- **Hit-test sources must be created before the session ends** and cancelled
  on exit; `getHitTestResults` needs the *current* frame's reference space.

## Multiplayer (planned, not in v2)

Networked multiplayer requires a signaling/state-sync backend and does not
fit a static GitHub Pages site. It will be added once this project moves to a
self-hosted server (WebRTC or WebSocket state sync), at which point
`src/objects.js` (physics) and `src/locomotion.js` (player offset) already
expose the per-frame state a sync layer would need to serialize.

## Iterating

This scaffold is intentionally small. Next steps: server-backed multiplayer,
haptics on grab/bounce, snap-turn, and audio.
