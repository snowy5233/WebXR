// Interactive + grabbable objects and a tiny custom physics step (gravity,
// floor bounce, damping). No physics engine dependency — just enough to make
// grabbable objects feel right and stay cheap on Quest 3.
//
// Interaction model:
//   - "Interactive" objects (the color cube) respond to a trigger press while
//     pointed at (unchanged from v1).
//   - "Grabbable" objects can be held: a trigger press while pointing at one
//     attaches it to the gripping controller; releasing the trigger drops it
//     with the velocity it accumulated while held (throwing).
// Grabs take priority over the interactive-cube action so the bindings never
// conflict.

import * as THREE from 'three';
import { scene } from './scene.js';

const GRAVITY = 9.8;
const FLOOR_RESTITUTION = 0.35;
const FLOOR_FRICTION = 0.85;
const MIN_SLEEP_SPEED = 0.05;

// ---------------------------------------------------------------------------
// The interactive color cube (unchanged behavior from v1).
// ---------------------------------------------------------------------------
const cubeMaterial = new THREE.MeshStandardMaterial({
  color: 0x4488ff,
  roughness: 0.4,
  metalness: 0.1,
  emissive: 0x000000,
});
export const cube = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), cubeMaterial);
cube.position.set(0, 1.0, -1.2);
cube.userData.interactive = true;
scene.add(cube);

const cubePalette = [0x4488ff, 0xff5577, 0x33ddaa, 0xffcc44, 0xaa66ff, 0x66ff88];
let cubePaletteIndex = 0;

export function cycleCubeColor() {
  cubePaletteIndex = (cubePaletteIndex + 1) % cubePalette.length;
  cube.material.color.setHex(cubePalette[cubePaletteIndex]);
  cube.material.emissive.setHex(0x222222);
}

export function endCubeFlash() {
  // Only clear when not hover-highlighted (see setCubeHover).
  if (cube.material.emissive.getHex() === 0x222222) {
    cube.material.emissive.setHex(0x000000);
  }
}

export function setCubeHover(hovering) {
  if (hovering && cube.material.emissive.getHex() === 0x000000) {
    cube.material.emissive.setHex(0x111111);
  } else if (!hovering && cube.material.emissive.getHex() === 0x111111) {
    cube.material.emissive.setHex(0x000000);
  }
}

// ---------------------------------------------------------------------------
// Grabbable objects.
// ---------------------------------------------------------------------------
// Shared geometries + few materials keep draw calls low. Each object is a
// simple rigid body: position, velocity, angular velocity, gravity, floor
// bounce with restitution, and sleep when nearly at rest.
const grabbables = [];
const sharedGeos = {
  box: new THREE.BoxGeometry(0.22, 0.22, 0.22),
  ball: new THREE.SphereGeometry(0.13, 20, 14),
  star: new THREE.IcosahedronGeometry(0.16, 0),
};
const sharedMats = [
  new THREE.MeshStandardMaterial({ color: 0xff8c42, roughness: 0.5 }),
  new THREE.MeshStandardMaterial({ color: 0x53dded, roughness: 0.5 }),
  new THREE.MeshStandardMaterial({ color: 0xc77dff, roughness: 0.5 }),
];

const spawnSpecs = [
  { geo: 'box', mat: 0, pos: [-0.9, 1.2, -1.5] },
  { geo: 'ball', mat: 1, pos: [0.0, 1.5, -2.0] },
  { geo: 'star', mat: 2, pos: [0.9, 1.0, -1.5] },
  { geo: 'box', mat: 1, pos: [-0.5, 0.4, -0.6] },
  { geo: 'ball', mat: 2, pos: [0.5, 0.4, -0.6] },
];

export function initGrabbables() {
  for (const spec of spawnSpecs) {
    const mesh = new THREE.Mesh(sharedGeos[spec.geo], sharedMats[spec.mat]);
    mesh.position.set(...spec.pos);
    mesh.castShadow = false;
    mesh.userData.grabbable = true;
    // Start asleep; gravity wakes them when thrown/dropped.
    mesh.userData.body = {
      velocity: new THREE.Vector3(),
      angular: new THREE.Vector3(),
      halfHeight: 0.13,
      held: null,
      sleeping: true,
    };
    scene.add(mesh);
    grabbables.push(mesh);
  }
}
initGrabbables();

// Everything raycasts can hit for interaction/grab targeting.
export const interactables = [cube, ...grabbables];

