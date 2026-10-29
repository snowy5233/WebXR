// Smooth locomotion (thumbstick, head-relative, with comfort vignette).
// Teleport was removed when the app went AR-only — in passthrough there is no
// bounded virtual floor worth arc-aiming at, and grip was reclaimed for
// moving placed parts.
//
// ARCHITECTURE (preserved from v1/v2): locomotion never touches the camera or
// scene-root objects. The headset pose is written to the camera every frame
// by WebXRManager; we instead move the player by changing the reference space
// the XR poses resolve against: a base local-floor space is captured at
// session start, and locomotion installs offset reference spaces derived from
// it via baseSpace.getOffsetReferenceSpace(transform). Head tracking stays
// fully intact on top of the offset.
//
// SIGN CONVENTION (bit us once — keep documented): Three.js renders the head
// at trueHeadBase - offsetTranslation, so to move the rendered head in +d the
// offset must DECREASE by d.

import * as THREE from 'three';
import { renderer, camera, scene } from './scene.js';
import { gamepadState } from './controllers.js';

const LOCOMOTION_SMOOTH = 'smooth';
export { LOCOMOTION_SMOOTH };

const SMOOTH_SPEED = 1.6;
let playerOffsetX = 0;
let playerOffsetZ = 0;

let baseReferenceSpace = null;
export function captureBaseReferenceSpace() {
  baseReferenceSpace = renderer.xr.getReferenceSpace();
  playerOffsetX = 0;
  playerOffsetZ = 0;
}
export function clearBaseReferenceSpace() {
  baseReferenceSpace = null;
  playerOffsetX = 0;
  playerOffsetZ = 0;
}

export function getPlayerOffset() {
  return { x: playerOffsetX, z: playerOffsetZ };
}

// ---------------------------------------------------------------------------
// Comfort vignette (canvas radial-gradient plane parented to the camera).
// ---------------------------------------------------------------------------
function createVignette() {
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
  mesh.position.set(0, 0, -1);
  mesh.visible = false;
  return mesh;
}
const vignette = createVignette();

const _tmpMat4 = new THREE.Matrix4();
const _headForward = new THREE.Vector3();

function applyLocomotionOffset(x, z) {
  if (!baseReferenceSpace) return;
  const t = new XRRigidTransform(
    { x: x, y: 0, z: z, w: 1 },
    { x: 0, y: 0, z: 0, w: 1 }
  );
  const offsetSpace = baseReferenceSpace.getOffsetReferenceSpace(t);
  renderer.xr.setReferenceSpace(offsetSpace);
}

export function updateLocomotion(dt) {
  if (vignette.parent !== camera) {
    camera.add(vignette);
  }

  let vignetteIntensity = 0;
  const moveX = { v: 0 }, moveZ = { v: 0 };
  let moving = false;
  for (const gp of gamepadState) {
    if (!gp || !gp.axes) continue;
    const ax = gp.axes.length >= 4 ? gp.axes[2] : (gp.axes[0] || 0);
    const ay = gp.axes.length >= 4 ? gp.axes[3] : (gp.axes[1] || 0);
    if (Math.abs(ax) > 0.15 || Math.abs(ay) > 0.15) {
      moveX.v += ax;
      moveZ.v += ay;
      moving = true;
    }
  }
  if (moving && baseReferenceSpace) {
    _headForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _headForward.y = 0;
    _headForward.normalize();
    const right = _tmpMat4.makeRotationY(-Math.PI / 2);
    const headRight = _headForward.clone().applyMatrix4(right).normalize();
    const forwardAmt = -moveZ.v;
    const strafeAmt = moveX.v;
    const dx = _headForward.x * forwardAmt + headRight.x * strafeAmt;
    const dz = _headForward.z * forwardAmt + headRight.z * strafeAmt;
    const len = Math.hypot(dx, dz);
    if (len > 0) {
      const step = SMOOTH_SPEED * dt;
      // Subtract, not add: renderedHead = trueHead - offset (see header).
      playerOffsetX -= (dx / len) * step * Math.min(1, len);
      playerOffsetZ -= (dz / len) * step * Math.min(1, len);
      applyLocomotionOffset(playerOffsetX, playerOffsetZ);
      vignetteIntensity = 1;
    }
  }

  vignette.material.opacity += (vignetteIntensity - vignette.material.opacity) * Math.min(1, dt * 8);
  vignette.visible = vignette.material.opacity > 0.01;
}

export function resetLocomotionVisuals() {
  vignette.visible = false;
  vignette.material.opacity = 0;
}
