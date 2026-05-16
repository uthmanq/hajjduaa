# Hajj Duaa

A simple, anonymous platform where the Ummah shares duaa requests, and pilgrims
on Hajj carry them to the Haram.

- **No accounts.** Anyone can submit a duaa or fulfill one.
- **Priority for unfulfilled duaas.** Pilgrims always see the request that has
  been carried the fewest times (oldest first as a tiebreaker).
- **Anti-spam.** Cloudflare Turnstile captcha + rate limiting + per-session
  duplicate prevention.
- **Tiny footprint.** Single Node process, file-based SQLite, no build step.
  Runs comfortably on a $3.50/mo AWS Lightsail instance.

## Stack

| Layer        | Choice                              | Why                                  |
|--------------|-------------------------------------|--------------------------------------|
| Runtime      | Node.js 20 + Express                | Single language, single process      |
| Templates    | EJS (server-rendered)               | Zero build step, fast first paint    |
| Database     | SQLite via `better-sqlite3`         | One file, no separate DB server      |
| Styling      | Tailwind CSS via CDN                | Polished UI, no build pipeline       |
| Charts       | Chart.js via CDN                    | Stats page                           |
| Captcha      | Cloudflare Turnstile (free)         | Privacy-respecting, easy to set up   |
| Process mgr  | PM2 (or Docker)                     | Auto-restart, logs                   |

## Run locally

```bash
npm install
cp .env.example .env
npm start
# open http://localhost:3000
```

Captcha is **disabled** when `TURNSTILE_SECRET_KEY` is empty (handy for dev).
Set both keys before deploying to production.

## Deploy to AWS — cheapest path

The cheapest sustainable hosting is an **AWS Lightsail $3.50/mo instance**
(512 MB RAM, 1 TB transfer, fixed monthly cost — no surprise bills). Anything
under a few thousand requests/day fits comfortably.

### 1. Create the instance

1. Go to <https://lightsail.aws.amazon.com>, **Create instance**.
2. Pick **Linux/Unix → OS Only → Ubuntu 22.04 LTS**.
3. Pick the **$3.50/mo** plan (or $5/mo for 1 GB RAM).
4. Name it (e.g. `hajjduaa`) and **Create**.
5. Once running: **Networking** → attach a **static IP** (free while attached).
6. Under **Networking → IPv4 firewall**, allow ports **80** and **443**.

### 2. Point your domain at it

Add an `A` record at your DNS provider for `hajjduaa.yourdomain.com` pointing
at the static IP from step 1. Wait a few minutes for it to propagate.

### 3. Provision in one command

SSH into the instance (Lightsail console has a browser SSH button), then:

```bash
curl -fsSL https://raw.githubusercontent.com/uthmanq/hajjduaa/main/deploy/setup-lightsail.sh \
  | bash -s -- hajjduaa.yourdomain.com
```

That script:
- installs Node.js 20, nginx, PM2, certbot
- clones this repo to `/opt/hajjduaa`
- generates a `.env` with a random `COOKIE_SECRET`
- starts the app under PM2 with auto-start on boot
- wires nginx as a reverse proxy
- requests a Let's Encrypt TLS certificate

### 4. Add your Turnstile keys

1. Go to <https://dash.cloudflare.com> → **Turnstile** → **Add site**.
2. Add your domain. Copy the **Site Key** and **Secret Key**.
3. SSH in and edit `/opt/hajjduaa/.env`:
   ```
   TURNSTILE_SITE_KEY=0x...
   TURNSTILE_SECRET_KEY=0x...
   ```
4. `pm2 reload hajjduaa`

You're live.

## Deploy with Docker (alternative)

```bash
docker compose up -d --build
```

The `data/` directory is mounted as a volume so SQLite survives restarts.
Put nginx (or Caddy) in front for TLS.

## Routine ops

| Task                    | Command                                        |
|-------------------------|------------------------------------------------|
| View logs               | `pm2 logs hajjduaa`                            |
| Restart                 | `pm2 reload hajjduaa`                          |
| Update from git         | `cd /opt/hajjduaa && git pull && npm install --omit=dev && pm2 reload hajjduaa` |
| Backup database         | `cp /opt/hajjduaa/data/hajjduaa.db /tmp/backup-$(date +%F).db` |
| Export email subscribers| `sqlite3 data/hajjduaa.db "select email,role,created_at from email_subscribers"` |

For automated backups, set up a nightly cron that uploads
`/opt/hajjduaa/data/hajjduaa.db` to an S3 bucket (or just `scp` to your laptop).

## Architecture & data model

Three tables:

- **`duaa_requests`** — `(id, request_number, duaa_text, requester_country,
  requester_email, completion_count, created_at)`. The `completion_count`
  column is denormalized so prioritization is a single indexed lookup.
- **`duaa_completions`** — one row per pilgrim-fulfillment. A unique
  `(session_id, duaa_id)` index prevents the same pilgrim from completing the
  same duaa twice.
- **`pilgrim_sessions`** — anonymous server-side session per pilgrim, tracks
  country and how many they've completed (capped by `MAX_DUAAS_PER_SESSION`,
  default 20).

### Spam controls

| Control                      | Where                                    |
|------------------------------|------------------------------------------|
| Cloudflare Turnstile captcha | duaa submission, every 10th completion   |
| `express-rate-limit`         | 12/min per IP for forms, 60/min completes|
| Length cap on duaa text      | 1000 chars                               |
| Per-session duplicate prevention | unique index in DB                   |
| 20-duaa limit per pilgrim session | enforced in handler + UI            |

## Email notifications

Emails are **collected** but no actual mail is sent — we don't want to bake in
a paid dependency. To enable notifications:

1. Verify a sender in **AWS SES** (free for 62k emails/mo from EC2/Lightsail).
2. Add a `notify.js` module that calls `ses:SendEmail` and queue from
   `POST /hajj/complete/:id`.

Subscribers list is in the `email_subscribers` table (`role` is either
`requester` or `pilgrim`).

## Costs

| Item                    | Cost             |
|-------------------------|------------------|
| Lightsail $3.50/mo      | ~$3.50/month     |
| Domain                  | ~$10–15/year     |
| Let's Encrypt           | free             |
| Cloudflare Turnstile    | free             |
| **Total**               | **~$5/month**    |

## License

Choose your own license; nothing is hard-coded.
