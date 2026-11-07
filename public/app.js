(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
    if (t.dataset.tab === 'live') resizeAll();
  }));
  document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
    const txt = b.previousElementSibling.textContent;
    try { await navigator.clipboard.writeText(txt); b.textContent = 'Copied'; } catch { b.textContent = 'Select & copy'; }
    setTimeout(() => (b.textContent = 'Copy'), 1500);
  }));

  // ---------- connection form ----------
  const DEFAULTS = { bridge: 'http://127.0.0.1:3100', direct: 'ws://localhost:3000/ws/sensing', demo: '' };
  const modeEl = $('mode'), urlEl = $('url');
  modeEl.value = store.get('ws.mode', 'demo');
  urlEl.value = store.get('ws.url.' + modeEl.value, DEFAULTS[modeEl.value]);
  function syncForm() {
    const m = modeEl.value;
    $('urlField').style.display = m === 'demo' ? 'none' : '';
    $('urlLabel').textContent = m === 'bridge' ? 'Bridge URL' : 'WebSocket URL';
    const hints = {
      bridge: 'Runs ruview-bridge.mjs on this computer. See Setup.',
      direct: 'Only works against servers without WebSocket auth. See Setup → Direct mode.',
      demo: 'Synthetic frames in the RuView sensing_update format. No hardware, no server.',
    };
    setHint(hints[m]);
  }
  modeEl.addEventListener('change', () => {
    urlEl.value = store.get('ws.url.' + modeEl.value, DEFAULTS[modeEl.value]);
    syncForm();
  });
  syncForm();

  function setHint(msg, err) { const h = $('hint'); h.textContent = msg || ''; h.classList.toggle('err', !!err); }
  function setConn(state, text) {
    const p = $('connPill'); p.className = 'pill ' + state; $('connText').textContent = text;
  }
  function setSource(kind) {
    const b = $('srcBadge');
    const map = { live: ['LIVE CSI', 'live'], sim: ['SERVER SIMULATED', 'sim'], demo: ['DEMO DATA', 'sim'], none: ['NO SOURCE', 'idle'] };
    const [t, c] = map[kind] || map.none; b.textContent = t; b.className = 'badge ' + c;
  }

  // ---------- log ----------
  function log(msg, cls) {
    const li = document.createElement('li');
    const t = document.createElement('time'); t.textContent = new Date().toLocaleTimeString();
    const s = document.createElement('span'); s.textContent = msg; if (cls) s.className = cls;
    li.append(t, s); const ol = $('log'); ol.prepend(li);
    while (ol.children.length > 200) ol.lastChild.remove();
  }
  $('clearLog').addEventListener('click', () => ($('log').textContent = ''));

  // ---------- state ----------
  const HIST = 240;
  const hist = { rssi: [], motion: [], breath: [] };
  const waterfall = []; // rows of amplitude arrays
  let lastField = null, total = 0, frameTimes = [], lastRawAt = 0, lastPresence = null;
  let ws = null, demoTimer = null, reconnectTimer = null, wantConnected = false, attempt = 0;

  function push(arr, v) { arr.push(v); if (arr.length > HIST) arr.shift(); }
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const fmt = (v, d = 0) => (v == null ? '—' : v.toFixed(d));

  function handleFrame(d) {
    if (!d || typeof d !== 'object') return;
    if (d.type && d.type !== 'sensing_update') { log('message: ' + d.type); return; }
    total++; const now = performance.now(); frameTimes.push(now);
    while (frameTimes.length && now - frameTimes[0] > 2000) frameTimes.shift();

    const src = d._simulated || d.source === 'simulated' || d.source === 'simulation' ? (mode === 'demo' ? 'demo' : 'sim') : 'live';
    setSource(src);

    const f = d.features || {};
    const c = d.classification || {};
    const nodes = Array.isArray(d.nodes) ? d.nodes : [];
    const vs = d.vital_signs || {};

    let rssi = num(f.mean_rssi);
    if (rssi == null && nodes.length) {
      const r = nodes.map((n) => num(n.rssi_dbm)).filter((x) => x != null);
      if (r.length) rssi = r.reduce((a, b) => a + b, 0) / r.length;
    }
    push(hist.rssi, rssi);
    push(hist.motion, num(f.motion_band_power));
    push(hist.breath, num(f.breathing_band_power));

    const present = typeof c.presence === 'boolean' ? c.presence : null;
    $('vPresence').textContent = present == null ? '—' : present ? 'Present' : 'Empty';
    $('tPresence').classList.toggle('present', present === true);
    $('vMotion').textContent = 'motion: ' + (c.motion_level ? String(c.motion_level).replace(/_/g, ' ') : '—');
    if (present != null && present !== lastPresence) {
      log(present ? 'presence detected' : 'space empty', present ? 'ok' : '');
      lastPresence = present;
    }

    const persons = num(d.estimated_persons) ?? (Array.isArray(d.persons) ? d.persons.length : null);
    $('vPersons').textContent = persons == null ? '—' : String(persons);
    $('vConf').textContent = 'confidence: ' + (num(c.confidence) == null ? '—' : Math.round(c.confidence * 100) + '%');

    const br = num(vs.breathing_bpm) ?? num(vs.breathing_rate_bpm) ?? num(vs.breathing_rate);
    const hr = num(vs.heart_rate_bpm) ?? num(vs.hr_proxy_bpm) ?? num(vs.heart_rate);
    $('vBreath').textContent = fmt(br, 1);
    $('vHeart').textContent = fmt(hr, 0);
    $('vRssi').textContent = fmt(rssi, 1);
    $('vNodes').textContent = 'nodes: ' + nodes.length;
    $('vTotal').textContent = 'total: ' + total;

    // waterfall from first node with amplitudes
    const amp = nodes.find((n) => Array.isArray(n.amplitude) && n.amplitude.length)?.amplitude;
    if (amp) { waterfall.push(amp.slice()); if (waterfall.length > 120) waterfall.shift(); $('wfMeta').textContent = amp.length + ' subcarriers'; }

    if (d.signal_field && Array.isArray(d.signal_field.values)) {
      lastField = d.signal_field;
      const g = lastField.grid_size || [];
      $('fieldMeta').textContent = (g[0] || '?') + ' × ' + (g[2] || g[1] || '?');
    }

    renderNodes(nodes);
    if (now - lastRawAt > 500) { $('raw').textContent = JSON.stringify(trimForRaw(d), null, 2); lastRawAt = now; }
    dirty = true;
  }

  function trimForRaw(d) {
    const copy = { ...d };
    if (copy.signal_field?.values) copy.signal_field = { ...copy.signal_field, values: `[${copy.signal_field.values.length} values]` };
    if (Array.isArray(copy.nodes)) copy.nodes = copy.nodes.map((n) => (Array.isArray(n.amplitude) && n.amplitude.length > 8 ? { ...n, amplitude: `[${n.amplitude.length} values]` } : n));
    return copy;
  }

  function renderNodes(nodes) {
    const tb = $('nodeRows');
    if (!nodes.length) { tb.innerHTML = '<tr><td colspan="5" class="muted">No nodes in frame</td></tr>'; return; }
    tb.textContent = '';
    for (const n of nodes) {
      const tr = document.createElement('tr');
      const s = n.sync || {};
      const cells = [
        n.node_id ?? '?',
        num(n.rssi_dbm) == null ? '—' : n.rssi_dbm.toFixed(1) + ' dBm',
        n.subcarrier_count ?? (Array.isArray(n.amplitude) ? n.amplitude.length : '—'),
        num(s.csi_fps_ema) == null ? '—' : s.csi_fps_ema.toFixed(1),
        n.sync ? (s.is_valid ? (s.is_leader ? 'leader' : 'ok') : 'invalid') : '—',
      ];
      for (const c of cells) { const td = document.createElement('td'); td.textContent = String(c); tr.append(td); }
      tb.append(tr);
    }
  }

  // ---------- connect ----------
  let mode = modeEl.value;
  $('connForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (wantConnected) { disconnect('stopped'); return; }
    mode = modeEl.value;
    store.set('ws.mode', mode);
    if (mode !== 'demo') store.set('ws.url.' + mode, urlEl.value.trim());
    connect();
  });

  function setBtn(on) { const b = $('connectBtn'); b.textContent = on ? 'Disconnect' : 'Connect'; b.classList.toggle('primary', !on); }

  async function connect() {
    hist.rssi.length = hist.motion.length = hist.breath.length = 0;
    waterfall.length = 0; lastField = null; total = 0; frameTimes = []; lastPresence = null; dirty = true;
    wantConnected = true; attempt = 0; setBtn(true); modeEl.disabled = true; urlEl.disabled = true;
    if (mode === 'demo') { startDemo(); return; }
    if (mode === 'bridge') {
      const base = urlEl.value.trim().replace(/\/+$/, '');
      setConn('wait', 'Checking bridge'); setHint('Contacting bridge…');
      try {
        const r = await fetch(base + '/bridge/health', { cache: 'no-store' });
        const h = await r.json();
        log(`bridge ok · upstream ${h.upstream} (${h.upstream_url}) · token ${h.token ? 'set' : 'missing'}`, h.upstream === 'ok' ? 'ok' : 'err');
        if (h.upstream !== 'ok') setHint(`Bridge is running but can't reach the sensing-server at ${h.upstream_url}. Is Docker running?`, true);
        else if (!h.token) setHint('Bridge has no RUVIEW_API_TOKEN set. The live stream will be refused. Set it in the same shell and restart the bridge.', true);
        else setHint('Bridge and server reachable.');
        probeStatus(base);
      } catch (e) {
        setHint(`Can't reach the bridge at ${base}. Start it with "node bridge/ruview-bridge.mjs", and allow local network access if Chrome asks.`, true);
        log('bridge unreachable: ' + e.message, 'err');
      }
      openWs(base.replace(/^http/, 'ws') + '/ws/sensing');
    } else {
      openWs(urlEl.value.trim());
    }
  }

  async function probeStatus(base) {
    try {
      const r = await fetch(base + '/api/v1/status', { cache: 'no-store' });
      if (!r.ok) { log('status: HTTP ' + r.status, 'err'); return; }
      const s = await r.json();
      const bits = ['source', 'source_state', 'version', 'engine_error_count'].filter((k) => s[k] != null).map((k) => `${k}=${s[k]}`);
      log('server status · ' + (bits.join(' · ') || 'ok'));
    } catch (e) { log('status probe failed: ' + e.message, 'err'); }
  }

  function openWs(url) {
    if (!wantConnected) return;
    if (location.protocol === 'https:' && url.startsWith('ws://') && !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(url)) {
      setHint('This https page can only open ws:// to localhost/127.0.0.1. Use wss:// or run the bridge on this machine.', true);
      setConn('err', 'Blocked'); return;
    }
    setConn('wait', attempt ? `Reconnecting (${attempt})` : 'Connecting');
    let opened = false;
    try { ws = new WebSocket(url); } catch (e) { log('ws error: ' + e.message, 'err'); scheduleReconnect(); return; }
    ws.onopen = () => { opened = true; attempt = 0; setConn('on', 'Connected'); log('stream open: ' + url.replace(/ticket=[^&]+/, 'ticket=…'), 'ok'); };
    ws.onmessage = (ev) => { try { handleFrame(JSON.parse(ev.data)); } catch { /* binary or bad json */ } };
    ws.onclose = (ev) => {
      ws = null;
      if (!wantConnected) return;
      log(`stream closed (code ${ev.code}${ev.reason ? ', ' + ev.reason : ''})`, 'err');
      if (!opened && mode === 'direct') setHint('Socket refused. The server probably requires a ticket; use the bridge, or see Setup → Direct mode.', true);
      setConn('err', 'Disconnected');
      scheduleReconnect();
    };
  }
  function scheduleReconnect() {
    if (!wantConnected) return;
    attempt++;
    const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4));
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => (mode === 'bridge' ? openWs(urlEl.value.trim().replace(/\/+$/, '').replace(/^http/, 'ws') + '/ws/sensing') : openWs(urlEl.value.trim())), delay);
  }
  function disconnect(why) {
    wantConnected = false; clearTimeout(reconnectTimer); clearInterval(demoTimer); demoTimer = null;
    if (ws) { ws.close(); ws = null; }
    setBtn(false); modeEl.disabled = false; urlEl.disabled = false;
    setConn('', 'Disconnected'); setSource('none'); log('disconnected' + (why ? ' (' + why + ')' : ''));
    syncForm();
  }

  // ---------- demo generator (sensing_update shape) ----------
  function startDemo() {
    setConn('on', 'Demo running'); setHint('Synthetic data. A simulated person walks in and out every ~40 s.');
    log('demo stream started', 'ok');
    const N = 56, G = 20; const t0 = performance.now() / 1000;
    demoTimer = setInterval(() => {
      const t = performance.now() / 1000 - t0;
      const presence = Math.sin(t * (2 * Math.PI / 40)) > -0.35;
      const walking = presence && Math.sin(t * 0.45) > 0.2;
      const motion = presence ? (walking ? 0.16 + Math.random() * 0.06 : 0.04 + Math.random() * 0.02) : 0.01 + Math.random() * 0.01;
      const breath = presence && !walking ? 0.07 + 0.02 * Math.sin(t * 1.6) : 0.01 + Math.random() * 0.005;
      const rssi = -47 + Math.sin(t * 0.3) * 1.5 + (presence ? -2 : 0) + (Math.random() - 0.5) * (walking ? 3 : 0.8);
      const bx = G / 2 + 6 * Math.sin(t * 0.25), bz = G / 2 + 5 * Math.cos(t * 0.19);
      const values = [];
      for (let z = 0; z < G; z++) for (let x = 0; x < G; x++) {
        let v = 0.08 + Math.random() * 0.04;
        if (presence) { const dd = (x - bx) ** 2 + (z - bz) ** 2; v += Math.exp(-dd / (walking ? 10 : 6)) * (0.5 + motion * 2); }
        values.push(Math.min(1, v));
      }
      const amplitude = Array.from({ length: N }, (_, i) => {
        const base = 12 + 6 * Math.sin(i / 7) + 3 * Math.cos(i / 3);
        return base + (presence ? Math.sin(t * (walking ? 5 : 1.6) + i / 4) * (walking ? 5 : 1.2) : 0) + (Math.random() - 0.5);
      });
      handleFrame({
        type: 'sensing_update', timestamp: Date.now() / 1000, source: 'simulated', _simulated: true,
        nodes: [{ node_id: 1, rssi_dbm: rssi, amplitude, subcarrier_count: N, sync: { is_valid: true, is_leader: true, csi_fps_ema: 9.8 } },
                { node_id: 2, rssi_dbm: rssi - 6, amplitude: [], subcarrier_count: N, sync: { is_valid: true, is_leader: false, csi_fps_ema: 9.6 } }],
        features: { mean_rssi: rssi, motion_band_power: motion, breathing_band_power: breath },
        classification: { presence, motion_level: !presence ? 'absent' : walking ? 'active' : 'present_still', confidence: presence ? 0.8 + Math.random() * 0.15 : 0.7 + Math.random() * 0.2 },
        estimated_persons: presence ? 1 : 0,
        vital_signs: presence && !walking ? { breathing_bpm: 14 + Math.sin(t * 0.1) * 1.5, hr_proxy_bpm: 68 + Math.sin(t * 0.07) * 4 } : {},
        signal_field: { grid_size: [G, 1, G], values },
      });
    }, 100);
  }

  // ---------- drawing ----------
  const cv = { h: $('cHistory'), f: $('cField'), w: $('cWaterfall') };
  let dirty = true;
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function fit(c) {
    const r = c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return { ctx: c.getContext('2d'), w, h, dpr };
  }
  function resizeAll() { dirty = true; }
  window.addEventListener('resize', resizeAll);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', resizeAll);

  function drawHistory() {
    const { ctx, w, h, dpr } = fit(cv.h);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { const y = Math.round((h * i) / 4) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    const series = [[hist.rssi, '--k1'], [hist.motion, '--k2'], [hist.breath, '--k3']];
    const pad = 8 * dpr;
    for (const [arr, col] of series) {
      const vals = arr.filter((v) => v != null); if (vals.length < 2) continue;
      let lo = Math.min(...vals), hi = Math.max(...vals); if (hi - lo < 1e-6) { hi += 0.5; lo -= 0.5; }
      ctx.strokeStyle = css(col); ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
      let started = false;
      arr.forEach((v, i) => {
        if (v == null) { started = false; return; }
        const x = (i / (HIST - 1)) * w; const y = h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
      });
      ctx.stroke();
    }
    if (!hist.rssi.length) {
      ctx.fillStyle = css('--muted'); ctx.font = `${13 * dpr}px IBM Plex Mono, monospace`; ctx.textAlign = 'center';
      ctx.fillText('Connect a source to see the signal', w / 2, h / 2);
    }
  }

  // perceptual-ish ramp: surface -> accent -> warm
  function ramp(v) {
    v = Math.max(0, Math.min(1, v));
    const stops = [[20, 34, 52], [24, 120, 160], [52, 211, 153], [246, 195, 91], [251, 138, 92]];
    const p = v * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), t = p - i;
    const a = stops[i], b = stops[i + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function drawField() {
    const { ctx, w, h } = fit(cv.f);
    ctx.clearRect(0, 0, w, h);
    if (!lastField) return;
    const g = lastField.grid_size || []; const gx = g[0] || Math.round(Math.sqrt(lastField.values.length)); const gz = g[2] || g[1] || gx;
    const img = ctx.createImageData(gx, gz);
    for (let i = 0; i < gx * gz; i++) { const [r, gg, b] = ramp(lastField.values[i] ?? 0); img.data.set([r, gg, b, 255], i * 4); }
    const off = document.createElement('canvas');
    off.width = gx; off.height = gz; off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.drawImage(off, 0, 0, w, h);
  }
  function drawWaterfall() {
    const { ctx, w, h } = fit(cv.w);
    ctx.clearRect(0, 0, w, h);
    if (!waterfall.length) {
      return;
    }
    const cols = waterfall[waterfall.length - 1].length, rows = waterfall.length;
    let lo = Infinity, hi = -Infinity;
    for (const r of waterfall) for (const v of r) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 1e-6) hi = lo + 1;
    const img = ctx.createImageData(cols, 120);
    for (let y = 0; y < 120; y++) {
      const row = waterfall[rows - 120 + y];
      for (let x = 0; x < cols; x++) {
        const [r, g, b] = row ? ramp(((row[x] ?? lo) - lo) / (hi - lo)) : [0, 0, 0];
        img.data.set([r, g, b, row ? 255 : 0], (y * cols + x) * 4);
      }
    }
    const off = document.createElement('canvas'); off.width = cols; off.height = 120;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(off, 0, 0, w, h);
  }

  function loop() {
    const now = performance.now();
    $('vFps').textContent = frameTimes.length ? (frameTimes.length / 2).toFixed(1) : '—';
    if (frameTimes.length && now - frameTimes[frameTimes.length - 1] > 2000) $('vFps').textContent = '0';
    if (dirty && $('tab-live').classList.contains('active')) {
      drawHistory(); drawField(); drawWaterfall(); dirty = false;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  log('ready · pick a source and press Connect');
})();
