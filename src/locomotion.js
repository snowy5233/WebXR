// Locomotion: teleport (parabolic arc + confirm with grip) and smooth
// (thumbstick, head-relative, with comfort vignette), switchable at runtime.
//
// ARCHITECTURE (unchanged from v1, preserved deliberately): locomotion never
// touches the camera or scene-root objects. The headset pose is written to
// the camera every frame by WebXRManager; we instead move the player by
// changing the reference space the XR poses resolve against: a base
// local-floor space is captured at session start, and locomotion installs
// offset reference spaces derived from it via
// baseSpace.getOffsetReferenceSpace(transform). Head tracking stays fully
// intact on top of the offset.

import * as THREE from 'three';
import { renderer, camera, scene, floor } from './scene.js';
import { controllerData, gamepadState } from './controllers.js';

const LOCOMOTION_TELEPORT = 'teleport';
const LOCOMOTION_SMOOTH = 'smooth';
export { LOCOMOTION_TELEPORT, LOCOMOTION_SMOOTH };

let locomotionMode = LOCOMOTION_TELEPORT;
export function getLocomotionMode() { return locomotionMode; }
export function setLocomotionMode(mode) {
  if (mode !== LOCOMOTION_TELEPORT && mode !== LOCOMOTION_SMOOTH) return;
  locomotionMode = mode;
}

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

const SMOOTH_SPEED = 1.6;
let vignetteIntensity = 0;
let playerOffsetX = 0;
let playerOffsetZ = 0;

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

// ---------------------------------------------------------------------------
// Teleport visuals.
// ---------------------------------------------------------------------------
const teleportRaycaster = new THREE.Raycaster();
const teleportSurfaces = [floor];
// NOTE: plain BufferGeometry has no setPositions() (that's LineGeometry) — v1
// called it and would have thrown on the first aim. Preallocate a max-size
// position attribute and update it per frame via setAttribute/copyInto instead.
const teleportArcGeo = new THREE.BufferGeometry();
teleportArcGeo.setAttribute(
  'position',
  new THREE.BufferAttribute(new Float32Array((ARC_SEGMENTS + 1) * 3), 3)
);
const teleportArc = new THREE.Line(
  teleportArcGeo,
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

const _teleportOrigin = new THREE.Vector3();
const _teleportDir = new THREE.Vector3();
const _teleportHit = new THREE.Vector3();
const _tmpMat4 = new THREE.Matrix4();
const _tmpVec3 = new THREE.Vector3();
const _moveVec = new THREE.Vector3();
const _headForward = new THREE.Vector3();

const ARC_SEGMENTS = 24;
const arcPoints = [];
for (let i = 0; i <= ARC_SEGMENTS; i++) arcPoints.push(new THREE.Vector3());

// ---------------------------------------------------------------------------
// Offset reference-space management.
// ---------------------------------------------------------------------------
function applyLocomotionOffset(x, z) {
  if (!baseReferenceSpace) return;
  // XRRigidTransform is a native WebXR global. We only translate on the floor
  // plane; orientation stays identity (no snap-turn in v2).
  const t = new XRRigidTransform(
    { x: x, y: 0, z: z, w: 1 },
    { x: 0, y: 0, z: 0, w: 1 }
  );
  const offsetSpace = baseReferenceSpace.getOffsetReferenceSpace(t);
  renderer.xr.setReferenceSpace(offsetSpace);
}

function teleportTo(targetX, targetZ) {
  if (!baseReferenceSpace) return;
  // Head base-space position = camera world pos - tracked player offset.
  camera.getWorldPosition(_tmpVec3);
  const headBaseX = _tmpVec3.x - playerOffsetX;
  const headBaseZ = _tmpVec3.z - playerOffsetZ;
  playerOffsetX = playerOffsetX + (targetX - headBaseX);
  playerOffsetZ = playerOffsetZ + (targetZ - headBaseZ);
  applyLocomotionOffset(playerOffsetX, playerOffsetZ);
}

function updateTeleportAim(data) {
  _tmpMat4.identity().extractRotation(data.controller.matrixWorld);
  _teleportOrigin.setFromMatrixPosition(data.controller.matrixWorld);
  _teleportDir.set(0, 0, -1).applyMatrix4(_tmpMat4);

  const speed = 6;
  const gravity = 9.8;
  let hitPoint = null;
  let hitDist = 0;
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
  const posAttr = teleportArc.geometry.getAttribute('position');
  const count = hitDist + 2; // sampled points up to the hit + the hit itself
  for (let i = 0; i <= hitDist; i++) {
    posAttr.setXYZ(i, arcPoints[i].x, arcPoints[i].y, arcPoints[i].z);
  }
  posAttr.setXYZ(hitDist + 1, hitPoint.x, hitPoint.y, hitPoint.z);
  posAttr.needsUpdate = true;
  teleportArc.geometry.setDrawRange(0, count);
  teleportArc.visible = true;
  teleportRing.position.set(hitPoint.x, 0.01, hitPoint.z);
  teleportRing.visible = true;
  return hitPoint;
}

export function updateLocomotion(dt) {
  if (vignette.parent !== camera) {
    camera.add(vignette);
  }

  if (locomotionMode === LOCOMOTION_TELEPORT) {
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
    vignetteIntensity = 0;
  } else if (locomotionMode === LOCOMOTION_SMOOTH) {
    teleportArc.visible = false;
    teleportRing.visible = false;
    _moveVec.set(0, 0, 0);
    let moving = false;
    for (const gp of gamepadState) {
      if (!gp || !gp.axes) continue;
      const ax = gp.axes.length >= 4 ? gp.axes[2] : (gp.axes[0] || 0);
      const ay = gp.axes.length >= 4 ? gp.axes[3] : (gp.axes[1] || 0);
      if (Math.abs(ax) > 0.15 || Math.abs(ay) > 0.15) {
        _moveVec.x += ax;
        _moveVec.z += ay;
        moving = true;
      }
    }
    if (moving && baseReferenceSpace) {
      _headForward.set(0, 0, -1).applyQuaternion(camera.quaternion);
      _headForward.y = 0;
      _headForward.normalize();
      const right = _tmpMat4.makeRotationY(-Math.PI / 2);
      const headRight = _headForward.clone().applyMatrix4(right).normalize();
      const forwardAmt = -_moveVec.z;
      const strafeAmt = _moveVec.x;
      const dx = _headForward.x * forwardAmt + headRight.x * strafeAmt;
      const dz = _headForward.z * forwardAmt + headRight.z * strafeAmt;
      const len = Math.hypot(dx, dz);
      if (len > 0) {
        const step = SMOOTH_SPEED * dt;
        playerOffsetX += (dx / len) * step * Math.min(1, len);
        playerOffsetZ += (dz / len) * step * Math.min(1, len);
        applyLocomotionOffset(playerOffsetX, playerOffsetZ);
        vignetteIntensity = 1;
      }
    } else {
      vignetteIntensity = 0;
    }
  }

  const target = vignetteIntensity;
  vignette.material.opacity += (target - vignette.material.opacity) * Math.min(1, dt * 8);
  vignette.visible = vignette.material.opacity > 0.01;
}

// Called by controllers.js squeeze dispatch: confirm teleport with grip.
export function handleSqueeze(data) {
  if (locomotionMode !== LOCOMOTION_TELEPORT) return;
  const p = updateTeleportAim(data);
  if (p) teleportTo(p.x, p.z);
}

export function resetLocomotionVisuals() {
  teleportArc.visible = false;
  teleportRing.visible = false;
  vignette.visible = false;
  vignette.material.opacity = 0;
}
