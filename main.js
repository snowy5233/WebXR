import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

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
  controllerGrip.add(controllerModelFactory.createControllerModel(controllerGrip));
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

  const data = { controller, controllerGrip, rayLine };
  controllerData[index] = data;

  // 'selectstart' fires when the trigger is pressed; 'selectend' on release.
  // We treat the press as the "select" action for this simple demo.
  controller.addEventListener('selectstart', () => onSelectStart(data));
  controller.addEventListener('selectend', () => onSelectEnd(data));

  // Connection lifecycle events: update ray visibility and model availability.
  controller.addEventListener('connected', (event) => {
    data.rayLine.visible = true;
  });
  controller.addEventListener('disconnected', () => {
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
// Animation / render loop
// ---------------------------------------------------------------------------
// renderer.setAnimationLoop is the WebXR-correct entry point: when an XR
// session is active, Three.js binds this callback to the session's own
// requestAnimationFrame, so the loop is driven by the headset's vsync. On a
// desktop (no XR session) it falls back to the standard window rAF. The
// optional `frame` argument is the XRFrame, available during XR.
function animate(timestamp, frame) {
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
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

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
async function startSession() {
  if (currentSession) return;
  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor'],
    });
    onSessionStarted(session);
  } catch (error) {
    setStatus('Failed to start VR session: ' + error.message);
  }
}

// Step 3: Hand the session to Three.js and attach lifecycle listeners.
// renderer.xr.setSession sets up the reference space and makes the renderer
// render stereo to the headset within the existing setAnimationLoop callback.
async function onSessionStarted(session) {
  currentSession = session;
  // OrbitControls is bound to the same camera WebXRManager uses for the headset
  // pose. Disable it now so its spherical state never overwrites head tracking
  // while presenting (also guarded in the render loop via isPresenting).
  controls.enabled = false;
  // Hide the overlay while immersed; it is not visible in-headset anyway, but
  // this keeps the flat page tidy if the user later exits VR.
  overlay.classList.add('hidden');

  // Clean up if the session ends from the system side (e.g. user pressed the
  // Oculus/Home button). Must be bound once and removed on our own end.
  session.addEventListener('end', onSessionEnded);

  await renderer.xr.setSession(session);

  setStatus('In VR. Press the controller trigger while pointing at the cube.');
}

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
  // Re-enable desktop orbit controls now that WebXRManager is no longer
  // driving the camera. Restore the camera's manual pose the user had before
  // entering VR, since the headset pose would otherwise linger.
  controls.enabled = true;
  controls.update();
  overlay.classList.remove('hidden');
  setStatus('Exited VR. Press Enter VR to re-enter.');
}

// Kick things off.
init();
