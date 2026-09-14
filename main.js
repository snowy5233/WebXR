import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// ---------------------------------------------------------------------------
// Debug overlay (on-screen, updates every frame)
// ---------------------------------------------------------------------------
// A fixed-position text panel that reports live controller/grip state so we
// can directly observe (in-headset or on desktop) whether the grip group's
// matrixWorld is actually changing and whether a model is attached to it.
const debugEl = document.createElement('div');
debugEl.id = 'debug-overlay';
debugEl.style.cssText =
  'position:fixed;left:8px;top:8px;z-index:20;padding:8px 10px;' +
  'background:rgba(0,0,0,0.6);color:#7fffd0;font:12px/1.4 monospace;' +
  'white-space:pre;pointer-events:none;max-width:60vw;max-height:90vh;overflow:hidden;';
document.body.appendChild(debugEl);
function setDebugText(text) {
  debugEl.textContent = text;
}

// Throttle for the console version of the per-frame diagnostics.
let lastConsoleDiag = 0;

// Previous-frame timestamp for delta-time computation in the render loop.
let lastTimestamp = 0;

// Surface any uncaught error or unhandled promise rejection on the debug
// overlay as well as the console. This matters because errors thrown inside
// the rAF/render-loop callback are otherwise swallowed and just silently kill
// the loop — which looks exactly like a "hang."
window.addEventListener('error', (e) => {
  console.error('[window.onerror]', e.message, e.error);
  setDebugText('ERROR: ' + (e.message || 'unknown'));
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  console.error('[unhandledrejection]', reason, e.reason);
  setDebugText('REJECT: ' + reason);
});

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
// A single WebGLRenderer drives both the desktop preview and the XR session.
// `xrCompatible: true` is required so the underlying GL context can be used
// by an immersive-vr XRSession.
const renderer = new THREE.WebGLRenderer({ antialias: true, xrCompatible: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// IMPORTANT: enable WebXR rendering. WebXRManager.enabled defaults to false.
// renderer.render() only swaps in the XR camera (cameraXR, driven by the
// headset pose) when `xr.enabled === true && xr.isPresenting === true`. With
// this left false, the session still starts and controllers still get poses
// (controller.update() runs on the session rAF regardless), but render()
// keeps using the flat desktop camera — so head tracking does nothing and the
// view is locked to the desktop camera position (0, 1.6, 3), i.e. the user
// sees everything from ~3m back. This must be set before presenting.
renderer.xr.enabled = true;
// Three.js's WebXRManager defaults its referenceSpaceType to 'local-floor'
// and requests it during setSession(). That is the correct floor-anchored
// space for a standing Quest 3 user, so we don't need to call
// setReferenceSpaceType() here. Note there is NO silent fallback: if
// requestReferenceSpace('local-floor') rejected, setSession() would throw and
// the session would fail to present — so successfully presenting implies
// local-floor was granted.
document.body.appendChild(renderer.domElement);

// ---------------------------------------------------------------------------
// Scene, camera, background
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
// Solid background color keeps the space from feeling empty without a skybox.
scene.background = new THREE.Color(0x1a1f2b);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(0, 1.6, 3);

// Desktop-only orbit controls. They are disabled/ignored once an XR session
// starts because the XR pose then drives the camera.
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.update();

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------
// Hemisphere light gives soft ambient fill cheaply (one draw call, no shadows).
const hemiLight = new THREE.HemisphereLight(0xbfd4ff, 0x202830, 1.0);
scene.add(hemiLight);

// One directional light for shape definition. Shadows are intentionally off
// to keep Quest 3 draw calls and fill-rate low.
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(3, 6, 4);
scene.add(dirLight);

// ---------------------------------------------------------------------------
// Floor grid
// ---------------------------------------------------------------------------
const grid = new THREE.GridHelper(20, 20, 0x4a6fa5, 0x2a3550);
grid.position.y = 0;
scene.add(grid);

// A subtle floor plane so the grid sits on something solid visually.
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.MeshStandardMaterial({ color: 0x12161f, roughness: 1.0, metalness: 0.0 })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

// ---------------------------------------------------------------------------
// Interactive object
// ---------------------------------------------------------------------------
// A single cube the user can point at and "press" with the controller trigger.
// We tag it so the raycaster can find it among intersectable objects.
const cubeMaterial = new THREE.MeshStandardMaterial({
  color: 0x4488ff,
  roughness: 0.4,
  metalness: 0.1,
  emissive: 0x000000,
});
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(0.4, 0.4, 0.4),
  cubeMaterial
);
cube.position.set(0, 1.0, -1.2);
cube.userData.interactive = true;
scene.add(cube);

// Palette cycled each time the cube is triggered.
const cubePalette = [0x4488ff, 0xff5577, 0x33ddaa, 0xffcc44, 0xaa66ff, 0x66ff88];
let cubePaletteIndex = 0;

// Shared Raycaster reused per interaction to avoid per-frame allocations.
const raycaster = new THREE.Raycaster();
const interactiveObjects = [cube];

// ---------------------------------------------------------------------------
// Controllers + ray-casting
// ---------------------------------------------------------------------------
// XRControllerModelFactory loads the vendor controller model (e.g. Quest
// Touch Plus) for each connected input source.
const controllerModelFactory = new XRControllerModelFactory();

// One entry per controller slot (0 = typically right, 1 = left, per Three.js).
const controllerData = [];

function setupController(index) {
  // `getController` gives an Object3D whose pose tracks the input source's
  // target ray (the pointer origin/direction used for ray-casting).
  const controller = renderer.xr.getController(index);

  // `getControllerGrip` tracks the grip pose; the physical controller model
  // is parented here so it appears in the user's hand.
  const controllerGrip = renderer.xr.getControllerGrip(index);

  // DIAGNOSTIC: capture the exact model object the factory creates and observe
  // its lifecycle. The factory loads the glTF asynchronously and `add`s it to
  // this model object; we then add the model to the grip. We log when the
  // factory's internal 'connected' fires and when the glTF scene is added, so
  // we can confirm the visible model is the one attached to THIS grip.
  const model = controllerModelFactory.createControllerModel(controllerGrip);
  model.addEventListener('connected', (event) => {
    console.log(
      `[ctrl ${index}] MODEL 'connected' fired; input source:`,
      event.data && { handedness: event.data.handedness, targetRayMode: event.data.targetRayMode, hasGripSpace: !!event.data.gripSpace, isHand: !!event.data.hand }
    );
  });
  controllerGrip.add(model);
  scene.add(controllerGrip);

  // A thin line representing the pointer ray, hidden until the controller is
  // connected and reporting a pose. Cheap and helps users aim.
  const rayGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1),
  ]);
  const rayLine = new THREE.Line(
    rayGeometry,
    new THREE.LineBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.7 })
  );
  rayLine.scale.z = 5; // length of the visible ray
  rayLine.visible = false;
  controller.add(rayLine);
  scene.add(controller);

  const data = { controller, controllerGrip, rayLine, model, index };
  controllerData[index] = data;

  // 'selectstart' fires when the trigger is pressed; 'selectend' on release.
  // We treat the press as the "select" action for this simple demo.
  controller.addEventListener('selectstart', () => onSelectStart(data));
  controller.addEventListener('selectend', () => onSelectEnd(data));

  // 'squeezestart' (grip button) confirms a teleport in teleport locomotion mode.
  // Deliberately separate from the cube's 'select' (trigger) binding.
  controller.addEventListener('squeezestart', () => onSqueezeStart(data));

  // Connection lifecycle events: update ray visibility and model availability.
  controller.addEventListener('connected', (event) => {
    console.log(
      `[ctrl ${index}] RAY 'connected' fired; input source:`,
      event.data && { handedness: event.data.handedness, targetRayMode: event.data.targetRayMode, hasGripSpace: !!event.data.gripSpace, isHand: !!event.data.hand }
    );
    data.rayLine.visible = true;
  });
  controller.addEventListener('disconnected', () => {
    console.log(`[ctrl ${index}] RAY 'disconnected' fired`);
    data.rayLine.visible = false;
  });
}

