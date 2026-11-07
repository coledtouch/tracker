# tracker — WiFi Sensing Bench

A static test dashboard for [RuView](https://github.com/ruvnet/ruview) WiFi CSI sensing on your own network.
Hosted at **https://tracker.ciprari.ai** (Cloudflare Workers static assets).

```
ESP32-S3 ──UDP 5005──▶ sensing-server (Docker :3000) ◀── bridge (127.0.0.1:3100) ◀── browser page
```

The page is static. It only talks to `127.0.0.1` on the machine you open it on; no sensing data goes to Cloudflare.

## Why the bridge

RuView's sensing-server sends no CORS headers, and its `/ws/sensing` socket needs a single-use
ticket minted with your `RUVIEW_API_TOKEN` (ADR-272). A page on another origin can't do either.
`bridge/ruview-bridge.mjs` (Node 18+, no dependencies) runs locally, holds the token, mints a ticket per
connection, and allows CORS only for the dashboard origin.

## Quick start (Windows PowerShell)

```powershell
$env:RUVIEW_API_TOKEN = -join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })
docker run --rm -e RUVIEW_API_TOKEN -e CSI_SOURCE=esp32 -e RUVIEW_UDP_ALLOW=192.168.1.0/24 `
  -p 127.0.0.1:3000:3000 -p 5005:5005/udp ruvnet/wifi-densepose:latest
# second window, same token:
node bridge/ruview-bridge.mjs
```

Open https://tracker.ciprari.ai, choose **Local bridge**, press **Connect**.
Without an ESP32, drop the `CSI_SOURCE`, UDP allow-list and UDP port flags to run the server on simulated data,
or choose **Demo data** in the page.

Bridge env options: `RUVIEW_URL` (default `http://127.0.0.1:3000`), `BRIDGE_PORT` (3100),
`BRIDGE_ORIGINS` (comma-separated allowed page origins).

## Deploy

```bash
npx wrangler@4 deploy
```

`wrangler.jsonc` serves `./public` and binds the custom domain `tracker.ciprari.ai`.

## Responsible use

Sense only spaces you control and tell the people in them. See the "About the research" tab for the
BFId identification risk (KIT, ACM CCS 2025).
