/* The look of the 3D circuit board, shared by the home page card (model-viewer,
   index.html) and the avionics project page (Three.js, js/avionics-pcb.js), so the
   two always match. Change it here and both pages follow.

   The colors live in the model file. avionics-pcb.min.glb has a deep, saturated,
   opaque soldermask (blue, picked against assets/avionics-page/bare-board.jpg) and
   warm gold copper. The lighting below is what makes those colors read like a real
   board: model-viewer's "legacy" studio room, and its "commerce" tone mapping
   (Khronos PBR Neutral), which keeps saturated colors from washing out. */

/* Bump the ?v= number whenever the model file changes, here and in the preload link
   in projects/avionics-pcb.html */
export const BOARD_MODEL = new URL('../assets/Avionics%20PCB%20Files%20x2/avionics-pcb.min.glb?v=3', import.meta.url).href;

export const BOARD_LOOK = {
  environment: 'legacy',
  toneMapping: 'commerce',
  exposure: 1.05,
};

/* Home page: model-viewer does the lighting itself from these attributes */
export function applyLookToModelViewer(mv) {
  mv.setAttribute('environment-image', BOARD_LOOK.environment);
  mv.setAttribute('tone-mapping', BOARD_LOOK.toneMapping);
  mv.setAttribute('exposure', String(BOARD_LOOK.exposure));
  mv.setAttribute('src', BOARD_MODEL);
}

/* Avionics page: the same lighting rebuilt in plain Three.js.
   model-viewer 4.3.1 renders its "legacy" room into a cube map, blurs it by 0.04,
   and uses it as the only light. Its "commerce" tone mapping is Three.js's
   NeutralToneMapping, and when that is paired with a generated room it raises the
   exposure by 1.3. The room below is model-viewer's own table (Apache 2.0, Google).
   It is the same room as Three.js's RoomEnvironment, except the top light is 500
   instead of 900. */
const LEGACY_ROOM = {
  topLight: { intensity: 500, position: [0.418, 16.199, 0.3] },
  room: { position: [-0.757, 13.219, 0.717], scale: [31.713, 28.305, 28.591] },
  boxes: [
    { position: [-10.906, 2.009, 1.846], rotation: -0.195, scale: [2.328, 7.905, 4.651] },
    { position: [-5.607, -0.754, -0.758], rotation: 0.994, scale: [1.97, 1.534, 3.955] },
    { position: [6.167, 0.857, 7.803], rotation: 0.561, scale: [3.927, 6.285, 3.687] },
    { position: [-2.017, 0.018, 6.124], rotation: 0.333, scale: [2.002, 4.566, 2.064] },
    { position: [2.291, -0.756, -2.621], rotation: -0.286, scale: [1.546, 1.552, 1.496] },
    { position: [-2.193, -0.369, -5.547], rotation: 0.516, scale: [3.875, 3.487, 2.986] },
  ],
  lights: [
    { intensity: 50, position: [-16.116, 14.37, 8.208], scale: [0.1, 2.428, 2.739] },
    { intensity: 50, position: [-16.109, 18.021, -8.207], scale: [0.1, 2.425, 2.751] },
    { intensity: 17, position: [14.904, 12.198, -1.832], scale: [0.15, 4.265, 6.331] },
    { intensity: 43, position: [-0.462, 8.89, 14.52], scale: [4.38, 5.441, 0.088] },
    { intensity: 20, position: [3.235, 11.486, -12.541], scale: [2.5, 2, 0.1] },
    { intensity: 100, position: [0, 20, 0], scale: [1, 0.1, 1] },
  ],
};

export function applyLookToThree(THREE, renderer, scene) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = BOARD_LOOK.exposure * 1.3;

  const room = new THREE.Scene();
  room.position.y = -3.5;
  const box = new THREE.BoxGeometry();
  box.deleteAttribute('uv');
  const wallMat = new THREE.MeshStandardMaterial({ metalness: 0, side: THREE.BackSide });
  const boxMat = new THREE.MeshStandardMaterial({ metalness: 0 });
  const t = LEGACY_ROOM;
  const top = new THREE.PointLight(0xffffff, t.topLight.intensity, 28, 2);
  top.position.set(...t.topLight.position);
  room.add(top);
  const walls = new THREE.Mesh(box, wallMat);
  walls.position.set(...t.room.position);
  walls.scale.set(...t.room.scale);
  room.add(walls);
  for (const b of t.boxes) {
    const m = new THREE.Mesh(box, boxMat);
    m.position.set(...b.position);
    m.rotation.set(0, b.rotation, 0);
    m.scale.set(...b.scale);
    room.add(m);
  }
  const lightMats = [];
  for (const l of t.lights) {
    const mat = new THREE.MeshBasicMaterial();
    mat.color.setScalar(l.intensity);
    lightMats.push(mat);
    const m = new THREE.Mesh(box, mat);
    m.position.set(...l.position);
    m.scale.set(...l.scale);
    room.add(m);
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(room, 0.04, 0.1, 100).texture;
  pmrem.dispose();
  box.dispose(); wallMat.dispose(); boxMat.dispose();
  lightMats.forEach(m => m.dispose());
}
