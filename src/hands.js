// Hand-tracking support, decoupled from the controller/grip slots per the
// README's plan. Uses renderer.xr.getHand(i) plus Three.js's
// XRHandModelFactory, which attaches a simple sphere-per-joint visual
// ("spheres" profile) to the hand Object3D and positions them from the
// XRHand joint poses every frame.
//
// Hand input sources have a null gripSpace, so the vendor controller model
// cannot track them (it would freeze at the grip origin — the v1 bug). The
// controller 'connected' handler hides the model for hand sources, and this
// module shows the hand mesh instead. The WebXR runtime fires 'select'
// (pinch) on the hand's target-ray space, and Three.js dispatches it on the
// same controller slot object, so hands reuse the identical grab/select
// bindings as controllers with zero extra wiring: pinch to place a part,
// pinch at a placed part while gripping (squeeze) to move it.
//
// NOTE: createHandModel registers its own 'connected' listener on the hand
// object and builds the joint meshes when that event fires — so it MUST be
// called at setup time, before the session connects hands. Calling it inside
// the 'connected' handler would miss the event and produce an empty model.

import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { renderer, scene } from './scene.js';
import { controllerData } from './controllers.js';

const handModelFactory = new XRHandModelFactory();

export function setupHands() {
  for (let i = 0; i < 2; i++) {
    const hand = renderer.xr.getHand(i);
    // 'spheres' profile: cheapest and most robust (no skinned-mesh loads).
    const handModel = handModelFactory.createHandModel(hand, 'spheres');
    hand.userData.handModel = handModel;
    scene.add(hand);
    if (controllerData[i]) controllerData[i].handObject = hand;
  }
}

export function updateHands() {
  // Joint meshes are positioned automatically by the factory/manager each
  // frame while a hand source is tracked. Hook kept for future per-frame hand
  // behavior (e.g. pinch feedback) without touching the render loop.
}