// Pre-create the two standard controller slots so they are ready as soon as
// input sources are reported by the session.
setupController(0);
setupController(1);

// Build a ray from a controller's world transform and return the first
// interactive object it hits (or null).
function raycastFromController(data) {
  // The controller's local -Z is "forward" (pointing direction). Extract just
  // the rotation so we can transform that direction into world space.
  const tempMatrix = new THREE.Matrix4().identity().extractRotation(data.controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(data.controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

  const intersects = raycaster.intersectObjects(interactiveObjects, false);
  return intersects.length > 0 ? intersects[0] : null;
}

function onSelectStart(data) {
  // Trigger pressed: ray-cast and, if it hits the cube, cycle its color.
  const hit = raycastFromController(data);
  if (hit && hit.object === cube) {
    cubePaletteIndex = (cubePaletteIndex + 1) % cubePalette.length;
    cube.material.color.setHex(cubePalette[cubePaletteIndex]);
    // Brief emissive flash for tactile feedback.
    cube.material.emissive.setHex(0x222222);
  }
}

function onSelectEnd() {
  cube.material.emissive.setHex(0x000000);
}

// ---------------------------------------------------------------------------
// Locomotion
// ---------------------------------------------------------------------------
// Two locomotion methods, switchable at runtime:
//   - 'teleport': point a controller at the floor, see an arc + target ring,
//     confirm with the 'squeeze' button (grip) to jump there instantly.
//   - 'smooth': push the thumbstick to move relative to head-forward, with a
//     comfort vignette that narrows the FOV while moving.
//
// CRUCIAL ARCHITECTURE: locomotion never touches the camera or any scene-root
// object. The headset pose is written to the camera every frame by
// WebXRManager (renderer.xr) from the viewer pose, and we must not fight that
// (the earlier OrbitControls bug was exactly that class of conflict). Instead
// we move the player by changing the REFERENCE SPACE the XR poses are
// resolved against: we keep a base reference space (local-floor, set up by
// Three.js during setSession) and maintain an offset reference space
// (base.getOffsetReferenceSpace(transform)) that we install via
// renderer.xr.setReferenceSpace(). The viewer/controller poses are then
// computed against that offset space, so the whole player translates/rotates
// while head tracking remains fully intact on top of it. This is the
// canonical WebXR locomotion technique and avoids per-frame camera mutation.
//
// Input bindings (deliberately distinct from the cube's 'select'/trigger):
//   - Teleport confirm: 'squeeze' (grip button) on either controller.
//   - Smooth move: thumbstick on either controller (x = strafe, y = forward).
//   - Locomotion toggle in VR: 'A' button (gamepad button index 2) on the
//     right controller; also a desktop toggle button on the overlay.
// The cube's color-change stays on the trigger ('select'), unchanged.

const LOCOMOTION_TELEPORT = 'teleport';
const LOCOMOTION_SMOOTH = 'smooth';
// Default to teleport (more comfortable / less motion-sickness prone).
let locomotionMode = LOCOMOTION_TELEPORT;

// The base local-floor reference space, captured once after setSession. All
// locomotion offsets are derived from this so they compose cleanly.
let baseReferenceSpace = null;

// Smooth-locomotion tuning.
const SMOOTH_SPEED = 1.6; // meters per second
// Comfort vignette: a black ring that narrows the visible area while moving.
const vignette = createVignette();
let vignetteIntensity = 0; // 0..1, eased toward target each frame

// Teleport targeting state.
const teleportRaycaster = new THREE.Raycaster();
// Objects the teleport arc can land on (the floor).
const teleportSurfaces = [floor];
// Arc curve + target ring, hidden unless a controller is pointing at the floor.
const teleportArc = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0x66ffaa, transparent: true, opacity: 0.85 })
);
teleportArc.visible = false;
scene.add(teleportArc);
const teleportRing = new THREE.Mesh(
  new THREE.RingGeometry(0.12, 0.18, 32),
  new THREE.MeshBasicMaterial({ color: 0x66ffaa, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
);
teleportRing.rotation.x = -Math.PI / 2;
teleportRing.visible = false;
scene.add(teleportRing);
// Scratch vectors reused per frame to avoid allocations.
const _teleportOrigin = new THREE.Vector3();
const _teleportDir = new THREE.Vector3();
const _teleportHit = new THREE.Vector3(); // dedicated return value to avoid aliasing _tmpVec3
const _tmpMat4 = new THREE.Matrix4();
const _tmpVec3 = new THREE.Vector3();
const _moveVec = new THREE.Vector3();
const _headForward = new THREE.Vector3();

// Per-controller gamepad state, polled each frame from inputSource.gamepad.
// We store the last-frame thumbstick so we can detect edges if needed, and a
// smoothed squeeze value isn't required (squeeze is binary via events).
const gamepadState = [null, null];

// Reusable temp arrays for the teleport parabola sample points.
const ARC_SEGMENTS = 24;
const arcPoints = [];
for (let i = 0; i <= ARC_SEGMENTS; i++) arcPoints.push(new THREE.Vector3());

function createVignette() {
  // A simple screen-space-ish vignette: a ring mesh placed in front of the
  // camera is too fiddly with stereo XR. Instead use a radial-gradient texture
  // on a fullscreen-ish plane attached to the camera. The simplest robust XR
  // vignette is a canvas-texture plane positioned just in front of the camera
  // and rendered on top (depthTest false). We parent it to the camera so it
  // follows head tracking automatically.
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(
    size / 2, size / 2, size * 0.18,
    size / 2, size / 2, size * 0.5
  );
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.renderOrder = 999;
  mesh.frustumCulled = false;
  // Position close to camera, in front. Parented to the camera so it tracks
  // head movement automatically.
  mesh.position.set(0, 0, -1);
  mesh.visible = false;
  return mesh;
}

// Install (or clear) the locomotion offset as the renderer's reference space.
// offset is an XRRigidTransform (position+orientation) relative to the base
// local-floor space. Pass null to reset to the base space.
function applyLocomotionOffset(x, z, yaw) {
  if (!baseReferenceSpace) return;
  // XRRigidTransform is a NATIVE WebXR global (not a Three.js export). Its
  // constructor takes (position, orientation) as DOMPointInit objects
  // {x,y,z,w}. We only translate the player on the floor plane (x,z); y and the
  // orientation stay identity (no yaw in v1).
  const t = new XRRigidTransform(
    { x: x, y: 0, z: z, w: 1 },
    { x: 0, y: 0, z: 0, w: 1 }
  );
  const offsetSpace = baseReferenceSpace.getOffsetReferenceSpace(t);
  renderer.xr.setReferenceSpace(offsetSpace);
}

// Teleport: instantly move the player so that their current head position
// maps to `targetX/targetZ` (i.e. the spot they aimed at ends up under their
// head). We compute the offset from where the head currently is (in base-space)
// to the target, then install that offset reference space.
function teleportTo(targetX, targetZ) {
  if (!baseReferenceSpace) return;
  // Current head position in the base reference space. While presenting, the
  // camera's world position equals its base-space position when no offset is
  // applied; to be robust we read it relative to the current reference space
  // (which already includes any prior locomotion). The simplest correct read:
  // get the viewer pose from the current frame. We don't have the frame here
  // (event handler), so instead compute from the camera world position minus
  // the current offset translation we track.
  //
  // We track the player's accumulated offset (playerOffsetX/Z) which is exactly
  // the translation component of the installed offset space. The head's
  // base-space position = cameraWorldPos - playerOffset (since the offset
  // space shifts everything by playerOffset). So target offset =
  // playerOffset + (target - headBase).
  camera.getWorldPosition(_tmpVec3);
  const headBaseX = _tmpVec3.x - playerOffsetX;
  const headBaseZ = _tmpVec3.z - playerOffsetZ;
  playerOffsetX = playerOffsetX + (targetX - headBaseX);
  playerOffsetZ = playerOffsetZ + (targetZ - headBaseZ);
  applyLocomotionOffset(playerOffsetX, playerOffsetZ, 0);
}

// Accumulated player offset (translation of the installed offset space).
// Declared before teleportTo uses it (module init runs these before any call).
let playerOffsetX = 0;
let playerOffsetZ = 0;

// Build the teleport parabola from a controller's ray and update the arc +
// ring. Returns the landing point (Vector3) if it hits the floor, else null.
function updateTeleportAim(data) {
  // Origin + direction from the controller target-ray pose.
  _tmpMat4.identity().extractRotation(data.controller.matrixWorld);
  _teleportOrigin.setFromMatrixPosition(data.controller.matrixWorld);
  _teleportDir.set(0, 0, -1).applyMatrix4(_tmpMat4);

  // Simple projectile parabola for a natural aiming arc.
  const speed = 6;
  const gravity = 9.8;
  let hitPoint = null;
  let hitDist = 0;
  // Sample the parabola and intersect with the floor (y=0 plane) along the way.
  const vx = _teleportDir.x * speed;
  const vy = _teleportDir.y * speed;
  const vz = _teleportDir.z * speed;
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const dt = i * 0.04;
    const px = _teleportOrigin.x + vx * dt;
    const py = _teleportOrigin.y + vy * dt - 0.5 * gravity * dt * dt;
    const pz = _teleportOrigin.z + vz * dt;
    arcPoints[i].set(px, py, pz);
    if (hitPoint === null && py <= 0 && i > 0) {
      // Linearly interpolate between i-1 and i to find the y=0 crossing.
      const prev = arcPoints[i - 1];
      const frac = prev.y / (prev.y - py);
      hitPoint = _teleportHit.set(
        prev.x + (px - prev.x) * frac,
        0,
        prev.z + (pz - prev.z) * frac
      );
      hitDist = i;
    }
  }
  if (!hitPoint) {
    teleportArc.visible = false;
    teleportRing.visible = false;
    return null;
  }
  // Draw arc up to the hit point.
  const positions = [];
  for (let i = 0; i <= hitDist; i++) {
    positions.push(arcPoints[i].x, arcPoints[i].y, arcPoints[i].z);
  }
  positions.push(hitPoint.x, hitPoint.y, hitPoint.z);
  teleportArc.geometry.setPositions(positions);
  teleportArc.visible = true;
  teleportRing.position.set(hitPoint.x, 0.01, hitPoint.z);
  teleportRing.visible = true;
  return hitPoint;
}

// Per-frame locomotion update. Called from animate() only while presenting.
// frame is the XRFrame (needed for nothing here now, but kept for parity).
function updateLocomotion(dt) {
  // Attach the vignette to the camera on first presenting frame (it must be a
  // child of the camera that renderer.xr actually uses; parenting to our user
  // camera works because updateCamera copies transforms).
  if (vignette.parent !== camera) {
    camera.add(vignette);
  }

  if (locomotionMode === LOCOMOTION_TELEPORT) {
    // Show the aim arc from any controller pointing roughly downward at the
    // floor. We use the first controller with a visible ray that yields a hit.
    let aim = null;
    for (const data of controllerData) {
      if (data && data.controllerGrip.visible) {
        const p = updateTeleportAim(data);
        if (p) { aim = p; break; }
      }
    }
    if (!aim) {
      teleportArc.visible = false;
      teleportRing.visible = false;
    }
    // Teleport is confirmed via the 'squeeze' event (onSqueezeStart), not here.
    vignetteIntensity = 0;
  } else if (locomotionMode === LOCOMOTION_SMOOTH) {
    // Hide teleport visuals while in smooth mode.
    teleportArc.visible = false;
    teleportRing.visible = false;
    // Sum thumbstick inputs from all controllers; move relative to head-forward.
    _moveVec.set(0, 0, 0);
    let moving = false;
    for (const gp of gamepadState) {
      if (!gp || !gp.axes) continue;
      // Quest Touch: axes[2]/[3] are the thumbstick on most profiles; axes[0]/[1]
      // are also sometimes the stick. We take the axes with the largest magnitude
      // among the last two pairs to be robust across profiles.
      const ax = gp.axes.length >= 4 ? gp.axes[2] : (gp.axes[0] || 0);
      const ay = gp.axes.length >= 4 ? gp.axes[3] : (gp.axes[1] || 0);
      if (Math.abs(ax) > 0.15 || Math.abs(ay) > 0.15) {
        _moveVec.x += ax;
        _moveVec.z += ay;
        moving = true;
      }
    }
    if (moving && baseReferenceSpace) {
      // Direction relative to head-forward. Head forward = camera -Z in world.
      _headForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      _headForward.y = 0;
      _headForward.normalize();
      // Right = head-forward rotated -90deg around Y.
      const right = _tmpMat4.makeRotationY(-Math.PI / 2);
      const headRight = _headForward.clone().applyMatrix4(right).normalize();
      // Forward input is -ay (push up = forward), strafe is ax.
      const forwardAmt = -_moveVec.z;
      const strafeAmt = _moveVec.x;
      const dx = _headForward.x * forwardAmt + headRight.x * strafeAmt;
      const dz = _headForward.z * forwardAmt + headRight.z * strafeAmt;
      const len = Math.hypot(dx, dz);
      if (len > 0) {
        const step = SMOOTH_SPEED * dt;
        playerOffsetX += (dx / len) * step * Math.min(1, len);
        playerOffsetZ += (dz / len) * step * Math.min(1, len);
        applyLocomotionOffset(playerOffsetX, playerOffsetZ, 0);
        vignetteIntensity = 1;
      }
    } else {
      vignetteIntensity = 0;
    }
  }

  // Ease the vignette toward its target.
  const target = vignetteIntensity;
  vignette.material.opacity += (target - vignette.material.opacity) * Math.min(1, dt * 8);
  vignette.visible = vignette.material.opacity > 0.01;
}

// Teleport confirm handler, bound to 'squeeze' (grip) on each controller.
// Deliberately a different button from the cube's 'select' (trigger).
function onSqueezeStart(data) {
  if (locomotionMode !== LOCOMOTION_TELEPORT) return;
  const p = updateTeleportAim(data);
  if (p) teleportTo(p.x, p.z);
}

// Toggle locomotion mode (teleport <-> smooth). Called from the desktop UI
// button and the VR 'A' button.
function toggleLocomotionMode() {
  locomotionMode =
    locomotionMode === LOCOMOTION_TELEPORT ? LOCOMOTION_SMOOTH : LOCOMOTION_TELEPORT;
  updateLocomotionModeUI();
  console.log('[locomotion] mode ->', locomotionMode);
}

// --- Desktop UI toggle button ---
const locomotionToggleContainer = document.getElementById('locomotion-toggle-container');
function buildLocomotionToggleButton() {
  const btn = document.createElement('button');
  btn.id = 'locomotion-toggle-btn';
  btn.textContent = '';
  btn.addEventListener('click', toggleLocomotionMode);
  return btn;
}
const locomotionToggleBtn = buildLocomotionToggleButton();
locomotionToggleContainer.appendChild(locomotionToggleBtn);
function updateLocomotionModeUI() {
  if (!locomotionToggleBtn) return;
  locomotionToggleBtn.textContent =
    'Locomotion: ' + (locomotionMode === LOCOMOTION_TELEPORT ? 'Teleport' : 'Smooth') + ' (click to switch)';
}
updateLocomotionModeUI();

// Poll controller gamepads each frame for thumbstick (smooth locomotion) and
// detect a rising edge on button index 2 to toggle locomotion mode in VR.
// Quest Touch button indices (per the WebXR gamepad mapping):
//   0 = trigger, 1 = squeeze/grip, 2 = A/X, 3 = B/Y, 4 = thumbstick press.
// We use button 2 (A/X) to toggle locomotion mode — distinct from the cube's
// trigger (button 0 / 'select') and teleport's grip (button 1 / 'squeeze').
let toggleButtonWasDown = false;
function pollGamepads(frame) {
  const session = renderer.xr.getSession();
  if (!session) return;
  const sources = session.inputSources;
  // Reset per-frame gamepad slots; we map by controller index (handedness not
  // strictly needed here since movement just sums all thumbsticks).
  gamepadState[0] = null;
  gamepadState[1] = null;
  let toggleDown = false;
  for (const src of sources) {
    const idx = src.handedness === 'right' ? 0 : 1;
    if (src.gamepad) {
      gamepadState[idx] = src.gamepad;
      // Detect A/X button (index 2) rising edge on the right controller.
      if (src.handedness === 'right' && src.gamepad.buttons.length > 2) {
        if (src.gamepad.buttons[2].pressed) toggleDown = true;
      }
    }
  }
  if (toggleDown && !toggleButtonWasDown) toggleLocomotionMode();
  toggleButtonWasDown = toggleDown;
}

// ---------------------------------------------------------------------------
// Animation / render loop
// ---------------------------------------------------------------------------
// renderer.setAnimationLoop is the WebXR-correct entry point: when an XR
// session is active, Three.js binds this callback to the session's own
// requestAnimationFrame, so the loop is driven by the headset's vsync. On a
// desktop (no XR session) it falls back to the standard window rAF. The
// optional `frame` argument is the XRFrame, available during XR.
function animate(timestamp, frame) {
  // Frame delta time (seconds), clamped so a stalled/hitched frame can't fling
  // the player across the room in smooth locomotion.
  const dt = Math.min(0.05, (timestamp - (lastTimestamp || timestamp)) / 1000);
  lastTimestamp = timestamp;

  // Desktop preview: gently rotate the cube so the scene feels alive even
  // without a headset. (Harmless in XR too; cheap.)
  cube.rotation.y += 0.005;

  // Hover highlight: if either controller ray is currently over the cube,
  // nudge its emissive so the user knows it is targeted.
  // NOTE: while presenting in XR, the headset pose (position + quaternion) is
  // applied to the camera by WebXRManager via renderer.xr. OrbitControls is
  // bound to that same camera object, so calling controls.update() while in XR
  // would overwrite the headset pose from its internal spherical state and
  // freeze the view. Skip it entirely when presenting.
  const isPresenting = renderer.xr.isPresenting;
  let hovering = false;
  for (const data of controllerData) {
    if (data && data.rayLine.visible) {
      const hit = raycastFromController(data);
      if (hit && hit.object === cube) {
        hovering = true;
        break;
      }
    }
  }
  // Only apply hover emissive when not mid-trigger-flash (see onSelectEnd).
  if (hovering && cube.material.emissive.getHex() === 0x000000) {
    cube.material.emissive.setHex(0x111111);
  } else if (!hovering && cube.material.emissive.getHex() === 0x111111) {
    cube.material.emissive.setHex(0x000000);
  }

  // Only drive the camera from OrbitControls in the flat desktop preview.
  // In XR, WebXRManager owns the camera pose; controls.update() must not run.
  if (!isPresenting) controls.update();

  // Locomotion runs only while presenting, and crucially AFTER WebXRManager
  // has applied the headset pose to the camera this frame (that happens inside
  // renderer.render below via xr.updateCamera/getCamera). For smooth locomotion
  // we read the camera's quaternion (head-forward) which is already updated
  // for the current frame by the time the previous frame rendered it; reading
  // it here is fine because we apply movement to the REFERENCE SPACE, not the
  // camera, so there is no fight with head tracking.
  if (isPresenting) {
    pollGamepads(frame);
    updateLocomotion(dt);
  }

  // Confirm step 3: the render loop actually reached the XR presentation path.
  // Logged once on the first frame where isPresenting is true.
  if (isPresenting && !loggedFirstXRFrame) {
    loggedFirstXRFrame = true;
    console.log('[WebXR] step 3: first XR-presenting frame rendered');
  }

  // DIAGNOSTIC: report live grip/controller state every frame. This directly
  // observes whether the grip group's matrixWorld is changing at all, and
  // whether a model is actually attached to the live grip (vs. a leftover).
  // The on-screen overlay updates every frame (readable in-headset); the
  // console log is throttled to ~2x/second.
  const dbgLines = [];
  // Surface xr.enabled and the session's enabledFeatures so the origin/floor
  // question can be confirmed at runtime: enabled must be true to use the XR
  // camera, and the resolved features should include 'local-floor'.
  const session = renderer.xr.getSession();
  const features = session && session.enabledFeatures
    ? session.enabledFeatures.join(',')
    : 'none';
  dbgLines.push(`presenting=${isPresenting} xr.enabled=${renderer.xr.enabled} feats=${features}`);
  dbgLines.push(`locomotion=${locomotionMode} player=(${playerOffsetX.toFixed(2)},${playerOffsetZ.toFixed(2)})`);
  for (const data of controllerData) {
    if (!data) continue;
    const gripPos = new THREE.Vector3().setFromMatrixPosition(data.controllerGrip.matrixWorld);
    const rayPos = new THREE.Vector3().setFromMatrixPosition(data.controller.matrixWorld);
    const gripVisible = data.controllerGrip.visible;
    const modelChildren = data.model.children.length;
    // Walk the loaded glTF scene (first child of the XRControllerModel) to see
    // if it has meshes; if the load failed or hasn't happened, this is 0.
    let modelMeshCount = 0;
    if (data.model.children.length > 0) {
      data.model.children[0].traverse((n) => { if (n.isMesh) modelMeshCount++; });
    }
    const dbg =
      `c${data.index}: grip.pos=(${gripPos.x.toFixed(2)},${gripPos.y.toFixed(2)},${gripPos.z.toFixed(2)}) ` +
      `ray.pos=(${rayPos.x.toFixed(2)},${rayPos.y.toFixed(2)},${rayPos.z.toFixed(2)}) ` +
      `grip.vis=${gripVisible} model.kids=${modelChildren} model.meshes=${modelMeshCount}`;
    dbgLines.push(dbg);
  }
  setDebugText(dbgLines.join('\n'));
  if (timestamp && timestamp - lastConsoleDiag > 500) {
    lastConsoleDiag = timestamp;
    console.log('[diag]', dbgLines.join(' | '));
  }

  renderer.render(scene, camera);
}
// Wrap the loop body so a throw inside a frame (which would otherwise kill the
// rAF chain silently and look like a hang) is caught, logged, and reported.
function safeAnimate(timestamp, frame) {
  try {
    animate(timestamp, frame);
  } catch (err) {
    console.error('[animate threw]', err);
    setDebugText('animate ERROR: ' + (err && err.message ? err.message : err));
  }
}
renderer.setAnimationLoop(safeAnimate);

// ---------------------------------------------------------------------------
// Responsive canvas (desktop / window resize). XR sessions manage their own
// framebuffer size, so this only matters for the flat preview.
// ---------------------------------------------------------------------------
window.addEventListener('resize', onResize, false);
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ---------------------------------------------------------------------------
// WebXR session lifecycle
// ---------------------------------------------------------------------------
// This is the part that is easy to get subtly wrong, so it is spelled out
// step by step. We use navigator.xr directly for capability checks and
// session creation, then hand the session to Three.js's renderer.xr manager
// so it can apply the headset pose and projection each frame.

const overlay = document.getElementById('overlay');
const statusMessage = document.getElementById('status-message');
const buttonContainer = document.getElementById('vr-button-container');

let currentSession = null;

function setStatus(text) {
  statusMessage.textContent = text;
}

function createVRButton() {
  const btn = document.createElement('button');
  btn.id = 'enter-vr-btn';
  btn.textContent = 'Enter VR';
  btn.addEventListener('click', startSession);
  return btn;
}

// Step 1: Capability check.
// navigator.xr may be absent entirely on browsers without WebXR. Even when
// present, immersive-vr support must be checked asynchronously with
// isSessionSupported because only the device/browser knows what it can run.
async function init() {
  if ('xr' in navigator) {
    try {
      const supported = await navigator.xr.isSessionSupported('immersive-vr');
      if (supported) {
        // Device can do immersive VR: show the Enter VR button.
        buttonContainer.innerHTML = '';
        buttonContainer.appendChild(createVRButton());
        setStatus('Ready. Put on your headset and press Enter VR.');
      } else {
        // WebXR exists but immersive-vr is unavailable (e.g. desktop browser).
        buttonContainer.innerHTML = '';
        setStatus('WebXR is present but immersive-vr is not supported on this device. Showing a flat 3D preview.');
      }
    } catch (error) {
      // isSessionSupported can reject if the XR system cannot be queried.
      buttonContainer.innerHTML = '';
      setStatus('Could not query WebXR support: ' + error.message);
    }
  } else {
    // No navigator.xr at all: classic desktop fallback.
    buttonContainer.innerHTML = '';
    setStatus('WebXR is not supported in this browser. Showing a flat 3D preview. Try the Meta Quest 3 browser or a WebXR-enabled desktop browser.');
  }
}

// Step 2: Request a session.
// 'immersive-ar' is not requested here; we want full VR. The required
// features list is kept minimal so the request succeeds broadly.
//
// IMPORTANT: 'hand-tracking' is intentionally NOT requested here. On the
// Quest 3 the runtime can report hand input sources at the same time as (or
// instead of) the touch controllers when hand-tracking is enabled. A hand
// input source has a valid targetRaySpace (so the pointer ray tracks) but a
// null gripSpace (per the WebXR spec, hands are not "held"). Three.js's
// WebXRController.update() only writes the grip group's matrix when
// inputSource.gripSpace is non-null, so if a hand source lands on a controller
// slot the ray keeps updating while the controller MODEL freezes at the grip
// group's origin — the exact "model frozen ~3m from hand" symptom.
// Keeping this controller-only means every slot is a tracked-pointer source
// with a valid gripSpace, so the controller models track. Hand tracking is a
// planned iteration and should be added via renderer.xr.getHand() with its own
// handling rather than piggybacking on the controller/grip slots.
// Each session-start step is logged with a tag and timed, and wrapped in a
// timeout that rejects if the step never resolves. This turns a silent hang
// into a clear "step X never completed" signal. Errors are surfaced BOTH to
// the console and to a always-visible status line (the overlay may be hidden
// during XR, so setStatus() alone is not enough — see showError()).
const STEP_TIMEOUT_MS = 10000;
function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Step "${label}" did not complete within ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS)
    ),
  ]);
}

