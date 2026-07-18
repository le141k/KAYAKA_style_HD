# Reverse-Proxy Options for Production

The prod compose (`docker-compose.prod.yml`) intentionally keeps both application
services internal-only (`expose`, not `ports`).  
A reverse proxy must terminate HTTPS and forward traffic to:

| Service          | Internal address | Role                       |
| ---------------- | ---------------- | -------------------------- |
| Next.js frontend | `web:3000`       | All routes except `/api/*` |
| NestJS API       | `api:4000`       | `/api/*`                   |

Two ready-to-use configs live in this directory:

---

## Option 1 — Caddy (`infra/caddy/Caddyfile`) — **recommended**

**Why:** Zero cert management. Caddy fetches and auto-renews Let's Encrypt
certificates via ACME HTTP-01 out of the box. No manual cert provisioning, no
cron jobs.

**How to run:** do not start this override ad hoc. First complete the internal-only release with
`scripts/deploy-prod.sh`, document the approved edge topology/trusted proxy ranges, and enable the
reviewed override only through the HTTPS edge gate in `docs/DEPLOY.md`.

Set `DOMAIN=help.example.com` in `.env.prod`. The `{$DOMAIN}` placeholder is
expanded by Caddy at startup.

**Ports required on the host:** 80 (ACME challenge + redirect) and 443 (HTTPS + HTTP/3).

---

## Option 2 — nginx (`infra/nginx/nginx.conf`)

**Why:** More familiar ops tooling, granular control, compatible with an
existing Certbot/Let's Encrypt workflow.

**How to run** — provision certs first (e.g. `certbot certonly --webroot`),
place them under `infra/nginx/certs/`, then add an `nginx` service to a
compose override (full snippet in the nginx.conf comments).

Template the `${DOMAIN}` placeholder before mounting:

```bash
export DOMAIN=help.example.com
envsubst '${DOMAIN}' < infra/nginx/nginx.conf > /tmp/nginx-rendered.conf
# mount /tmp/nginx-rendered.conf into the container instead
```

---

## Why headers matter for this app

The API enforces two security-sensitive behaviours that the proxy must not
break:

1. **CORS** — `TELECOM_HD_PUBLIC_URL` is the allowed origin. The proxy must
   forward the original `Host` header (`proxy_set_header Host $host` / Caddy
   does this automatically) so the API's CORS middleware sees the real domain.

2. **HttpOnly session cookies** — Authentication relies on `Set-Cookie` headers
   with `HttpOnly; Secure; SameSite=Lax`. Neither proxy strips `Set-Cookie`
   or `Cookie` by default; do **not** add any header-hiding rules for those
   headers.

Both configs also forward `X-Forwarded-For`, `X-Real-IP`, and
`X-Forwarded-Proto` so the API can log real client IPs and correctly detect
that requests arrive over HTTPS (relevant to cookie `Secure` flag enforcement
and rate-limiting).
