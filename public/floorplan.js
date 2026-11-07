// Apartment floor plan traced from the Roomba app map (screenshot pixels,
// y down). Converted to metres with a configurable scale.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/+esm';

export const ROOMS = [
  {
    name: 'Kitchen', label: [398, 498],
    poly: [[216, 394], [458, 394], [458, 399], [504, 399], [504, 362], [653, 362], [653, 484], [468, 484], [468, 497],
      [450, 497], [450, 685], [370, 685], [370, 655], [216, 655]],
  },
  {
    name: 'Bathroom', label: [579, 640],
    poly: [[458, 624], [548, 624], [548, 609], [585, 609], [585, 543], [602, 543], [602, 520], [720, 520], [720, 708],
      [563, 708], [563, 822], [555, 822], [555, 834], [490, 834], [490, 843], [438, 843], [438, 713], [458, 713]],
  },
  {
    name: 'Living Room', label: [293, 870],
    poly: [[158, 708], [347, 708], [347, 698], [360, 698], [360, 687], [437, 687], [437, 902], [361, 902], [361, 1000],
      [370, 1000], [370, 1118], [189, 1118], [189, 1075], [176, 1075], [176, 1023], [199, 1023], [199, 942], [158, 942]],
  },
  {
    name: 'Bedroom', label: [620, 986],
    poly: [[490, 848], [557, 848], [557, 857], [652, 857], [652, 866], [751, 866], [751, 918], [766, 918], [766, 1117],
      [481, 1117], [481, 946], [490, 946]],
  },
];
export const DOCK = [170, 914]; // Roomba dock, Living Room west wall
const CX = 462, CY = 740;        // plan centre in pixels
export const DEFAULT_SCALE = 0.015; // metres per map pixel (~9 m × 11 m)
const WALL_H = 1.0;              // low "dollhouse" walls so people stay visible

export function pxToWorld([px, py], s) { return [(px - CX) * s, (py - CY) * s]; }
export function worldToPx(x, z, s) { return [x / s + CX, z / s + CY]; }

function inPoly([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function roomAt(x, z, s) {
  const p = worldToPx(x, z, s);
  for (const r of ROOMS) if (inPoly(p, r.poly)) return r.name;
  // tolerate positions just outside a wall (pose noise): nearest room within ~0.4 m
  let best = null, bestD = 0.4 / s;
  for (const r of ROOMS) {
    for (let i = 0; i < r.poly.length; i++) {
      const a = r.poly[i], b = r.poly[(i + 1) % r.poly.length];
      const d = segDist(p, a, b);
      if (d < bestD) { bestD = d; best = r.name; }
    }
  }
  return best;
}
function segDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function labelSprite(text) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.font = '600 56px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(120,160,255,0.9)'; g.shadowBlur = 18;
  g.fillStyle = '#cfdcff'; g.fillText(text.toUpperCase(), 256, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0.85 }));
  sp.scale.set(2.2, 0.55, 1);
  return sp;
}

// Builds the apartment group; returns { group, setActive(names:Set) }.
export function buildPlan(s) {
  const group = new THREE.Group();
  const wallMat = new THREE.MeshStandardMaterial({ color: '#2b3a7a', emissive: '#0d1640', transparent: true, opacity: 0.38, roughness: 0.6, depthWrite: false, side: THREE.DoubleSide });
  const edgeMat = new THREE.LineBasicMaterial({ color: '#7fa2ff', transparent: true, opacity: 0.85 });
  const floors = new Map();

  for (const r of ROOMS) {
    const pts = r.poly.map((p) => pxToWorld(p, s));
    // floor
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const fm = new THREE.MeshStandardMaterial({ color: '#111833', emissive: '#000000', roughness: 0.9, transparent: true, opacity: 0.95 });
    const fl = new THREE.Mesh(new THREE.ShapeGeometry(shape), fm);
    fl.rotation.x = -Math.PI / 2; fl.position.y = 0.004;
    group.add(fl); floors.set(r.name, fm);
    // walls + glowing top edge
    const top = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 0.02) continue;
      const w = new THREE.Mesh(new THREE.BoxGeometry(len, WALL_H, 0.05), wallMat);
      w.position.set((x1 + x2) / 2, WALL_H / 2, (z1 + z2) / 2);
      w.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      group.add(w);
      top.push(new THREE.Vector3(x1, WALL_H, z1), new THREE.Vector3(x2, WALL_H, z2));
      top.push(new THREE.Vector3(x1, 0.01, z1), new THREE.Vector3(x2, 0.01, z2));
    }
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(top), edgeMat));
    const lab = labelSprite(r.name);
    const [lx, lz] = pxToWorld(r.label, s);
    lab.position.set(lx, WALL_H + 0.9, lz);
    group.add(lab);
  }
  // Roomba dock marker
  const [dx, dz] = pxToWorld(DOCK, s);
  const dock = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.09, 24), new THREE.MeshStandardMaterial({ color: '#2a2f3a', emissive: '#0b2a12' }));
  dock.position.set(dx + 0.2, 0.045, dz);
  group.add(dock);

  const ACTIVE = new THREE.Color('#14ff5a');
  function setActive(names) {
    for (const [name, m] of floors) {
      const on = names.has(name);
      m.emissive.copy(on ? ACTIVE : new THREE.Color(0, 0, 0)).multiplyScalar(on ? 0.07 : 0);
      m.color.set(on ? '#0f2a1d' : '#111833');
    }
  }
  return { group, setActive };
}

export function planBounds(s) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of ROOMS) for (const p of r.poly) {
    const [x, z] = pxToWorld(p, s);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  return { x0, x1, z0, z1, w: x1 - x0, d: z1 - z0 };
}