// ---------------------------------------------------------------------------
// Grab / release.
// ---------------------------------------------------------------------------
// Attach the object to the controller's grip group with the picked offset
// preserved so it doesn't snap to the grip origin. Track recent poses so the
// release velocity approximates a throw.
const HOLD_HISTORY = 6;

export function tryGrab(grabRoot, raycastHit) {
  const obj = raycastHit && raycastHit.object;
  if (!obj || !obj.userData.grabbable || obj.userData.body.held) return false;
  const body = obj.userData.body;
  // Reparent into the grip space, preserving the world transform at grab time.
  grabRoot.attach(obj);
  body.held = grabRoot;
  body.sleeping = false;
  body.history = [];
  return true;
}

export function releaseGrab(grabRoot) {
  for (const obj of grabbables) {
    const body = obj.userData.body;
    if (body.held !== grabRoot) continue;
    // Compute release velocity from the recent position history.
    const h = body.history;
    if (h.length >= 2) {
      const newest = h[h.length - 1];
      const oldest = h[0];
      const dt = Math.max(0.001, newest.t - oldest.t);
      body.velocity.copy(newest.pos).sub(oldest.pos).divideScalar(dt);
    } else {
      body.velocity.set(0, 0, 0);
    }
    body.angular.set(
      (Math.random() - 0.5) * body.velocity.length() * 0.5,
      (Math.random() - 0.5) * body.velocity.length() * 0.5,
      (Math.random() - 0.5) * body.velocity.length() * 0.5
    );
    scene.attach(obj); // back to world space, world transform preserved
    body.held = null;
  }
}

function updateHoldHistory(obj, now) {
  const body = obj.userData.body;
  const p = obj.getWorldPosition(new THREE.Vector3());
  body.history.push({ pos: p, t: now });
  if (body.history.length > HOLD_HISTORY) body.history.shift();
}

// ---------------------------------------------------------------------------
// Physics step.
// ---------------------------------------------------------------------------
export function updatePhysics(dt) {
  for (const obj of grabbables) {
    const body = obj.userData.body;
    if (body.held) {
      updateHoldHistory(obj, performance.now() / 1000);
      continue;
    }
    if (body.sleeping) continue;
    body.velocity.y -= GRAVITY * dt;
    obj.position.addScaledVector(body.velocity, dt);
    // Rotation while in flight.
    obj.rotation.x += body.angular.x * dt;
    obj.rotation.y += body.angular.y * dt;
    obj.rotation.z += body.angular.z * dt;

    // Floor collision at y = halfHeight.
    if (obj.position.y <= body.halfHeight && body.velocity.y < 0) {
      obj.position.y = body.halfHeight;
      body.velocity.y = -body.velocity.y * FLOOR_RESTITUTION;
      body.velocity.x *= FLOOR_FRICTION;
      body.velocity.z *= FLOOR_FRICTION;
      body.angular.multiplyScalar(0.7);
      // Rest condition: small bounce velocity and slow lateral movement.
      if (Math.abs(body.velocity.y) < MIN_SLEEP_SPEED * 2 &&
          Math.hypot(body.velocity.x, body.velocity.z) < MIN_SLEEP_SPEED) {
        body.velocity.set(0, 0, 0);
        body.angular.set(0, 0, 0);
        body.sleeping = true;
      }
    }
    // Keep objects inside the floor bounds (soft clamp; they bounce at the
    // edges instead of falling off the platform forever).
    const BOUND = 9.7;
    const r = body.halfHeight;
    for (const axis of ['x', 'z']) {
      if (obj.position[axis] > BOUND - r) { obj.position[axis] = BOUND - r; body.velocity[axis] *= -FLOOR_RESTITUTION; }
      if (obj.position[axis] < -BOUND + r) { obj.position[axis] = -BOUND + r; body.velocity[axis] *= -FLOOR_RESTITUTION; }
    }
    // Never fall through: hard floor clamp even after fast frames.
    if (obj.position.y < body.halfHeight) obj.position.y = body.halfHeight;
  }
}

export function anyGrabbedBy(grabRoot) {
  return grabbables.some((o) => o.userData.body.held === grabRoot);
}

// Reset grabbable objects to their spawn state (used on session start/end so
// sessions always begin from a clean layout).
export function resetGrabbables() {
  for (let i = 0; i < grabbables.length; i++) {
    const obj = grabbables[i];
    const spec = spawnSpecs[i];
    obj.position.set(...spec.pos);
    obj.rotation.set(0, 0, 0);
    const body = obj.userData.body;
    body.velocity.set(0, 0, 0);
    body.angular.set(0, 0, 0);
    body.held = null;
    body.sleeping = true;
    scene.attach(obj);
  }
}
