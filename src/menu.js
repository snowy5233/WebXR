// In-VR menu: a world-space panel with clickable rows, driven by the same
// controller rays used for object interaction. Rendered with canvas textures
// (one canvas per state change — cheap, no font loading).
//
// Rows:
//   - Locomotion: Teleport / Smooth (toggle)
//   - Reset objects (respawn grabbables at their spawn spots)
//   - Exit session
//
// Toggled with the A/X button on the right controller (main.js wires the
// input edge to toggleMenu()). While open, the panel floats ~1.2m in front of
// the head at first-open orientation. Trigger clicks a row; squeeze closes.

import * as THREE from 'three';
import { renderer, scene, camera } from './scene.js';
import {
  LOCOMOTION_TELEPORT, LOCOMOTION_SMOOTH,
  getLocomotionMode, setLocomotionMode,
} from './locomotion.js';
import { resetGrabbables } from './objects.js';

const PANEL_W = 0.5;
const PANEL_H = 0.35;
const ROWS = [
  { id: 'locomotion', label: () => 'Locomotion: ' + (getLocomotionMode() === LOCOMOTION_TELEPORT ? 'Teleport' : 'Smooth') },
  { id: 'reset', label: () => 'Reset objects' },
  { id: 'exit', label: () => 'Exit VR' },
];

let panel = null;
let panelCanvas = null;
let panelTexture = null;
let hoveredRow = -1;
let lastDrawnHover = -2;

function drawPanel() {
  const W = 512, H = Math.round(512 * PANEL_H / PANEL_W);
  panelCanvas.width = W;
  panelCanvas.height = H;
  const ctx = panelCanvas.getContext('2d');
  ctx.fillStyle = 'rgba(10, 16, 26, 0.92)';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#4a6fa5';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, W - 4, H - 4);
  ctx.font = '700 34px system-ui, sans-serif';
  ctx.fillStyle = '#cfe0ff';
  ctx.fillText('Menu', 24, 52);
  const rowH = (H - 70) / ROWS.length;
  for (let i = 0; i < ROWS.length; i++) {
    const y = 70 + i * rowH;
    if (i === hoveredRow) {
      ctx.fillStyle = 'rgba(102, 204, 255, 0.25)';
      ctx.fillRect(12, y + 4, W - 24, rowH - 12);
    }
    ctx.fillStyle = i === hoveredRow ? '#9ff' : '#dfe8f5';
    ctx.font = '30px system-ui, sans-serif';
    ctx.fillText(ROWS[i].label(), 28, y + rowH / 2 + 10);
  }
  panelTexture.needsUpdate = true;
}

export function ensureMenu() {
  if (panel) return;
  panelCanvas = document.createElement('canvas');
  panelTexture = new THREE.CanvasTexture(panelCanvas);
  panelTexture.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: panelTexture,
    transparent: true,
    depthTest: false,
  });
  panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), mat);
  panel.renderOrder = 500;
  panel.userData.isMenu = true;
  drawPanel();
}

export function isMenuOpen() {
  return !!(panel && panel.parent);
}

export function toggleMenu() {
  ensureMenu();
  if (isMenuOpen()) {
    scene.remove(panel);
  } else {
    // Place ~1.2m in front of the head, facing the head, at head height.
    const headPos = new THREE.Vector3();
    camera.getWorldPosition(headPos);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    fwd.y = 0;
    fwd.normalize();
    panel.position.copy(headPos).addScaledVector(fwd, 1.2);
    panel.lookAt(headPos.x, headPos.y, headPos.z);
    scene.add(panel);
  }
}

export function closeMenu() {
  if (isMenuOpen()) scene.remove(panel);
}

function rowHit(localY) {
  // localY is in panel-local units (plane height 2 = PANEL_H world).
  const norm = 1 - (localY / 2 + 0.5); // 0 at top, 1 at bottom
  const rowsTop = 70 / panelCanvas.height;
  const rowsNorm = (norm - rowsTop) * (panelCanvas.height / (panelCanvas.height - 70));
  if (rowsNorm < 0 || rowsNorm > 1) return -1;
  return Math.min(ROWS.length - 1, Math.floor(rowsNorm * ROWS.length));
}

function activateRow(rowIndex) {
  const row = ROWS[rowIndex];
  if (!row) return;
  if (row.id === 'locomotion') {
    setLocomotionMode(
      getLocomotionMode() === LOCOMOTION_TELEPORT ? LOCOMOTION_SMOOTH : LOCOMOTION_TELEPORT
    );
    drawPanel();
  } else if (row.id === 'reset') {
    resetGrabbables();
  } else if (row.id === 'exit') {
    const session = renderer.xr.getSession();
    if (session) session.end().catch(() => {});
    closeMenu();
  }
}

// Shared temps for the panel raycast.
const _hit = new THREE.Vector3();
const _rayMat4 = new THREE.Matrix4();
const _menuRaycaster = new THREE.Raycaster();

function menuRaycast(data) {
  _rayMat4.identity().extractRotation(data.controller.matrixWorld);
  _menuRaycaster.ray.origin.setFromMatrixPosition(data.controller.matrixWorld);
  _menuRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(_rayMat4);
  const intersects = _menuRaycaster.intersectObject(panel, false);
  return intersects.length > 0 ? intersects[0] : null;
}

// Per-frame: update hover highlight and handle trigger-press clicks.
export function updateMenu(controllerDatas, selectPresses) {
  if (!isMenuOpen()) return;
  // selectPresses: array of controller data entries whose trigger was pressed
  // this frame (main.js collects the selectstart events).
  let newHover = -1;
  let clickedData = null;
  for (const data of controllerDatas) {
    if (!data || !data.rayLine.visible) continue;
    const hit = menuRaycast(data);
    if (!hit) continue;
    // Convert world hit point to panel-local coordinates.
    panel.worldToLocal(_hit.copy(hit.point));
    const row = rowHit(_hit.y);
    if (row >= 0) newHover = row;
    if (row >= 0 && selectPresses && selectPresses.has(data)) clickedData = data;
  }
  hoveredRow = newHover;
  // Only redraw the canvas texture when the hover actually changed (or a
  // click changed a label) — redrawing per frame wastes fill-rate on Quest 3.
  if (hoveredRow !== lastDrawnHover) {
    drawPanel();
    lastDrawnHover = hoveredRow;
  }
  if (clickedData) {
    activateRow(hoveredRow);
    // A click can change a row label (locomotion toggle) — redraw and mark
    // the state as current so the hover check above doesn't skip it.
    drawPanel();
    lastDrawnHover = hoveredRow;
  }
}