// Always-visible error surface: also push the message to the (possibly hidden)
// overlay status so it shows up if the overlay is later re-shown on exit.
function showError(message) {
  console.error('[WebXR] ' + message);
  setStatus('VR error: ' + message);
  // Make sure the overlay is visible so the error is actually readable.
  overlay.classList.remove('hidden');
}

async function startSession() {
  if (currentSession) return;
  console.log('[WebXR] step 1: requestSession start');
  let session;
  try {
    session = await withTimeout(
      navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor'],
      }),
      'requestSession'
    );
  } catch (error) {
    showError('requestSession failed: ' + error.message);
    return;
  }
  console.log('[WebXR] step 1: requestSession OK', session && session.enabledFeatures);
  await onSessionStarted(session);
}

// Step 3: Hand the session to Three.js and attach lifecycle listeners.
// renderer.xr.setSession sets up the reference space and makes the renderer
// render stereo to the headset within the existing setAnimationLoop callback.
// Note: we do NOT hide the overlay until setSession has resolved, so that any
// rejection here is still reported on a visible page.
async function onSessionStarted(session) {
  currentSession = session;
  // OrbitControls is bound to the same camera WebXRManager uses for the headset
  // pose. Disable it now so its spherical state never overwrites head tracking
  // while presenting (also guarded in the render loop via isPresenting).
  controls.enabled = false;

  // Clean up if the session ends from the system side (e.g. user pressed the
  // Oculus/Home button). Must be bound once and removed on our own end.
  session.addEventListener('end', onSessionEnded);

  console.log('[WebXR] step 2: renderer.xr.setSession start');
  try {
    // setSession() internally awaits gl.makeXRCompatible() (skipped if the
    // context was created with xrCompatible:true), builds the XR render layer,
    // awaits session.requestReferenceSpace('local-floor'), and starts the
    // session-bound animation loop. If any of these hangs or rejects, the
    // timeout makes it observable instead of silently never completing.
    await withTimeout(renderer.xr.setSession(session), 'renderer.xr.setSession');
  } catch (error) {
    showError('setSession failed: ' + error.message);
    // Tear down the half-started session so the state is clean.
    try { await session.end(); } catch (_) {}
    currentSession = null;
    return;
  }
  console.log('[WebXR] step 2: renderer.xr.setSession OK, isPresenting=', renderer.xr.isPresenting);

  // Capture the base local-floor reference space once, after setSession has
  // resolved it. All locomotion offsets are derived from this space so they
  // compose cleanly and head tracking stays intact on top.
  baseReferenceSpace = renderer.xr.getReferenceSpace();
  // Reset any accumulated player offset and clear a custom reference space so
  // the session starts at the true origin.
  playerOffsetX = 0;
  playerOffsetZ = 0;
  renderer.xr.setReferenceSpace(null);
  console.log('[WebXR] base reference space captured:', baseReferenceSpace && baseReferenceSpace.type);

  // Now that presentation is fully established, hide the overlay. It is not
  // visible in-headset anyway, but this keeps the flat page tidy on exit.
  overlay.classList.add('hidden');

  // step 3 (first XR frame) is confirmed by a one-shot log in animate() below.
  setStatus('In VR. Press the controller trigger while pointing at the cube.');
}

