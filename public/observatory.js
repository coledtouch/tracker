// 3D "observatory" view: sensing domes per node, glowing figures from pose
// keypoints, signal-field floor tiles, motion particles. Listens for
// 'ruview-frame' and 'ruview-vitals' events dispatched by app.js.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/+esm';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js/+esm';
import { EffectComposer } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js/+esm';
import { RenderPass } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/RenderPass.js/+esm';
import { UnrealBloomPass } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js/+esm';

const host = document.getElementById('obsStage');
const ROOM = 10; // metres covered by the signal field (x and z)
const BODY_H = 1.75;
const GREEN = new THREE.Color('#38ff6a');
const BLUE = new THREE.Color('#3b5bff');

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
host.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#05060c');
scene.fog = new THREE.FogExp2('#05060c', 0.055);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.set(4.2, 3.0, 5.8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.9, -0.5);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 2.5;
controls.maxDistance = 18;
renderer.domElement.addEventListener('pointerdown', () => (controls.autoRotate = false));

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.15, 0.55, 0.08);
composer.addPass(bloom);

scene.add(new THREE.AmbientLight('#8090ff', 0.25));

// floor
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: '#0e1120', roughness: 0.95, metalness: 0 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(ROOM, 20, '#1b2350', '#121733');
grid.position.y = 0.002;
scene.add(grid);
const fillLight = new THREE.PointLight('#4a5cff', 6, 20, 1.6);
fillLight.position.set(0, 4, 0);
scene.add(fillLight);

// ---------- shared glow texture ----------
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  r.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const GLOW = glowTexture();

// ---------- signal-field floor tiles ----------
const FIELD = 20;
const tileGeo = new THREE.BoxGeometry(ROOM / FIELD * 0.55, 0.02, ROOM / FIELD * 0.28);
const tileMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
const tiles = new THREE.InstancedMesh(tileGeo, tileMat, FIELD * FIELD);
tiles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
const tileVals = new Float32Array(FIELD * FIELD);
const tileTarget = new Float32Array(FIELD * FIELD);
{
  const m = new THREE.Matrix4();
  for (let z = 0; z < FIELD; z++) for (let x = 0; x < FIELD; x++) {
    const i = z * FIELD + x;
    m.makeTranslation((x + 0.5) / FIELD * ROOM - ROOM / 2, 0.012, (z + 0.5) / FIELD * ROOM - ROOM / 2);
    tiles.setMatrixAt(i, m);
    tiles.setColorAt(i, new THREE.Color(0, 0, 0));
  }
}
scene.add(tiles);
const tmpC = new THREE.Color();
function updateTiles(dt) {
  const k = Math.min(1, dt * 6);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < tileTarget.length; i++) { lo = Math.min(lo, tileTarget[i]); hi = Math.max(hi, tileTarget[i]); }
  const span = Math.max(1e-6, hi - lo);
  for (let i = 0; i < tileVals.length; i++) {
    const norm = (tileTarget[i] - lo) / span;
    tileVals[i] += (norm - tileVals[i]) * k;
    const v = tileVals[i];
    const a = v < 0.2 ? 0 : Math.pow((v - 0.2) / 0.8, 1.2);
    tmpC.copy(GREEN).multiplyScalar(a * 1.6);
    tiles.setColorAt(i, tmpC);
  }
  tiles.instanceColor.needsUpdate = true;
}

