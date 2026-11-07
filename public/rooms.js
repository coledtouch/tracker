// Room-level location that is more reliable than single-node pose positions.
//
// 1. Fingerprints: while you walk around a room, we record per-node CSI
//    disturbance (how much each ESP32↔router link's subcarrier amplitudes are
//    being perturbed) plus RSSI. A k-nearest-neighbour classifier then says
//    which room the activity is in. Each room disturbs a different mix of
//    links, so this works even when the server's (x, z) estimate is poor.
// 2. Hysteresis: a room change is only accepted after it persists, and moves
//    between rooms that don't touch must persist longer (no jumping through walls).
import { ADJACENT } from './floorplan.js';

const FP_KEY = 'obs.fp.v1';
const WINDOW_MS = 500;       // one feature vector per half second
const K = 7;

export function adjacent(a, b) {
  return a === b || (ADJACENT[a] || []).includes(b);
}

// Accepts a candidate room only once it has held long enough.
export class RoomHysteresis {
  constructor(holdMs = 900, farHoldMs = 2600) { this.holdMs = holdMs; this.farHoldMs = farHoldMs; this.room = null; this.cand = null; this.since = 0; }
  update(candidate, now = performance.now()) {
    if (candidate === this.room) { this.cand = null; return this.room; }
    if (candidate !== this.cand) { this.cand = candidate; this.since = now; }
    const need = this.room == null || candidate == null || adjacent(this.room, candidate) ? this.holdMs : this.farHoldMs;
    if (now - this.since >= need) { this.room = candidate; this.cand = null; }
    return this.room;
  }
}

export class RoomFingerprints {
  constructor() {
    this.base = new Map();      // node_id -> Float32Array EMA baseline amplitude
    this.acc = new Map();       // node_id -> {e, r, n}
    this.energy = new Map();    // node_id -> smoothed disturbance
    this.windowStart = 0;
    this.lastVec = null;        // latest feature vector
    this.key = '';              // which nodes the vector describes, e.g. "1,2,3"
    this.store = load();        // { key, samples: { room: [vec...] } }
    this.recording = null;      // { room, until, onDone }
    this.scores = null;         // smoothed class probabilities
    this.hyst = new RoomHysteresis(1000, 2800);
    this.result = { room: null, confidence: 0 };
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  // ---- feature extraction ----
  ingest(frame) {
    const nodes = (Array.isArray(frame.nodes) ? frame.nodes : []).filter((n) => Array.isArray(n.amplitude) && n.amplitude.length);
    if (!nodes.length) return;
    for (const n of nodes) {
      const id = n.node_id ?? 0, a = n.amplitude;
      let b = this.base.get(id);
      if (!b || b.length !== a.length) { b = Float32Array.from(a); this.base.set(id, b); }
      let dev = 0, mag = 0;
      for (let i = 0; i < a.length; i++) { dev += Math.abs(a[i] - b[i]); mag += Math.abs(b[i]); b[i] += (a[i] - b[i]) * 0.03; }
      const e = dev / Math.max(1e-6, mag);
      this.energy.set(id, (this.energy.get(id) || 0) * 0.8 + e * 0.2); // for link glow
      const s = this.acc.get(id) || { e: 0, r: 0, n: 0 };
      s.e += e; s.r += typeof n.rssi_dbm === 'number' ? n.rssi_dbm : 0; s.n++;
      this.acc.set(id, s);
    }
    const now = performance.now();
    if (!this.windowStart) this.windowStart = now;
    if (now - this.windowStart < WINDOW_MS) return;
    this.windowStart = now;
    const ids = [...this.acc.keys()].sort((x, y) => x - y);
    const vec = [];
    for (const id of ids) { const s = this.acc.get(id); vec.push(Math.log(1e-4 + s.e / s.n)); }
    for (const id of ids) { const s = this.acc.get(id); vec.push((s.r / s.n) / 10); }
    this.acc.clear();
    this.key = ids.join(',');
    this.lastVec = vec;
    this.tick(vec, now);
  }

  tick(vec, now) {
    if (this.recording) {
      const r = this.recording;
      if (this.store.key && this.store.key !== this.key) { this.store = { key: this.key, samples: {} }; }
      this.store.key = this.key;
      (this.store.samples[r.room] ||= []).push(vec);
      if (now >= r.until) { this.recording = null; save(this.store); r.onDone?.(); }
      this.emit();
      return;
    }
    if (!this.ready()) { this.result = { room: null, confidence: 0 }; return; }
    const probs = this.classify(vec);
    if (!probs) return;
    if (!this.scores) this.scores = probs;
    for (const k of Object.keys(probs)) this.scores[k] = (this.scores[k] ?? 0) * 0.65 + probs[k] * 0.35;
    let best = null, bp = -1;
    for (const [k, p] of Object.entries(this.scores)) if (p > bp) { bp = p; best = k; }
    const room = this.hyst.update(bp >= 0.45 ? best : this.hyst.room, now);
    this.result = { room, confidence: room ? this.scores[room] ?? 0 : 0 };
    this.emit();
  }

  // ---- training ----
  rooms() { return Object.keys(this.store.samples || {}); }
  counts() { return Object.fromEntries(Object.entries(this.store.samples || {}).map(([k, v]) => [k, v.length])); }
  ready() { return this.store.key === this.key && this.rooms().filter((r) => (this.store.samples[r] || []).length >= 10).length >= 2; }
  record(room, seconds, onDone) {
    if (!this.key) return false;
    if (this.store.key && this.store.key !== this.key) this.store = { key: this.key, samples: {} };
    this.store.samples[room] = []; // re-recording a room replaces it
    this.recording = { room, until: performance.now() + seconds * 1000, onDone };
    this.scores = null;
    this.emit();
    return true;
  }
  clear() { this.store = { key: '', samples: {} }; save(this.store); this.scores = null; this.result = { room: null, confidence: 0 }; this.hyst = new RoomHysteresis(1000, 2800); this.emit(); }

  // ---- kNN over z-scored features ----
  classify(vec) {
    const all = [];
    for (const [room, vs] of Object.entries(this.store.samples)) for (const v of vs) if (v.length === vec.length) all.push([room, v]);
    if (all.length < 10) return null;
    const d = vec.length, mean = new Array(d).fill(0), sd = new Array(d).fill(0);
    for (const [, v] of all) for (let i = 0; i < d; i++) mean[i] += v[i] / all.length;
    for (const [, v] of all) for (let i = 0; i < d; i++) sd[i] += (v[i] - mean[i]) ** 2 / all.length;
    for (let i = 0; i < d; i++) sd[i] = Math.sqrt(sd[i]) || 1;
    const dist = all.map(([room, v]) => {
      let s = 0; for (let i = 0; i < d; i++) s += ((v[i] - vec[i]) / sd[i]) ** 2;
      return [room, Math.sqrt(s)];
    }).sort((a, b) => a[1] - b[1]).slice(0, K);
    const w = {}; let tot = 0;
    for (const [room, dd] of dist) { const x = 1 / (0.15 + dd); w[room] = (w[room] || 0) + x; tot += x; }
    const out = {};
    for (const room of this.rooms()) out[room] = (w[room] || 0) / tot;
    return out;
  }
}

function load() { try { return JSON.parse(localStorage.getItem(FP_KEY)) || { key: '', samples: {} }; } catch { return { key: '', samples: {} }; } }
function save(s) { try { localStorage.setItem(FP_KEY, JSON.stringify(s)); } catch { /* ignore */ } }
