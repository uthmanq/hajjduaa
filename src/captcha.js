// Cloudflare Turnstile verification. Free, privacy-friendly. If TURNSTILE_SECRET_KEY
// is not set, verification is skipped — useful for local dev but DON'T do this in prod.
const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyCaptcha(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: 'missing-token' };

  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.append('remoteip', ip);

  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body });
    const data = await res.json();
    return { ok: !!data.success, raw: data };
  } catch (err) {
    return { ok: false, reason: 'verify-failed', error: err.message };
  }
}

module.exports = { verifyCaptcha };