// ---------- nodes with wireframe domes ----------
const nodeGroups = new Map();
function domeLines(radius, opacity) {
  const geo = new THREE.SphereGeometry(radius, 22, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const lines = new THREE.LineSegments(
    new THREE.WireframeGeometry(geo),
    new THREE.LineBasicMaterial({ color: BLUE, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  return lines;
}
function makeNode(id) {
  const g = new THREE.Group();
  const domes = [domeLines(1.4, 0.38), domeLines(2.4, 0.24), domeLines(3.5, 0.13)];
  domes.forEach((d, i) => { d.userData.base = 1; d.userData.phase = i * 0.9; g.add(d); });
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.18), new THREE.MeshStandardMaterial({ color: '#1a1f33', emissive: '#0a0e22' }));
  box.position.y = 0.03; g.add(box);
  const led = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: '#6f8bff', blending: THREE.AdditiveBlending, depthWrite: false }));
  led.scale.setScalar(0.35); led.position.y = 0.12; g.add(led);
  g.userData = { domes, led, id, seen: performance.now() };
  scene.add(g);
  return g;
}
function nodePos(n, idx) {
  const p = Array.isArray(n.position) ? n.position : null;
  if (p) return [p[0], p[2] ?? 0];
  const ang = idx * 2.1; return [Math.cos(ang) * 3.2, Math.sin(ang) * 3.2];
}
function updateNodes(nodes) {
  const now = performance.now();
  nodes.forEach((n, idx) => {
    const id = n.node_id ?? idx;
    let g = nodeGroups.get(id);
    if (!g) { g = makeNode(id); nodeGroups.set(id, g); }
    const [x, z] = nodePos(n, idx);
    g.position.set(clampRoom(x), 0, clampRoom(z));
    g.userData.seen = now;
  });
  for (const [id, g] of nodeGroups) if (now - g.userData.seen > 5000) { scene.remove(g); nodeGroups.delete(id); }
}
// a default node so the scene isn't empty before data arrives
const idleNode = makeNode('idle'); idleNode.position.set(2, 0, 1.5);

