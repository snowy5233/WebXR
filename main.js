// Bootstrap + WebXR session lifecycle (AR-only).
//
// This is the part that is easy to get subtly wrong, so it is spelled out
// step by step. We use navigator.xr directly for capability checks and
// session creation, then hand the session to Three.js's renderer.xr manager
// so it can apply the headset pose and projection each frame.
//
// Session features: requiredFeatures ['hit-test', 'local-floor'],
// optionalFeatures ['hand-tracking', 'dom-overlay'].
//
// Input map (AR-only app):
//   trigger -> place a part at the reticle (shape chosen in the menu)
//   grip    -> pick up / move a placed part; release drops it
//   thumbstick -> smooth locomotion
//   A/X     -> open/close the menu (Shape / Clear parts / Exit AR)
//   B/Y     -> cycle placement shape

import * as THREE from 'three';
import { renderer, scene, camera, controls } from './src/scene.js';
import { installGlobalErrorHandlers, setDebugText } from './src/debug.js';
import { showDiagnostics, hideDiagnostics, updateDiagnostics, reportLoopError } from './src/diagnostics.js';
import { controllerData, pollGamepads, inputCallbacks, raycastFromController } from './src/controllers.js';
import { setupHands } from './src/hands.js';
import { updateLocomotion, captureBaseReferenceSpace, clearBaseReferenceSpace, resetLocomotionVisuals, getPlayerOffset } from './src/locomotion.js';
import { toggleMenu, closeMenu, updateMenu } from './src/menu.js';
import { startARHitTest, updateAR, placePart, gripStart, gripEnd, cycleShape, enterARVisuals, exitARVisuals, captureDefaultBackground } from './src/ar.js';

installGlobalErrorHandlers();
setupHands();
captureDefaultBackground();

const overlay = document.getElementById('overlay');
const statusMessage = document.getElementById('status-message');
const buttonContainer = document.getElementById('vr-button-container');

let currentSession = null;
let lastTimestamp = 0;
let lastConsoleDiag = 0;
let loggedFirstXRFrame = false;
// Controller slots whose trigger was pressed this frame (for menu clicks).
const selectPresses = new Set();
// Parts currently held via grip, by grab root — guards the AR-placement
// path so a trigger while holding a part doesn't also place one.
const heldParts = new Map();

function setStatus(text) {
  statusMessage.textContent = text;
}

function makeButton(id, text, onClick) {
  const btn = document.createElement('button');
  btn.id = id;
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

// ---------------------------------------------------------------------------
// Capability check + overlay button (AR only).
// ---------------------------------------------------------------------------
async function init() {
  if (!('xr' in navigator)) {
    setStatus('WebXR is not supported in this browser. Showing a flat 3D preview. Try the Meta Quest 3 browser over HTTPS.');
    return;
  }
  try {
    let arSupported = false;
    try { arSupported = await navigator.xr.isSessionSupported('immersive-ar'); } catch (_) {}
    buttonContainer.innerHTML = '';
    if (arSupported) {
      buttonContainer.appendChild(makeButton('enter-ar-btn', 'Enter AR', () => startSession()));
      setStatus('Ready. Put on your headset and press Enter AR.');
    } else {
      setStatus('Immersive AR is not supported on this device. Showing a flat 3D preview.');
    }
  } catch (error) {
    setStatus('Could not query WebXR support: ' + error.message);
  }
}

// ---------------------------------------------------------------------------
// Session start/end with per-step timeouts (a silent hang is the worst UX).
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

async function startSession() {
  if (currentSession) return;
  console.log('[WebXR] step 1: requestSession start (immersive-ar)');
  let session;
  try {
    session = await withTimeout(
      navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test', 'local-floor'],
        optionalFeatures: ['hand-tracking', 'dom-overlay'],
        domOverlay: { root: overlay },
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

async function onSessionStarted(session) {
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

  // AR passthrough: transparent background, hide the flat-preview
  // environment, start hit-testing for the placement reticle.
  enterARVisuals();
  startARHitTest(session);

  overlay.classList.add('hidden');
  // In-world status panel: shows session state, and crucially any per-frame
  // error, readable INSIDE the headset (the DOM overlay is invisible there).
  showDiagnostics('AR ready. Trigger places; grip moves parts; A/X menu.');
  setStatus('In AR. Trigger places a part at the reticle; grip moves placed parts.');
}

function onSessionEnded() {
  const session = currentSession;
  if (session) session.removeEventListener('end', onSessionEnded);
  currentSession = null;
  renderer.xr.setSession(null);
  renderer.xr.setReferenceSpace(null);
  clearBaseReferenceSpace();
  resetLocomotionVisuals();
  closeMenu();
  exitARVisuals();
  hideDiagnostics();
  heldParts.clear();
  controls.enabled = true;
  controls.update();
  loggedFirstXRFrame = false;
  overlay.classList.remove('hidden');
  setStatus('Exited AR. Press Enter AR to re-enter.');
}

// ---------------------------------------------------------------------------
// In-headset input wiring.
// ---------------------------------------------------------------------------
inputCallbacks.onAButton = () => toggleMenu();
inputCallbacks.onBButton = () => cycleShape();

// Grip: pick up a placed part under the ray; release drops it. Hands have a
// null gripSpace so they use the ray controller object as the grab root.
for (const data of controllerData) {
  if (!data) continue;
  data.controller.addEventListener('selectstart', () => {
    selectPresses.add(data);
    // Trigger places a part only when not currently holding one via grip.
    if (!heldParts.has(data.controllerGrip) && !heldParts.has(data.controller)) {
      const hit = raycastFromController(data);
      if (!hit || !hit.object.userData.movable) placePart();
    }
  });
  data.controller.addEventListener('selectend', () => selectPresses.delete(data));
  data.controller.addEventListener('squeezestart', () => {
    const hit = raycastFromController(data);
    const root = data.isHand ? data.controller : data.controllerGrip;
    if (hit && gripStart(root, hit)) heldParts.set(root, data);
  });
  data.controller.addEventListener('squeezeend', () => {
    const root = data.isHand ? data.controller : data.controllerGrip;
    if (heldParts.has(root)) {
      gripEnd(root);
      heldParts.delete(root);
    }
  });
}

// ---------------------------------------------------------------------------
// Render loop.
// ---------------------------------------------------------------------------
// Isolate each subsystem in its own try/catch: a throw in one subsystem must
// NEVER skip renderer.render() — in XR that submits no frame to the
// compositor and the headset shows a permanent BLACK SCREEN. Errors go to the
// in-world diagnostics panel (readable in-headset); rendering always continues.
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

  if (isPresenting) {
    tryStep('gamepads', () => pollGamepads());
    tryStep('locomotion', () => updateLocomotion(dt));
    tryStep('ar', () => updateAR(frame));
    tryStep('menu', () => updateMenu(controllerData, selectPresses));
    tryStep('diagPanel', () => updateDiagnostics());
  }

  if (isPresenting && !loggedFirstXRFrame) {
    loggedFirstXRFrame = true;
    console.log('[WebXR] step 3: first XR-presenting frame rendered');
  }

  const session = renderer.xr.getSession();
  const features = session && session.enabledFeatures ? session.enabledFeatures.join(',') : 'none';
  const offset = getPlayerOffset();
  const dbgLines = [
    `presenting=${isPresenting} mode=${session ? session.environmentBlendMode : '-'} xr.enabled=${renderer.xr.enabled} feats=${features}`,
    `player=(${offset.x.toFixed(2)},${offset.z.toFixed(2)})`,
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
