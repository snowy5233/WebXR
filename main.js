// Bootstrap + WebXR session lifecycle (VR and AR).
//
// This is the part that is easy to get subtly wrong, so it is spelled out
// step by step. We use navigator.xr directly for capability checks and
// session creation, then hand the session to Three.js's renderer.xr manager
// so it can apply the headset pose and projection each frame.
//
// Session feature requests:
//   VR: optionalFeatures ['local-floor', 'bounded-floor']
//   AR: requiredFeatures ['hit-test', 'local-floor'],
//       optionalFeatures ['hand-tracking', 'dom-overlay']
//
// NOTE: 'hand-tracking' is NOT requested for VR — on the Quest 3 browser it
// stalls requestSession indefinitely (see startSession). If the runtime
// still exposes hand input sources, controllers.js/hands.js handle them.
//
// hand-tracking IS requested now (unlike v1): hands are handled via
// renderer.xr.getHand() with their own visual (hands.js), and the controller
// model is hidden for hand input sources (controllers.js 'connected'), so the
// v1 "frozen model" bug can no longer occur.

import * as THREE from 'three';
import { renderer, scene, camera, controls } from './src/scene.js';
import { installGlobalErrorHandlers, setDebugText } from './src/debug.js';
import { showDiagnostics, hideDiagnostics, updateDiagnostics, reportLoopError } from './src/diagnostics.js';
import { controllerData, pollGamepads, inputCallbacks, squeezeCallbacks, updateHover } from './src/controllers.js';
import { setupHands } from './src/hands.js';
import {
  LOCOMOTION_TELEPORT, LOCOMOTION_SMOOTH, getLocomotionMode, setLocomotionMode,
  captureBaseReferenceSpace, clearBaseReferenceSpace,
  updateLocomotion, handleSqueeze, resetLocomotionVisuals, getPlayerOffset,
} from './src/locomotion.js';
import { cube, updatePhysics, resetGrabbables, anyGrabbedBy } from './src/objects.js';
import { toggleMenu, closeMenu, updateMenu } from './src/menu.js';
import { startARHitTest, updateAR, placeMarker, enterARVisuals, exitARVisuals, isARActive, captureDefaultBackground } from './src/ar.js';

installGlobalErrorHandlers();
setupHands();
captureDefaultBackground();

const overlay = document.getElementById('overlay');
const statusMessage = document.getElementById('status-message');
const buttonContainer = document.getElementById('vr-button-container');
const locomotionToggleContainer = document.getElementById('locomotion-toggle-container');

let currentSession = null;
let lastTimestamp = 0;
let lastConsoleDiag = 0;
let loggedFirstXRFrame = false;
let lastARMode = false;
// Controller slots whose trigger was pressed this frame (for menu clicks).
const selectPresses = new Set();

function setStatus(text) {
  statusMessage.textContent = text;
}

// ---------------------------------------------------------------------------
// Overlay buttons: Enter VR / Enter AR + locomotion toggle.
// ---------------------------------------------------------------------------
function makeButton(id, text, onClick) {
  const btn = document.createElement('button');
  btn.id = id;
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

// ---------------------------------------------------------------------------
// Capability checks + overlay wiring.
// ---------------------------------------------------------------------------
async function init() {
  if (!('xr' in navigator)) {
    setStatus('WebXR is not supported in this browser. Showing a flat 3D preview. Try the Meta Quest 3 browser or a WebXR-enabled desktop browser.');
    return;
  }
  try {
    const vrSupported = await navigator.xr.isSessionSupported('immersive-vr');
    let arSupported = false;
    try { arSupported = await navigator.xr.isSessionSupported('immersive-ar'); } catch (_) {}
    buttonContainer.innerHTML = '';
    if (vrSupported) buttonContainer.appendChild(makeButton('enter-vr-btn', 'Enter VR', () => startSession('immersive-vr')));
    if (arSupported) buttonContainer.appendChild(makeButton('enter-ar-btn', 'Enter AR', () => startSession('immersive-ar')));
    if (vrSupported || arSupported) {
      setStatus('Ready. Put on your headset and press Enter VR (or Enter AR for passthrough).');
    } else {
      setStatus('WebXR is present but immersive sessions are not supported on this device. Showing a flat 3D preview.');
    }
  } catch (error) {
    setStatus('Could not query WebXR support: ' + error.message);
  }

  // Desktop locomotion toggle (also usable pre-VR).
  const toggleBtn = makeButton('locomotion-toggle-btn', '', () => {
    setLocomotionMode(getLocomotionMode() === LOCOMOTION_TELEPORT ? LOCOMOTION_SMOOTH : LOCOMOTION_TELEPORT);
    updateToggleLabel();
  });
  locomotionToggleContainer.appendChild(toggleBtn);
  function updateToggleLabel() {
    toggleBtn.textContent = 'Locomotion: ' + (getLocomotionMode() === LOCOMOTION_TELEPORT ? 'Teleport' : 'Smooth') + ' (click to switch)';
  }
  updateToggleLabel();
}

// ---------------------------------------------------------------------------
// Session start/end with per-step timeouts (unchanged pattern from v1).
// ---------------------------------------------------------------------------
const STEP_TIMEOUT_MS = 10000;
function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Step "${label}" did not complete within ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS)
    ),
  ]);
}