// ---------- figures ----------
const BONES = [
  [5, 6], [5, 11], [6, 12], [11, 12],            // torso
  [5, 7], [7, 9], [6, 8], [8, 10],               // arms
  [11, 13], [13, 15], [12, 14], [14, 16],        // legs
  [0, 5], [0, 6],                                // neck
];
const figures = [];
function makeFigure() {
  const g = new THREE.Group();
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BONES.length * 6), 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: '#7dff9a', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
  g.add(lines);
  const jointMat = new THREE.MeshBasicMaterial({ color: '#ff3b2f' });
  const joints = Array.from({ length: 17 }, () => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), jointMat); g.add(m); return m; });
  const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: '#9dffb0', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  head.scale.setScalar(0.42); g.add(head);
  // glow sprites along bones; torso gets a white-hot core like the reference
  const glows = [];
  BONES.forEach((b, bi) => {
    const torso = bi < 4;
    const per = torso ? 4 : 3;
    for (let s = 0; s < per; s++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: torso ? '#c8ffd8' : '#3dff70', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: torso ? 0.55 : 0.5 }));
      sp.userData = { bone: bi, t: (s + 0.5) / per, size: torso ? 0.36 : 0.22 };
      g.add(sp); glows.push(sp);
    }
  });
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: '#1aff55', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.18 }));
  halo.scale.set(1.3, 2.2, 1); halo.position.y = 0.95; g.add(halo);
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.45, 24), new THREE.MeshBasicMaterial({ color: '#29ff66', transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.01; g.add(shadow);
  g.userData = { lines, joints, head, glows, halo, pts: null, target: null, pos: new THREE.Vector3(), tpos: new THREE.Vector3(), alpha: 0, talpha: 0, motion: 0 };
  scene.add(g);
  return g;
}

function keypointsToLocal(kps) {
  // Server keypoints are image-space pixels (y down). Normalise to metres,
  // feet on the floor, centred on the hips.
  if (!Array.isArray(kps) || kps.length < 17) return null;
  const P = kps.map((k) => [k.x, k.y]);
  const hipX = (P[11][0] + P[12][0]) / 2;
  const ankleY = Math.max(P[15][1], P[16][1]);
  const topY = Math.min(P[0][1], P[1][1], P[2][1]);
  const span = Math.max(1, ankleY - topY);
  const s = (BODY_H * 0.9) / span;
  return P.map(([x, y]) => new THREE.Vector3((x - hipX) * s, (ankleY - y) * s + 0.06, 0));
}

function standingPose() {
  // fallback pose when presence is known but no keypoints are provided
  const k = [[0, 1.62], [-0.04, 1.66], [0.04, 1.66], [-0.08, 1.63], [0.08, 1.63], [-0.2, 1.42], [0.2, 1.42], [-0.26, 1.13], [0.26, 1.13], [-0.28, 0.86], [0.28, 0.86], [-0.12, 0.92], [0.12, 0.92], [-0.13, 0.5], [0.13, 0.5], [-0.13, 0.07], [0.13, 0.07]];
  return k.map(([x, y]) => new THREE.Vector3(x, y, 0));
}

const va = new THREE.Vector3();
function updateFigure(f, dt, t) {
  const u = f.userData;
  const k = Math.min(1, dt * 8);
  u.alpha += (u.talpha - u.alpha) * Math.min(1, dt * 4);
  f.visible = u.alpha > 0.02;
  if (!f.visible || !u.target) return;
  if (!u.pts) u.pts = u.target.map((p) => p.clone());
  u.pts.forEach((p, i) => p.lerp(u.target[i], k));
  u.pos.lerp(u.tpos, Math.min(1, dt * 3));
  f.position.copy(u.pos);
  // face the camera horizontally so the 2D pose reads well
  f.rotation.y = Math.atan2(camera.position.x - f.position.x, camera.position.z - f.position.z);

  const arr = u.lines.geometry.attributes.position.array;
  BONES.forEach(([a, b], i) => { u.pts[a].toArray(arr, i * 6); u.pts[b].toArray(arr, i * 6 + 3); });
  u.lines.geometry.attributes.position.needsUpdate = true;
  u.lines.material.opacity = 0.9 * u.alpha;
  u.joints.forEach((j, i) => j.position.copy(u.pts[i]));
  u.head.position.copy(u.pts[0]).add(va.set(0, 0.06, 0));
  u.head.material.opacity = u.alpha;
  const flick = 0.85 + 0.15 * Math.sin(t * 9 + f.id);
  for (const sp of u.glows) {
    const [a, b] = BONES[sp.userData.bone];
    sp.position.lerpVectors(u.pts[a], u.pts[b], sp.userData.t);
    sp.scale.setScalar(sp.userData.size * (1 + u.motion * 0.25));
    sp.material.opacity = (sp.userData.size > 0.3 ? 0.55 : 0.5) * u.alpha * flick;
  }
  u.halo.material.opacity = 0.18 * u.alpha;
}

// ---------- motion particles ----------
const PCOUNT = 160;
const particles = Array.from({ length: PCOUNT }, () => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: '#2bff5e', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  s.visible = false; s.userData = { life: 0, max: 1, v: new THREE.Vector3() }; scene.add(s); return s;
});
let pIdx = 0;
function emit(pos, n, energy) {
  for (let i = 0; i < n; i++) {
    const s = particles[pIdx++ % PCOUNT];
    s.visible = true;
    s.position.set(pos.x + (Math.random() - 0.5) * 0.7, 0.3 + Math.random() * 1.3, pos.z + (Math.random() - 0.5) * 0.7);
    s.userData.v.set((Math.random() - 0.5) * 0.4, 0.1 + Math.random() * 0.25, (Math.random() - 0.5) * 0.4).multiplyScalar(0.5 + energy);
    s.userData.max = s.userData.life = 0.8 + Math.random() * 1.2;
    s.scale.setScalar(0.08 + Math.random() * 0.16);
  }
}
function updateParticles(dt) {
  for (const s of particles) {
    if (!s.visible) continue;
    s.userData.life -= dt;
    if (s.userData.life <= 0) { s.visible = false; continue; }
    s.position.addScaledVector(s.userData.v, dt);
    s.material.opacity = 0.8 * (s.userData.life / s.userData.max);
  }
}

// ---------- data intake ----------
const clampRoom = (v) => Math.max(-ROOM / 2 + 0.3, Math.min(ROOM / 2 - 0.3, v));
let lastFrameAt = 0;
let motionLevel = 0;
function fieldPeak(sf) {
  if (!sf || !Array.isArray(sf.values)) return null;
  const gx = sf.grid_size?.[0] || FIELD, gz = sf.grid_size?.[2] || sf.grid_size?.[1] || gx;
  let best = -Infinity, bi = 0;
  sf.values.forEach((v, i) => { if (v > best) { best = v; bi = i; } });
  return [((bi % gx) + 0.5) / gx * ROOM - ROOM / 2, (Math.floor(bi / gx) + 0.5) / gz * ROOM - ROOM / 2];
}