// Set once on the first XR-presenting frame so we can confirm the render loop
// actually reached the presentation path.
let loggedFirstXRFrame = false;

// Step 4: Teardown when the session ends (either user-initiated or system).
// Reverse the setup from onSessionStarted: remove the listener, drop the
// session from the renderer, and show the overlay again for a clean exit.
function onSessionEnded() {
  const session = currentSession;
  if (session) {
    session.removeEventListener('end', onSessionEnded);
  }
  currentSession = null;
  renderer.xr.setSession(null);
  // Drop the locomotion offset reference space and clear the base space so the
  // next session starts at the true origin with a fresh local-floor space.
  renderer.xr.setReferenceSpace(null);
  baseReferenceSpace = null;
  playerOffsetX = 0;
  playerOffsetZ = 0;
  // Hide any locomotion visuals and the vignette.
  teleportArc.visible = false;
  teleportRing.visible = false;
  vignette.visible = false;
  vignette.material.opacity = 0;
  // Re-enable desktop orbit controls now that WebXRManager is no longer
  // driving the camera. Restore the camera's manual pose the user had before
  // entering VR, since the headset pose would otherwise linger.
  controls.enabled = true;
  controls.update();
  // Reset so the next VR entry logs the first presenting frame again.
  loggedFirstXRFrame = false;
  overlay.classList.remove('hidden');
  setStatus('Exited VR. Press Enter VR to re-enter.');
}

// Kick things off.
init();
