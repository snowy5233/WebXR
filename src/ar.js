// Immersive-AR passthrough mode for Quest 3: the camera feed replaces the
// skybox/floor, and a reticle lets the user tap the trigger to place a
// floating marker via the 'hit-test' feature.
//
// Session differences vs VR (handled in main.js):
//   - requestSession('immersive-ar', { requiredFeatures: ['hit-test'], ... })
//   - scene.background must be null (transparent) so the camera feed shows
//   - the skybox/floor/grid/pedestals are hidden; a "placement" reticle is
//     shown instead
// Locomotion stays available (teleport targets the invisible floor plane).

import * as THREE from 'three';
import { renderer, scene, floor, sky, grid, pedestals } from './scene.js';

let defaultBackground = null;
export function captureDefaultBackground() {
  defaultBackground = scene.background;
}

let hitTestSource = null;
let hitTestSourceRequest = null;
let reticle = null;
let placedMarkers = [];

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
    return;
  }
  const refSpace = renderer.xr.getReferenceSpace();
  const results = frame.getHitTestResults(hitTestSource);
  if (results.length > 0) {
    const pose = results[0].getPose(refSpace);
    if (pose) {
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
    }
  } else {
    reticle.visible = false;
  }
}

export function placeMarker() {
  if (!reticle || !reticle.visible) return;
  const pos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
  const marker = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.3, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x53dded, roughness: 0.5 })
  );
  marker.position.copy(pos).add(new THREE.Vector3(0, 0.15, 0));
  scene.add(marker);
  placedMarkers.push(marker);
}

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
  for (const m of placedMarkers) scene.remove(m);
  placedMarkers = [];
  // Restore the VR environment (background must go back to opaque, or the
  // desktop preview renders on transparent black after an AR session).
  scene.background = defaultBackground;
  sky.visible = true;
  floor.visible = true;
  grid.visible = true;
  for (const p of pedestals) p.visible = true;
}

export function isARActive() {
  const session = renderer.xr.getSession();
  return !!(session && session.environmentBlendMode !== 'opaque');
}
