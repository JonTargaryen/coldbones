# Coldbones

Upload an image or PDF and get AI visual analysis using a self-hosted LM Studio model.

## What changed on this branch

This branch removes AWS-specific infrastructure and deployment assets.

Removed:
- `infrastructure/`
- `lambdas/`
- `step-functions/`
- `scripts/deploy.sh`
- `scripts/build-ami.sh`
- `scripts/setup-model-server.sh`
- `scripts/spot-interrupt-handler.sh`

Coldbones now targets a local/self-hosted architecture.

## Current architecture (non-AWS)

- **Frontend**: React + Vite (`frontend/`)
- **Backend**: FastAPI (`backend/main.py`)
- **Inference**: LM Studio (OpenAI-compatible API)
- **Networking**:
  - Private mode: Tailscale/ZeroTier/WireGuard
  - Public mode: Cloudflare Tunnel in front of frontend/backend host

Recommended split for your setup:
- **5090 PC**: LM Studio model server (GPU)
- **Windows laptop**: frontend + backend host (24/7 app host)

Backend points to LM Studio over your tailnet IP, for example:

`LM_STUDIO_URL=http://100.126.27.56:1234/v1`

## Quick start (local)

### 1) Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env and set LM_STUDIO_URL / LM_STUDIO_MODEL
python main.py
```

### 2) Frontend

```bash
cd frontend
npm ci
npm run dev
```

Open http://localhost:5173

### 3) One-command dev

From repo root:

```bash
npm run dev
```

## Cheapest ways to host

### Option A (recommended): Home-hosted + Cloudflare Tunnel (near $0)

- Host frontend + backend on the unused Windows laptop (WSL2/Docker/native).
- Keep LM Studio on the 5090 PC.
- Connect laptop to 5090 over Tailscale private network.
- Expose only the laptop app via Cloudflare Tunnel.

Why this is best:
- No open inbound router ports.
- GPU endpoint stays private.
- Very low cost (domain + electricity only).

### Option B: Closed network only (private access)

- Keep everything private on Tailscale (or ZeroTier/Netbird/WireGuard).
- No public hostname.
- Best for internal/team use and strongest privacy posture.

### Option C: Small VPS reverse proxy + home backend

- Adds monthly cost and complexity.
- Useful only if home uplink is unstable or geo-latency is a concern.

## Squarespace domain + Cloudflare Tunnel

If your domain is registered at Squarespace, this is still straightforward.

### DNS flow

1. Add the domain to Cloudflare (change nameservers at Squarespace to Cloudflare nameservers).
2. Create a named tunnel and DNS route.
3. Point a subdomain (for example `app.yourdomain.com`) to the tunnel.

### Helper script

Use:

```bash
./scripts/publish-cloudflare.sh app.yourdomain.com http://localhost:5173 coldbones
```

Then run tunnel:

```bash
cloudflared tunnel --config ~/.cloudflared/config-coldbones.yml run
```

## Closed-network alternatives to Tailscale

- **Tailscale**: easiest UX, great for quick setup.
- **ZeroTier**: flexible virtual L2 networking.
- **Netbird**: WireGuard-based with central management.
- **WireGuard (self-managed)**: lowest overhead, most manual control.

If you already use Tailscale successfully, it remains the best default for this project.

## Environment variables

`backend/.env`:

```dotenv
LM_STUDIO_URL=http://100.126.27.56:1234/v1
LM_STUDIO_MODEL=
MAX_FILE_SIZE=20971520
MAX_INFERENCE_TOKENS=16384
PORT=8000
```

## Notes

- The frontend still supports optional queued/slow-mode UX where API endpoints provide job IDs.
- In pure local mode, backend returns results synchronously and frontend falls back gracefully.
- If you want a full local async queue later, add Redis + worker (RQ/Celery) behind `/api/status/{jobId}`.
