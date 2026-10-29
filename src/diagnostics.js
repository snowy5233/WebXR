// In-world diagnostics panel. The DOM debug overlay is invisible inside a
// headset, which made XR failures look like unexplained black screens. This
// is a canvas-textured plane in the scene that follows the head while
// presenting, showing live state and — critically — the last error thrown
// inside the render loop, readable in-headset.

import * as THREE from 'three';
import { scene, camera } from './scene.js';

const PANEL_W = 0.6;
const PANEL_H = 0.25;

let canvas = null;
let texture = null;
let mesh = null;
let visible = false;
let lastError = null;
let statusText = '';

function build() {
  canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round(512 * PANEL_H / PANEL_W);
  texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PANEL_W, PANEL_H),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false })
  );
  mesh.renderOrder = 1000;
  mesh.frustumCulled = false;
}

function draw() {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, 0, W, H);
  if (lastError) {
    ctx.fillStyle = '#ff5577';
    ctx.font = 'bold 22px monospace';
    wrapText(ctx, 'ERROR: ' + lastError, 12, 30, W - 24, 26);
  } else {
    ctx.fillStyle = '#7fffd0';
    ctx.font = '20px monospace';
    wrapText(ctx, statusText || 'OK', 12, 30, W - 24, 24);
  }
  texture.needsUpdate = true;
}

function wrapText(ctx, text, x, y, maxW, lineH) {
  const words = String(text).split(' ');
  let line = '';
  let yy = y;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, yy);
      line = w;
      yy += lineH;
      if (yy > canvas.height - 8) break;
    } else {
      line = test;
    }
  }
  if (yy <= canvas.height - 8) ctx.fillText(line, x, yy);
}

export function showDiagnostics(text) {
  statusText = text;
  if (!mesh) build();
  if (!visible) {
    scene.add(mesh);
    visible = true;
  }
  if (!lastError) draw();
}

export function hideDiagnostics() {
  if (mesh && visible) {
    scene.remove(mesh);
    visible = false;
    lastError = null;
  }
}

export function reportLoopError(err) {
  lastError = err && err.message ? err.message : String(err);
  if (!mesh) build();
  if (!visible) {
    scene.add(mesh);
    visible = true;
  }
  draw();
}

// Per-frame: keep the panel ~0.9m in front of the head, facing the head.
const _headPos = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export function updateDiagnostics() {
  if (!mesh || !visible) return;
  camera.getWorldPosition(_headPos);
  _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
  _fwd.normalize();
  // Slightly below the line of sight so it never blocks the view.
  mesh.position.copy(_headPos).addScaledVector(_fwd, 0.9);
  mesh.position.y -= 0.25;
  mesh.lookAt(_headPos.x, mesh.position.y, _headPos.z);
}