window.addEventListener('ruview-frame', (e) => {
  const d = e.detail || {};
  lastFrameAt = performance.now();
  if (idleNode.parent) scene.remove(idleNode);
  updateNodes(Array.isArray(d.nodes) ? d.nodes : []);

  if (d.signal_field && Array.isArray(d.signal_field.values) && d.signal_field.values.length === FIELD * FIELD) {
    tileTarget.set(d.signal_field.values);
  }

  const c = d.classification || {};
  const mot = c.motion_level === 'active' ? 1 : c.motion_level === 'present_still' ? 0.25 : 0;
  motionLevel += (mot - motionLevel) * 0.2;

  let persons = Array.isArray(d.persons) ? d.persons : [];
  if (!persons.length && c.presence === true) {
    const pk = fieldPeak(d.signal_field) || [0, 0];
    persons = [{ position: [pk[0], 0, pk[1]], keypoints: null }];
  }
  while (figures.length < persons.length) figures.push(makeFigure());
  figures.forEach((f, i) => {
    const p = persons[i];
    const u = f.userData;
    if (!p) { u.talpha = 0; return; }
    u.talpha = 1;
    u.target = keypointsToLocal(p.keypoints) || standingPose();
    const pos = Array.isArray(p.position) ? p.position : null;
    const [x, z] = pos ? [pos[0], pos[2] ?? 0] : fieldPeak(d.signal_field) || [0, 0];
    u.tpos.set(clampRoom(x), 0, clampRoom(z));
    if (u.alpha < 0.05) u.pos.copy(u.tpos);
    u.motion = Math.min(1, (num(p.motion_score) ?? mot * 60) / 60);
  });
  document.getElementById('obsPeople').textContent = String(persons.length);
});

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

// ---------- loop ----------
function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.setSize(w, h);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);
resize();

const clock = new THREE.Clock();
let emitAcc = 0;
function tick() {
  requestAnimationFrame(tick);
  if (!host.offsetParent) return; // tab hidden
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;
  controls.update();

  for (const g of nodeGroups.values()) animateNode(g, t);
  if (idleNode.parent) animateNode(idleNode, t);
  updateTiles(dt);
  figures.forEach((f) => updateFigure(f, dt, t));

  emitAcc += dt;
  if (emitAcc > 0.08) {
    emitAcc = 0;
    for (const f of figures) {
      const u = f.userData;
      if (u.alpha > 0.5) emit(f.position, Math.round(1 + u.motion * 4 + motionLevel * 2), u.motion);
    }
  }
  updateParticles(dt);

  const stale = performance.now() - lastFrameAt > 3000;
  document.getElementById('obsWaiting').hidden = !stale;
  if (stale) figures.forEach((f) => (f.userData.talpha = 0));
  composer.render();
}
function animateNode(g, t) {
  g.userData.domes.forEach((d, i) => {
    const pulse = 1 + 0.04 * Math.sin(t * 1.4 + d.userData.phase);
    d.scale.setScalar(pulse);
    d.rotation.y = t * (0.05 + i * 0.02) * (i % 2 ? -1 : 1);
  });
  g.userData.led.material.opacity = 0.6 + 0.4 * Math.abs(Math.sin(t * 3));
}
tick();

// ---------- vitals card ----------
function setBar(id, frac) { document.getElementById(id).style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%'; }
window.addEventListener('ruview-vitals', (e) => {
  const v = e.detail || {};
  const hr = num(v.heart), br = num(v.breath), cf = num(v.confidence);
  document.getElementById('obsHr').textContent = hr == null ? '—' : Math.round(hr);
  document.getElementById('obsBr').textContent = br == null ? '—' : Math.round(br);
  document.getElementById('obsCf').textContent = cf == null ? '—' : Math.round(cf * 100);
  setBar('obsHrBar', hr == null ? 0 : (hr - 40) / 80);
  setBar('obsBrBar', br == null ? 0 : (br - 6) / 24);
  setBar('obsCfBar', cf == null ? 0 : cf);
  const note = document.getElementById('obsVitalNote');
  note.textContent = v.note || '';
  note.hidden = !v.note;
});

document.getElementById('obsReset').addEventListener('click', () => {
  camera.position.set(4.2, 3.0, 5.8); controls.target.set(0, 0.9, -0.5); controls.autoRotate = true;
});
window.__observatoryReady = true;
