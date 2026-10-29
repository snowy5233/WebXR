// Immersive-AR passthrough for Quest 3 (the app is AR-only): the camera feed
// replaces the skybox/floor, a reticle previews where the trigger will place
// a part, the menu chooses the shape, and the grip button picks up and moves
// already-placed parts.
//
// Session features: requiredFeatures ['hit-test', 'local-floor'],
// optionalFeatures ['hand-tracking', 'dom-overlay'].
//
// Teleportation was removed with the VR mode; smooth locomotion (thumbstick)
// remains available via src/locomotion.js.

import * as THREE from 'three';
import { renderer, scene, floor, sky, grid, pedestals } from './scene.js';

let hitTestSource = null;
let hitTestSourceRequest = null;
let reticle = null;
let markerGeo = null;
let previewMesh = null;
let placedParts = [];
let defaultBackground = null;

// ---------------------------------------------------------------------------
// Shape catalogue for placed parts. Shared geometries/materials keep draw
// calls minimal; the menu cycles SHAPES[*].id.
// ---------------------------------------------------------------------------
export const SHAPES = [
  { id: 'box', label: 'Box', make: () => new THREE.BoxGeometry(0.3, 0.3, 0.3), half: 0.15 },
  { id: 'ball', label: 'Ball', make: () => new THREE.SphereGeometry(0.15, 24, 16), half: 0.15 },
  { id: 'star', label: 'Star', make: () => new THREE.IcosahedronGeometry(0.18, 0), half: 0.15 },
  { id: 'pillar', label: 'Pillar', make: () => new THREE.CylinderGeometry(0.1, 0.1, 0.6, 12), half: 0.3 },
];
let shapeIndex = 0;
const shapeGeos = new Map();
const partMaterials = [
  new THREE.MeshStandardMaterial({ color: 0x53dded, roughness: 0.5 }),
  new THREE.MeshStandardMaterial({ color: 0xff8c42, roughness: 0.5 }),
  new THREE.MeshStandardMaterial({ color: 0xc77dff, roughness: 0.5 }),
];

export function getShapeIndex() { return shapeIndex; }
export function cycleShape() {
  shapeIndex = (shapeIndex + 1) % SHAPES.length;
  return SHAPES[shapeIndex];
}
export function getShapeLabel() { return SHAPES[shapeIndex].label; }

function shapeGeometry() {
  const id = SHAPES[shapeIndex].id;
  if (!shapeGeos.has(id)) shapeGeos.set(id, SHAPES[shapeIndex].make());
  return shapeGeos.get(id);
}

// ---------------------------------------------------------------------------
// Hit-test reticle + placement preview.
// ---------------------------------------------------------------------------
export function initAR() {
  if (!reticle) {
    reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.08, 0.12, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x66ffaa })
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
  }
  return reticle;
}

export function captureDefaultBackground() {
  defaultBackground = scene.background;
}

export async function startARHitTest(session) {
  try {
    const viewerSpace = await session.requestReferenceSpace('viewer');
    hitTestSourceRequest = session.requestHitTestSource({ space: viewerSpace });
    hitTestSourceRequest
      .then((source) => { hitTestSource = source; })
      .catch((err) => console.warn('[AR] hit test source failed:', err));
  } catch (err) {
    // Not fatal: AR still works, just without the placement reticle.
    console.warn('[AR] hit-test setup failed:', err);
  }
}

export function stopARHitTest() {
  if (hitTestSource) {
    hitTestSource.cancel();
    hitTestSource = null;
  }
  hitTestSourceRequest = null;
}

export function updateAR(frame) {
  if (!reticle) return;
  if (!hitTestSource) {
    reticle.visible = false;
    if (previewMesh) previewMesh.visible = false;
    return;
  }
  const refSpace = renderer.xr.getReferenceSpace();
  const results = frame.getHitTestResults(hitTestSource);
  if (results.length > 0) {
    const pose = results[0].getPose(refSpace);
    if (pose) {
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
      // Placement preview: a translucent ghost of the current shape follows
      // the reticle so you see exactly where the part will land before
      // pulling the trigger.
      if (!previewMesh) {
        previewMesh = new THREE.Group();
        scene.add(previewMesh);
      }
      if (previewMesh.children.length === 0 || previewMesh.userData.shapeId !== SHAPES[shapeIndex].id) {
        // Rebuild the ghost only when the selected shape changes.
        previewMesh.clear();
        const ghost = new THREE.Mesh(
          shapeGeometry(),
          new THREE.MeshBasicMaterial({
            color: 0x53dded,
            transparent: true,
            opacity: 0.4,
            depthWrite: false,
          })
        );
        previewMesh.add(ghost);
        previewMesh.userData.shapeId = SHAPES[shapeIndex].id;
      }
      previewMesh.visible = true;
      previewMesh.position.setFromMatrixPosition(reticle.matrix);
      previewMesh.position.y += SHAPES[shapeIndex].half;
    }
  } else {
    reticle.visible = false;
    if (previewMesh) previewMesh.visible = false;
  }
}

// ---------------------------------------------------------------------------
// Placing parts (trigger).
// ---------------------------------------------------------------------------
export function placePart() {
  if (!reticle || !reticle.visible) return null;
  const pos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
  const shape = SHAPES[shapeIndex];
  const part = new THREE.Mesh(
    shapeGeometry(),
    partMaterials[placedParts.length % partMaterials.length]
  );
  part.userData.movable = true;
  part.userData.half = shape.half;
  part.position.copy(pos);
  part.position.y += shape.half;
  scene.add(part);
  placedParts.push(part);
  return part;
}

// ---------------------------------------------------------------------------
// Moving parts (grip). The squeeze events route through here:
//   gripStart(root) — attach the ray-hit part to the given grab root
//                     (controller grip group, or the ray controller for hands)
//   gripEnd(root)   — detach, leaving the part where it was released
// ---------------------------------------------------------------------------
// Placed parts, for raycast targeting (controllers.js).
export function placedTargets() { return placedParts; }

export function gripStart(grabRoot, hit) {
  const part = hit && hit.object;
  if (!part || !part.userData.movable || part.userData.held) return false;
  grabRoot.attach(part);
  part.userData.held = grabRoot;
  return true;
}

export function gripEnd(grabRoot) {
  for (const part of placedParts) {
    if (part.userData.held === grabRoot) {
      scene.attach(part);
      part.userData.held = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Session environment transitions.
// ---------------------------------------------------------------------------
export function enterARVisuals() {
  scene.background = null; // transparent so the passthrough camera shows
  sky.visible = false;
  floor.visible = false;
  grid.visible = false;
  for (const p of pedestals) p.visible = false;
  if (!reticle) initAR();
  if (!reticle.parent) scene.add(reticle);
}

export function exitARVisuals() {
  stopARHitTest();
  if (reticle) reticle.visible = false;
  if (previewMesh) previewMesh.visible = false;
  for (const p of placedParts) scene.remove(p);
  placedParts = [];
  // Restore the flat-preview environment (background must go back to opaque,
  // or the desktop preview renders on transparent black after an AR session).
  scene.background = defaultBackground;
  sky.visible = true;
  floor.visible = true;
  grid.visible = true;
  for (const p of pedestals) p.visible = true;
}

// Remove all placed parts (menu "Clear parts").
export function clearParts() {
  for (const p of placedParts) scene.remove(p);
  placedParts = [];
}

export function isARActive() {
  const session = renderer.xr.getSession();
  return !!(session && session.environmentBlendMode !== 'opaque');
}
