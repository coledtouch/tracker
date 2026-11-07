#!/usr/bin/env node
// RuView bridge: lets the hosted dashboard (https://tracker.ciprari.ai) talk to a
// RuView sensing-server running on this machine.
//
// Why it exists: the sensing-server sends no CORS headers, and its /ws/sensing
// socket needs a single-use ticket minted with your bearer token. A page on
// another origin can do neither. This bridge runs on 127.0.0.1, keeps the token
// out of the browser, adds CORS for the dashboard origin only, and mints a
// fresh ticket for every WebSocket connection.
//
// Usage (Node 18+, no dependencies):
//   RUVIEW_API_TOKEN=<token> node ruview-bridge.mjs
// Options (env):
//   RUVIEW_URL      upstream server        default http://127.0.0.1:3000
//   BRIDGE_PORT     port to listen on      default 3100
//   BRIDGE_ORIGINS  allowed page origins   default https://tracker.ciprari.ai,http://localhost:8788

import http from 'node:http';
import net from 'node:net';

const UPSTREAM = new URL(process.env.RUVIEW_URL || 'http://127.0.0.1:3000');
const PORT = Number(process.env.BRIDGE_PORT || 3100);
const TOKEN = process.env.RUVIEW_API_TOKEN || '';
const ORIGINS = (process.env.BRIDGE_ORIGINS ||
  'https://tracker.ciprari.ai,http://localhost:8788,http://127.0.0.1:8788')
  .split(',').map((s) => s.trim()).filter(Boolean);

const upPort = Number(UPSTREAM.port || 80);
const upHost = UPSTREAM.hostname;

function corsHeaders(origin) {
  if (!origin || !ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function authHeaders() {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

async function mintTicket() {
  if (!TOKEN) return null;
  try {
    const r = await fetch(new URL('/api/v1/ws-ticket', UPSTREAM), {
      method: 'POST',
      headers: authHeaders(),
    });
    if (r.status === 404) return null; // older server without tickets
    if (!r.ok) {
      console.warn(`[bridge] ticket mint failed: HTTP ${r.status}`);
      return null;
    }
    return (await r.json()).ticket || null;
  } catch (e) {
    console.warn('[bridge] ticket mint error:', e.message);
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);
  if (origin && !cors['Access-Control-Allow-Origin']) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end(`origin ${origin} not allowed; add it to BRIDGE_ORIGINS`);
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  if (req.url === '/bridge/health') {
    let upstream = 'down';
    try {
      const r = await fetch(new URL('/health', UPSTREAM));
      upstream = r.ok ? 'ok' : `http ${r.status}`;
    } catch { /* down */ }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      bridge: 'ok', upstream, upstream_url: UPSTREAM.origin, token: Boolean(TOKEN),
    }));
  }

  // Plain HTTP proxy for REST calls, with the bearer token injected.
  const headers = { ...req.headers, ...authHeaders(), host: UPSTREAM.host };
  delete headers.origin;
  delete headers.referer;
  delete headers.cookie;
  const up = http.request(
    { host: upHost, port: upPort, method: req.method, path: req.url, headers },
    (upRes) => {
      const h = { ...upRes.headers, ...cors };
      res.writeHead(upRes.statusCode || 502, h);
      upRes.pipe(res);
    },
  );
  up.on('error', (e) => {
    res.writeHead(502, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream unreachable', detail: e.message }));
  });
  req.pipe(up);
});

// WebSocket upgrade: mint a ticket, then splice the raw sockets together.
server.on('upgrade', async (req, socket, head) => {
  const origin = req.headers.origin;
  if (origin && !ORIGINS.includes(origin)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const path = new URL(req.url, 'http://x');
  path.searchParams.delete('ticket');
  const ticket = await mintTicket();
  if (ticket) path.searchParams.set('ticket', ticket);
  const target = path.pathname + (path.search || '');

  const upstream = net.connect(upPort, upHost, () => {
    const lines = [`GET ${target} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (key === 'host' || key === 'origin' || key === 'cookie') continue;
      lines.push(`${k}: ${v}`);
    }
    lines.push(`Host: ${UPSTREAM.host}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => { socket.destroy(); upstream.destroy(); };
  upstream.on('error', (e) => {
    console.warn('[bridge] ws upstream error:', e.message);
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  socket.on('error', close);
  upstream.on('close', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] listening on http://127.0.0.1:${PORT}`);
  console.log(`[bridge] upstream ${UPSTREAM.origin}  token: ${TOKEN ? 'set' : 'NOT SET'}`);
  console.log(`[bridge] allowed origins: ${ORIGINS.join(', ')}`);
  if (!TOKEN) console.log('[bridge] warning: without RUVIEW_API_TOKEN, /api/v1/* calls and WS tickets will fail');
});
