// Scene, renderer, camera, lights, and the procedural environment.
// A single WebGLRenderer drives the desktop preview and every XR session
// (VR and AR). `xrCompatible: true` is required so the GL context can be
// adopted by an immersive XRSession.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const renderer = new THREE.WebGLRenderer({ antialias: true, xrCompatible: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// IMPORTANT: enable WebXR rendering. WebXRManager.enabled defaults to false;
// without it render() keeps using the flat desktop camera even while
// presenting, so head tracking does nothing. Must be set before presenting.
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

export const scene = new THREE.Scene();

// Gradient skybox: a procedurally-generated canvas gradient on an inverted
// sphere. No texture downloads, one extra draw call.
const skyCanvas = document.createElement('canvas');
skyCanvas.width = 16;
skyCanvas.height = 256;
{
  const ctx = skyCanvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#3a5a8c');
  grad.addColorStop(0.5, '#1a2334');
  grad.addColorStop(1, '#0c0f16');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 16, 256);
}
const skyTexture = new THREE.CanvasTexture(skyCanvas);
skyTexture.colorSpace = THREE.SRGBColorSpace;
export const sky = new THREE.Mesh(
  new THREE.SphereGeometry(48, 24, 16),
  new THREE.MeshBasicMaterial({ map: skyTexture, side: THREE.BackSide })
);
scene.add(sky);

// Desktop preview camera. In XR, WebXRManager overwrites the pose each frame.
export const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(0, 1.6, 3);

// Desktop-only orbit controls. Disabled/ignored while presenting because the
// XR pose then drives the camera.
export const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.update();

// Lighting: hemisphere fill + one directional light. Shadows stay off to keep
// Quest 3 draw calls and fill-rate low.
const hemiLight = new THREE.HemisphereLight(0xbfd4ff, 0x202830, 1.0);
scene.add(hemiLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(3, 6, 4);
scene.add(dirLight);

// Procedural floor texture (canvas-drawn checker with subtle noise) — no
// image downloads, tiny memory footprint. Repeats across the floor plane.
function createFloorTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#141a26';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#1b2331';
  ctx.fillRect(0, 0, size / 2, size / 2);
  ctx.fillRect(size / 2, size / 2, size / 2, size / 2);
  // sprinkle subtle noise so the floor is not perfectly flat-looking
  for (let i = 0; i < 220; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.03})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 10);
  return tex;
}

export const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.MeshStandardMaterial({ map: createFloorTexture(), roughness: 1.0, metalness: 0.0 })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

export const grid = new THREE.GridHelper(20, 20, 0x4a6fa5, 0x2a3550);
grid.position.y = 0.001;
scene.add(grid);

// A few decorative low-poly pedestals to give the space some structure. Shared
// geometry + shared material keeps draw calls minimal (per-mesh draw, no
// textures, no shadows).
const pedestalGeo = new THREE.CylinderGeometry(0.25, 0.35, 1.1, 10);
const pedestalMat = new THREE.MeshStandardMaterial({ color: 0x2e3a52, roughness: 0.8 });
export const pedestals = [];
const pedestalSpots = [
  [-3, -3], [3, -3], [-3, 3], [3, 3],
];
for (const [x, z] of pedestalSpots) {
  const p = new THREE.Mesh(pedestalGeo, pedestalMat);
  p.position.set(x, 0.55, z);
  scene.add(p);
  pedestals.push(p);
}

export function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize, false);
