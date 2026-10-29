// Controller setup, ray-casting, and input dispatch.
//
// Input bindings (deliberately distinct so nothing conflicts):
//   trigger ('select')  -> place a part at the reticle (AR placement)
//   grip ('squeeze')    -> pick up / move a placed part; release drops it
//   thumbstick          -> smooth locomotion (the only mode; teleport removed)
//   A/X (button 2, R)    -> open/close the in-headset menu
//   B/Y (button 3, R)   -> cycle the placement shape
//
// Hands: when a hand input source appears, the controller model is hidden and
// a hand mesh (see hands.js) is shown instead. Hands support the same
// select/grab bindings (pinch = select via the hand's target ray).

import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { renderer, scene } from './scene.js';
import { placedTargets } from './ar.js';

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

  controller.addEventListener('squeezestart', () => onSqueezeStart(data));
  controller.addEventListener('squeezeend', () => onSqueezeEnd(data));

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
  const intersects = raycaster.intersectObjects(interactables.concat(placedTargets()), false);
  return intersects.length > 0 ? intersects[0] : null;
}

// ---------------------------------------------------------------------------
// Squeeze (grip): pick up a placed part under the ray; release drops it.
// Hands have a null gripSpace, so hands grab via the target-ray controller
// object instead (see grabRootFor).
// ---------------------------------------------------------------------------
export const squeezeCallbacks = { onSqueezeStart: null, onSqueezeEnd: null };
function onSqueezeStart(data) {
  if (squeezeCallbacks.onSqueezeStart) squeezeCallbacks.onSqueezeStart(data);
}
function onSqueezeEnd(data) {
  if (squeezeCallbacks.onSqueezeEnd) squeezeCallbacks.onSqueezeEnd(data);
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
// Per-frame hover highlight for movable parts under the rays.
// ---------------------------------------------------------------------------
export function updateHover() {
  for (const data of controllerData) {
    if (!data || !data.rayLine.visible) continue;
    const hit = raycastFromController(data);
    const target = hit && hit.object;
    if (target && target.userData.movable && !target.userData.held) {
      // Highlight grabbable parts via emissive so users know grip applies.
      if (!target.userData.baseEmissive) {
        target.userData.baseEmissive = target.material.emissive ? target.material.emissive.getHex() : 0;
        if (target.material.emissive) target.material.emissive.setHex(0x113344);
      }
    } else if (target && target.userData.baseEmissive && !target.userData.held) {
      if (target.material.emissive) target.material.emissive.setHex(target.userData.baseEmissive);
      target.userData.baseEmissive = null;
    }
  }
}
