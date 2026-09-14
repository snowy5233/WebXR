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

## Project structure

```
index.html   # Markup, overlay/fallback UI, Three.js import map, module bootstrap
main.js      # Scene, lighting, controllers, ray-casting, WebXR session lifecycle
style.css    # Overlay/fallback UI styling
README.md    # This file
```

Three.js is loaded from a CDN via an
[import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap)
(pinned to `three@0.169.0`) in `index.html`, so there is nothing to install.

## Run locally (desktop preview)

WebXR requires a **secure context** — `https://` or `http://localhost` — so you
must serve the files over a local static server, not open the file directly.

Pick any static server, for example:

```bash
# Python 3 (no install needed on most systems)
python3 -m http.server 8000

# or Node.js
npx serve .
```

Then open `http://localhost:8000/` in a WebXR-capable desktop browser (e.g.
Chrome). On a machine without a headset you'll get the flat 3D preview and a
fallback message; that is expected. To test the immersive-vr path itself you
need a WebXR device.

## Load it on the Meta Quest 3

The Quest 3 browser is a secure context, but you still need to reach the page
over HTTPS or localhost. Two common approaches:

### Option A — Host on any HTTPS URL (simplest from the headset)

Push the repo to GitHub and enable GitHub Pages (or use any HTTPS static host).
Then in the Quest 3 browser, just navigate to that HTTPS URL and tap
**Enter VR**.

### Option B — Serve from your dev machine and reach it from the headset

1. Start a static server on your computer (see above).
2. Make it reachable from the Quest 3 over the same Wi-Fi network, and use
   **HTTPS**. The simplest way is a tunnel such as
   [`ngrok`](https://ngrok.com/) or Cloudflare Tunnel, e.g.:

   ```bash
   ngrok http 8000
   ```

   Use the resulting `https://*.ngrok-free.app` URL.
3. Put on the headset, open the **Meta Quest Browser** (or a Chromium-based
   browser), and navigate to that HTTPS URL.
4. Tap **Enter VR**. Put the headset on; point a controller at the cube and
   pull the trigger to cycle its color.

> A plain `http://<your-laptop-ip>:8000` URL will **not** work in the headset
> because WebXR is only available in secure contexts. Use HTTPS or localhost.

## Performance notes (Quest 3)

- Minimal draw calls: grid + floor + cube + a couple of lights + controller
  models. Shadows are disabled.
- No textures are used in v1, so there is nothing large to compress yet. When
  textures are added later, prefer small, compressed formats (e.g. KTX2/ BasisU) and reuse materials.
- `renderer.setAnimationLoop` drives the loop, which Three.js binds to the
  XRSession vsync while in XR.

## Iterating

This scaffold is intentionally small. Planned next steps: physics, more
interactive objects, and hand-tracking support (the session already requests
`hand-tracking` as an optional feature).
