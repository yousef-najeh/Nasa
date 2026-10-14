import * as Cesium from "cesium";

/**
 * Camera handling for the Moon globe.
 *
 * Cesium's defaults are tuned for Earth with a ground-level user. Here the
 * camera has to work from 5000 km out down to standing on a crater rim, so
 * every rate is scaled by height above the surface, and the mouse bindings are
 * remapped to what people already know from Google Earth.
 */

const MIN_HEIGHT = 40;          // m above the surface
const MAX_HEIGHT = 12_000_000;  // m -- past this the Moon is a dot

export function setupNavigation(viewer, { getHeight } = {}) {
  const { scene, camera } = viewer;
  const ctrl = scene.screenSpaceCameraController;
  const ellipsoid = Cesium.Ellipsoid.MOON;

  // --- feel ---------------------------------------------------------------
  // Inertia is what makes dragging feel like momentum rather than a slideshow.
  // Cesium's defaults are right; they were previously zeroed to stop a
  // programmatic setView from drifting, which cost all the glide.
  ctrl.inertiaSpin = 0.9;
  ctrl.inertiaTranslate = 0.9;
  ctrl.inertiaZoom = 0.8;

  ctrl.minimumZoomDistance = MIN_HEIGHT;
  ctrl.maximumZoomDistance = MAX_HEIGHT;
  ctrl.enableCollisionDetection = true;   // never fall through the terrain
  ctrl._zoomFactor = 3.5;                 // snappier wheel response

  // Google-Earth-style bindings: left drag orbits, right drag tilts,
  // wheel zooms. Cesium's default puts zoom on right-drag, which surprises
  // everyone who has used a map before.
  ctrl.rotateEventTypes = [Cesium.CameraEventType.LEFT_DRAG];
  ctrl.tiltEventTypes = [
    Cesium.CameraEventType.RIGHT_DRAG,
    Cesium.CameraEventType.MIDDLE_DRAG,
    { eventType: Cesium.CameraEventType.LEFT_DRAG,
      modifier: Cesium.KeyboardEventModifier.CTRL },
  ];
  ctrl.zoomEventTypes = [
    Cesium.CameraEventType.WHEEL,
    Cesium.CameraEventType.PINCH,
  ];
  ctrl.lookEventTypes = [
    { eventType: Cesium.CameraEventType.LEFT_DRAG,
      modifier: Cesium.KeyboardEventModifier.SHIFT },
  ];

  const heightAboveGround = () => {
    const carto = ellipsoid.cartesianToCartographic(camera.position);
    if (!carto) return 1000;
    const ground = getHeight?.(
      Cesium.Math.toDegrees(carto.latitude),
      Cesium.Math.toDegrees(carto.longitude),
    );
    const h = carto.height - (Number.isFinite(ground) ? ground : 0);
    return Math.max(h, MIN_HEIGHT);
  };

  // --- zoom toward the cursor --------------------------------------------
  // Cesium zooms along the view axis, so the thing you aimed at slides out of
  // frame. Zooming toward the point under the pointer is what makes a map feel
  // like it is being driven rather than nudged.
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  let mouse = null;
  // Tracked straight off the canvas rather than through Cesium's event
  // handler: the wheel action reports only a delta, so if the pointer position
  // were ever unknown the zoom would silently fall back to zooming at the
  // screen centre.
  const trackPointer = (e) => {
    const r = scene.canvas.getBoundingClientRect();
    mouse = new Cesium.Cartesian2(e.clientX - r.left, e.clientY - r.top);
  };
  scene.canvas.addEventListener("pointermove", trackPointer);
  scene.canvas.addEventListener("mousemove", trackPointer);
  scene.canvas.addEventListener("wheel", trackPointer, { passive: true });

  const pickGround = (pos) => {
    if (!pos) return undefined;
    const picked = scene.pickPosition(pos);
    if (Cesium.defined(picked)) return picked;
    const ray = camera.getPickRay(pos);
    return ray ? scene.globe.pick(ray, scene) : undefined;
  };

  ctrl.enableZoom = false;   // replaced by the handler below
  handler.setInputAction((delta) => {
    const target = pickGround(mouse);
    const h = heightAboveGround();
    // fraction of the remaining distance per notch, eased near the surface
    const step = Math.sign(delta) * Math.min(Math.abs(delta) / 120, 3) * 0.22;

    if (!Cesium.defined(target)) {
      camera.moveForward(h * step);
      return;
    }
    const toTarget = Cesium.Cartesian3.subtract(
      target, camera.position, new Cesium.Cartesian3());
    const dist = Cesium.Cartesian3.magnitude(toTarget);
    let move = dist * step;
    if (move > 0) move = Math.min(move, dist - MIN_HEIGHT);   // never overshoot
    if (dist - move > MAX_HEIGHT) return;
    Cesium.Cartesian3.normalize(toTarget, toTarget);
    camera.move(toTarget, move);
  }, Cesium.ScreenSpaceEventType.WHEEL);

  // --- double click to fly in --------------------------------------------
  handler.setInputAction((click) => {
    const target = pickGround(click.position);
    if (!Cesium.defined(target)) return;
    const carto = ellipsoid.cartesianToCartographic(target);
    const h = heightAboveGround();
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(
        carto.longitude, carto.latitude, carto.height + h * 0.35, ellipsoid),
      orientation: { heading: camera.heading, pitch: camera.pitch, roll: 0 },
      duration: 1.1,
      easingFunction: Cesium.EasingFunction.QUADRATIC_OUT,
    });
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  // --- keyboard -----------------------------------------------------------
  const keys = new Set();
  const tracked = new Set([
    "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyR", "KeyF",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "ShiftLeft", "ShiftRight",
  ]);
  const onKey = (e, down) => {
    if (e.target instanceof HTMLInputElement) return;
    if (!tracked.has(e.code)) return;
    e.preventDefault();
    down ? keys.add(e.code) : keys.delete(e.code);
  };
  window.addEventListener("keydown", (e) => onKey(e, true));
  window.addEventListener("keyup", (e) => onKey(e, false));
  window.addEventListener("blur", () => keys.clear());

  let last = performance.now();
  scene.preUpdate.addEventListener(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (keys.size === 0) return;

    const boost = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 3.5 : 1;
    // travel a fraction of the current altitude per second, so the controls
    // feel the same from orbit as they do 100 m off the ground
    const speed = heightAboveGround() * 0.9 * boost * dt;
    const turn = Cesium.Math.toRadians(45) * boost * dt;

    if (keys.has("KeyW") || keys.has("ArrowUp")) camera.moveForward(speed);
    if (keys.has("KeyS") || keys.has("ArrowDown")) camera.moveBackward(speed);
    if (keys.has("KeyA") || keys.has("ArrowLeft")) camera.moveLeft(speed);
    if (keys.has("KeyD") || keys.has("ArrowRight")) camera.moveRight(speed);
    if (keys.has("KeyR")) camera.moveUp(speed);
    if (keys.has("KeyF")) camera.moveDown(speed);
    // look*, not twist*: twisting rolls the horizon over, which is disorienting
    // and leaves the view crooked with no way back short of a preset.
    if (keys.has("KeyQ")) camera.lookLeft(turn);
    if (keys.has("KeyE")) camera.lookRight(turn);
  });

  return {
    /** Cancel any running flight and settle inertia — call before setView. */
    settle() {
      camera.cancelFlight();
      const { inertiaSpin, inertiaTranslate, inertiaZoom } = ctrl;
      ctrl.inertiaSpin = ctrl.inertiaTranslate = ctrl.inertiaZoom = 0;
      requestAnimationFrame(() => {
        ctrl.inertiaSpin = inertiaSpin;
        ctrl.inertiaTranslate = inertiaTranslate;
        ctrl.inertiaZoom = inertiaZoom;
      });
    },
    heightAboveGround,
  };
}
