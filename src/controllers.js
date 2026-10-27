// Controller setup, ray-casting, and input dispatch.
//
// Input bindings (deliberately distinct so nothing conflicts):
//   trigger ('select')  -> grab a grabbable under the ray, else cycle the
//                          interactive cube's color
//   release trigger     -> drop held object (with throw velocity)
//   grip ('squeeze')    -> confirm teleport (teleport mode only)
//   thumbstick          -> smooth locomotion
//   A/X (button 2, R)    -> open/close the in-VR menu (was locomotion toggle;
//                          locomotion now lives in the menu)
//   B/Y (button 3, R)   -> teleport/smooth quick toggle
//
// Hands: when a hand input source appears, the controller model is hidden and
// a hand mesh (see hands.js) is shown instead. Hands support the same
// select/grab bindings (pinch = select via the hand's target ray).

import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { renderer, scene } from './scene.js';
import { interactables, cube, cycleCubeColor, endCubeFlash, setCubeHover, tryGrab, releaseGrab } from './objects.js';

const controllerModelFactory = new XRControllerModelFactory();
export const controllerData = [];
const raycaster = new THREE.Raycaster();

// Callbacks wired by main.js / locomotion / menu to avoid hard coupling.
export const inputCallbacks = {
  onAButton: null,    // right controller A/X rising edge
  onBButton: null,    // right controller B/Y rising edge
};

function setupController(index) {
  const controller = renderer.xr.getController(index);
  const controllerGrip = renderer.xr.getControllerGrip(index);

  const model = controllerModelFactory.createControllerModel(controllerGrip);
  controllerGrip.add(model);
  scene.add(controllerGrip);

  const rayGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1),
  ]);
  const rayLine = new THREE.Line(
    rayGeometry,
    new THREE.LineBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.7 })
  );
  rayLine.scale.z = 5;
  rayLine.visible = false;
  controller.add(rayLine);
  scene.add(controller);

  const data = { controller, controllerGrip, rayLine, model, index, handMesh: null, isHand: false };
  controllerData[index] = data;

  controller.addEventListener('selectstart', () => onSelectStart(data));
  controller.addEventListener('selectend', () => onSelectEnd(data));
  controller.addEventListener('squeezestart', () => onSqueezeStart(data));

  // Hide the vendor controller model for hand input sources (gripSpace is
  // null for hands — the exact v1 bug the README warns about — and the model
  // would otherwise freeze at the grip origin). hands.js attaches the mesh.
  controller.addEventListener('connected', (event) => {
    const src = event.data;
    data.isHand = !!(src && src.hand);
    if (data.isHand) {
      model.visible = false;
    } else {
      model.visible = true;
      data.rayLine.visible = true;
    }
  });
  controller.addEventListener('disconnected', () => {
    data.rayLine.visible = false;
    data.isHand = false;
  });
}

setupController(0);
setupController(1);

// ---------------------------------------------------------------------------
// Ray-casting helpers.
// ---------------------------------------------------------------------------
const _rayMat4 = new THREE.Matrix4();

export function raycastFromController(data) {
  _rayMat4.identity().extractRotation(data.controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(data.controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_rayMat4);
  const intersects = raycaster.intersectObjects(interactables, false);
  return intersects.length > 0 ? intersects[0] : null;
}

// ---------------------------------------------------------------------------
// Trigger handlers: grab takes priority, else the interactive cube.
// ---------------------------------------------------------------------------
// The grab root differs by input type: controllers have a tracked grip
// pose, but HAND input sources have a null gripSpace (their grip group never
// updates), so hands must grab via the target-ray controller object instead —
// otherwise held objects would freeze at the stale grip transform.
function grabRootFor(data) {
  return data.isHand ? data.controller : data.controllerGrip;
}

function onSelectStart(data) {
  const hit = raycastFromController(data);
  if (hit && tryGrab(grabRootFor(data), hit)) return;
  if (hit && hit.object === cube) cycleCubeColor();
}

function onSelectEnd(data) {
  releaseGrab(grabRootFor(data));
  endCubeFlash();
}

// ---------------------------------------------------------------------------
// Squeeze (grip): forwarded to locomotion for teleport confirmation.
// ---------------------------------------------------------------------------
export const squeezeCallbacks = { onSqueeze: null };
function onSqueezeStart(data) {
  if (squeezeCallbacks.onSqueeze) squeezeCallbacks.onSqueeze(data);
}

// ---------------------------------------------------------------------------
// Gamepad polling: thumbsticks for smooth locomotion + A/B button edges.
// ---------------------------------------------------------------------------
export const gamepadState = [null, null];
let aWasDown = false;
let bWasDown = false;

export function pollGamepads() {
  const session = renderer.xr.getSession();
  if (!session) return;
  gamepadState[0] = null;
  gamepadState[1] = null;
  let aDown = false;
  let bDown = false;
  for (const src of session.inputSources) {
    if (!src.gamepad) continue;
    const idx = src.handedness === 'right' ? 0 : 1;
    gamepadState[idx] = src.gamepad;
    if (src.handedness === 'right') {
      // Quest Touch button indices: 2 = A/X, 3 = B/Y.
      if (src.gamepad.buttons.length > 2 && src.gamepad.buttons[2].pressed) aDown = true;
      if (src.gamepad.buttons.length > 3 && src.gamepad.buttons[3].pressed) bDown = true;
    }
  }
  if (aDown && !aWasDown && inputCallbacks.onAButton) inputCallbacks.onAButton();
  if (bDown && !bWasDown && inputCallbacks.onBButton) inputCallbacks.onBButton();
  aWasDown = aDown;
  bWasDown = bDown;
}

// ---------------------------------------------------------------------------
// Per-frame hover highlight for the interactive cube.
// ---------------------------------------------------------------------------
export function updateHover() {
  let hovering = false;
  for (const data of controllerData) {
    if (data && data.rayLine.visible) {
      const hit = raycastFromController(data);
      if (hit && hit.object === cube) { hovering = true; break; }
    }
  }
  setCubeHover(hovering);
}
