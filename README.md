# WebXR Quest 3 Demo

A minimal browser-based WebXR VR experience for the Meta Quest 3, built with
vanilla JavaScript + [Three.js](https://threejs.org/) + the
[WebXR Device API](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API).

No build step. Open `index.html` through a local static server and it runs.

## Features (v1)

- A Three.js scene with a floor grid, basic lighting, and a background color.
- An **Enter VR** button using `navigator.xr`, with a proper `immersive-vr`
  session request and a render loop bound via `renderer.setAnimationLoop`
  (which Three.js binds to the XRSession's `requestAnimationFrame` while in XR).
- Quest 3 controller support: controller models rendered via Three.js's
  `XRControllerModelFactory`, plus ray-casting from each controller for
  pointing/selecting.
- One interactive cube that cycles color when the controller trigger is
  pressed while pointing at it (with a hover highlight for feedback).
- Graceful fallback message when WebXR is not supported (e.g. on a desktop
  browser), with a flat 3D preview you can orbit.
- **Locomotion** (switchable at runtime; defaults to teleport on first load,
  choice persists for the session):
  - **Teleport**: point a controller at the floor to see a parabolic arc +
    target ring; press the **grip** (squeeze) button to jump there instantly
    (comfort-mode, no smooth motion).
  - **Smooth**: push a **thumbstick** to move relative to head-forward, with a
    comfort vignette that narrows the FOV while moving.
  - Switch modes with the **Locomotion** button on the desktop overlay, or the
    **A/X** button on the right controller in VR.
  - Locomotion moves the player via an offset **reference space** (not the
    camera), so it composes cleanly with the `local-floor` space and never
    fights head tracking.

## Input bindings (v1)

| Action | Input |
| --- | --- |
| Change cube color | controller **trigger** (the WebXR `select` event) |
| Teleport confirm | controller **grip/squeeze** button |
| Smooth move | controller **thumbstick** (x = strafe, y = forward) |
| Toggle locomotion mode | right controller **A/X** button, or the desktop toggle button |

The cube's color-change (trigger) and locomotion (grip / thumbstick / A) use
separate, clearly-documented bindings and never conflict.

## Project structure

```
index.html   # Markup, overlay/fallback UI, Three.js import map, module bootstrap
main.js      # Scene, lighting, controllers, ray-casting, locomotion,
             # WebXR session lifecycle, and runtime diagnostics
style.css    # Overlay/fallback UI + locomotion toggle styling
README.md    # This file
```

Three.js is loaded from a CDN via an
[import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap)
(pinned to `three@0.169.0`) in `index.html`, so there is nothing to install.

## Run it

The site is published via **GitHub Pages** at:

> <https://snowy5233.github.io/WebXR/>

This is an HTTPS origin, which is what WebXR requires (WebXR only works in a
secure context — `https://` or `http://localhost`). No local server needed.

- **Desktop:** open the URL in a WebXR-capable browser (e.g. Chrome). Without
  a headset you'll get the flat 3D preview and a fallback message; that's
  expected. To test the immersive-vr path itself you need a WebXR device.
- **Meta Quest 3:** open the **Meta Quest Browser**, navigate to the URL above,
  and tap **Enter VR**. Point a controller at the cube and pull the trigger to
  cycle its color. To move around: in **teleport** mode (the default), point a
  controller at the floor and press the **grip** button; in **smooth** mode,
  push a thumbstick. Switch modes with the right controller's **A/X** button
  (or the desktop toggle before entering VR).

GitHub Pages serves the repository's `main` branch, so changes merged to
`main` go live at that URL (after Pages rebuilds).

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

- Minimal draw calls: grid + floor + cube + a couple of lights + controller
  models. Shadows are disabled.
- No textures are used in v1, so there is nothing large to compress yet. When
  textures are added later, prefer small, compressed formats (e.g. KTX2/BasisU)
  and reuse materials.
- `renderer.setAnimationLoop` drives the loop, which Three.js binds to the
  XRSession vsync while in XR.

## Debug overlay

A small text panel (top-left of the flat page, also visible in-headset)
 reports live per-frame state: `xr.enabled`, the resolved session features, the
 active `locomotion` mode, the player offset, and each controller slot's grip/
 ray world positions and attached model. It exists to diagnose XR lifecycle
 issues (head tracking, controller poses, session start); leave it in place
 unless you are sure a change is unrelated.

## Known WebXR gotchas in this codebase

A few non-obvious things that have already caused bugs here and are worth
preserving:

- **`renderer.xr.enabled = true` is required.** `WebXRManager.enabled` defaults
  to `false`; without it `render()` keeps using the flat desktop camera even
  while presenting, so head tracking does nothing and the view is locked ~3m
  back. Set it before presenting (see `main.js`).
- **Do not call `OrbitControls.update()` while presenting.** It is bound to the
  same camera WebXRManager drives with the headset pose and would overwrite
  that pose. It's gated on `!renderer.xr.isPresenting` in the render loop.
- **Locomotion moves an offset reference space, not the camera.** The headset
  pose is applied on top of whatever reference space `renderer.xr` resolves
  against, so changing that space moves the player without fighting head
  tracking.

## Iterating

This scaffold is intentionally small. Planned next steps: physics, more
interactive objects, and hand-tracking support.

> Note: `hand-tracking` is intentionally **not** requested in the session
> features right now. On Quest 3 the runtime can report hand input sources
> alongside the touch controllers when it is, and a hand input source has a
> null `gripSpace` — which left the controller model frozen while the pointer
> ray still tracked. It will be added later via `renderer.xr.getHand()` with
> its own handling rather than piggybacking on the controller/grip slots.