function showError(message) {
  console.error('[WebXR] ' + message);
  setStatus('XR error: ' + message);
  overlay.classList.remove('hidden');
}

async function startSession(mode) {
  if (currentSession) return;
  console.log('[WebXR] step 1: requestSession start', mode);
  let session;
  try {
    if (mode === 'immersive-ar') {
      session = await withTimeout(
        navigator.xr.requestSession('immersive-ar', {
          requiredFeatures: ['hit-test', 'local-floor'],
          optionalFeatures: ['hand-tracking', 'dom-overlay'],
          domOverlay: { root: overlay },
        }),
        'requestSession'
      );
    } else {
      session = await withTimeout(
        navigator.xr.requestSession('immersive-vr', {
          // Keep the VR request to the known-good v1 feature set. Requesting
      // 'hand-tracking' here stalled requestSession indefinitely on the
      // Quest 3 browser (the runtime appears to wait on the hand-tracking
      // permission/switch flow before resolving). Hands are still supported:
      // if the runtime reports hand sources anyway, hands.js handles them.
      optionalFeatures: ['local-floor', 'bounded-floor'],
        }),
        'requestSession'
      );
    }
  } catch (error) {
    showError('requestSession failed: ' + error.message);
    return;
  }
  console.log('[WebXR] step 1: requestSession OK', session && session.enabledFeatures);
  await onSessionStarted(session, mode);
}

async function onSessionStarted(session, mode) {
  currentSession = session;
  controls.enabled = false;
  session.addEventListener('end', onSessionEnded);

  console.log('[WebXR] step 2: renderer.xr.setSession start');
  try {
    await withTimeout(renderer.xr.setSession(session), 'renderer.xr.setSession');
  } catch (error) {
    showError('setSession failed: ' + error.message);
    try { await session.end(); } catch (_) {}
    currentSession = null;
    return;
  }
  console.log('[WebXR] step 2: renderer.xr.setSession OK, isPresenting=', renderer.xr.isPresenting);

  // Capture the base local-floor reference space; locomotion derives all
  // offsets from it so they compose cleanly with head tracking.
  captureBaseReferenceSpace();
  renderer.xr.setReferenceSpace(null);

  if (mode === 'immersive-ar') {
    // AR passthrough: transparent background, hide the VR environment, start
    // hit-testing for the placement reticle. Teleport is disabled in AR, so
    // pin the session to smooth locomotion from the start.
    enterARVisuals();
    startARHitTest(session);
    setLocomotionMode(LOCOMOTION_SMOOTH);
  }

  resetGrabbables();
  overlay.classList.add('hidden');
  // In-world status panel: shows session state, and crucially any per-frame
  // error, readable INSIDE the headset (the DOM overlay is invisible there).
  showDiagnostics(mode === 'immersive-ar' ? 'AR ready. Trigger places markers.' : 'VR ready. Trigger grabs; A/X menu.');
  setStatus(mode === 'immersive-ar'
    ? 'In AR. Trigger places a marker on real surfaces.'
    : 'In VR. Trigger grabs objects / cycles the cube; A/X opens the menu.');
}

function onSessionEnded() {
  const session = currentSession;
  if (session) session.removeEventListener('end', onSessionEnded);
  currentSession = null;
  renderer.xr.setSession(null);
  renderer.xr.setReferenceSpace(null);
  clearBaseReferenceSpace();
  resetLocomotionVisuals();
  exitARVisuals();
  closeMenu();
  hideDiagnostics();
  resetGrabbables();
  controls.enabled = true;
  controls.update();
  loggedFirstXRFrame = false;
  overlay.classList.remove('hidden');
  setStatus('Exited XR. Press a button to re-enter.');
}

// ---------------------------------------------------------------------------
// In-VR input wiring.
// ---------------------------------------------------------------------------
inputCallbacks.onAButton = () => toggleMenu();
inputCallbacks.onBButton = () => {
  // Teleport is disabled in AR (it only shifts virtual content relative to
  // the real room), so in AR keep the mode pinned to smooth.
  if (isARActive()) return;
  setLocomotionMode(getLocomotionMode() === LOCOMOTION_TELEPORT ? LOCOMOTION_SMOOTH : LOCOMOTION_TELEPORT);
  console.log('[locomotion] mode ->', getLocomotionMode());
};
squeezeCallbacks.onSqueeze = (data) => handleSqueeze(data);

// Menu clicks and AR placement reuse the controller 'selectstart';
// controllers.js dispatches grab/cube actions first (and those raycasts skip
// the menu panel), so we observe the raw events here too.
for (const data of controllerData) {
  if (!data) continue;
  data.controller.addEventListener('selectstart', () => {
    selectPresses.add(data);
    // AR mode: place a marker only when the trigger didn't grab an object
    // (controllers.js dispatches grab/cube first on the same event).
    if (isARActive() && !anyGrabbedBy(data.controllerGrip) && !anyGrabbedBy(data.controller)) placeMarker();
  });
  data.controller.addEventListener('selectend', () => selectPresses.delete(data));
}

// ---------------------------------------------------------------------------
// Render loop.
// ---------------------------------------------------------------------------
// Isolate each XR subsystem in its own try/catch: a throw in one subsystem
// must NEVER skip renderer.render() — in XR that submits no frame to the
// compositor and the headset shows a permanent BLACK SCREEN. Errors are
// reported to the in-world diagnostics panel (readable in-headset) and the
// console; rendering always continues.
function tryStep(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[animate/${label} threw]`, err);
    reportLoopError(`${label}: ${err && err.message ? err.message : err}`);
  }
}

function animate(timestamp, frame) {
  const dt = Math.min(0.05, (timestamp - (lastTimestamp || timestamp)) / 1000);
  lastTimestamp = timestamp;

  const isPresenting = renderer.xr.isPresenting;
  if (!isPresenting) tryStep('controls', () => controls.update());
  tryStep('cube', () => { cube.rotation.y += 0.005; });

  if (isPresenting) {
    tryStep('gamepads', () => pollGamepads());
    tryStep('locomotion', () => updateLocomotion(dt));
    tryStep('ar', () => updateAR(frame));
    tryStep('menu', () => updateMenu(controllerData, selectPresses));
    tryStep('diagPanel', () => updateDiagnostics());
  }
  tryStep('hover', () => updateHover());
  tryStep('physics', () => updatePhysics(dt));

  if (isPresenting && !loggedFirstXRFrame) {
    loggedFirstXRFrame = true;
    console.log('[WebXR] step 3: first XR-presenting frame rendered');
  }

  // Diagnostics overlay.
  const session = renderer.xr.getSession();
  const features = session && session.enabledFeatures ? session.enabledFeatures.join(',') : 'none';
  const offset = getPlayerOffset();
  const dbgLines = [
    `presenting=${isPresenting} mode=${session ? session.environmentBlendMode : '-'} xr.enabled=${renderer.xr.enabled} feats=${features}`,
    `locomotion=${getLocomotionMode()} player=(${offset.x.toFixed(2)},${offset.z.toFixed(2)})`,
  ];
  for (const data of controllerData) {
    if (!data) continue;
    const rayPos = new THREE.Vector3().setFromMatrixPosition(data.controller.matrixWorld);
    dbgLines.push(
      `c${data.index}: hand=${data.isHand} ray=(${rayPos.x.toFixed(2)},${rayPos.y.toFixed(2)},${rayPos.z.toFixed(2)}) rayVis=${data.rayLine.visible} modelVis=${data.model.visible}`
    );
  }
  setDebugText(dbgLines.join('\n'));
  // Console diag only while presenting — the on-screen overlay covers the
  // desktop preview, and twice-a-second logs there are just spam.
  if (isPresenting && timestamp && timestamp - lastConsoleDiag > 500) {
    lastConsoleDiag = timestamp;
    console.log('[diag]', dbgLines.join(' | '));
  }
}

function safeAnimate(timestamp, frame) {
  try {
    animate(timestamp, frame);
  } catch (err) {
    console.error('[animate threw]', err);
    setDebugText('animate ERROR: ' + (err && err.message ? err.message : err));
    reportLoopError(err && err.message ? err.message : String(err));
  }
  // ABSOLUTE INVARIANT: always submit a frame. A skipped render in XR is a
  // black screen in the headset.
  try {
    renderer.render(scene, camera);
  } catch (err) {
    console.error('[render threw]', err);
    setDebugText('render ERROR: ' + (err && err.message ? err.message : err));
  }
}
renderer.setAnimationLoop(safeAnimate);

init();
