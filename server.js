require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const db = require('./src/db');
const { COUNTRIES, nameFor } = require('./src/countries');
const { verifyCaptcha } = require('./src/captcha');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_DUAAS = parseInt(process.env.MAX_DUAAS_PER_SESSION || '20', 10);
const COOKIE_SECRET =
  process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': [
          "'self'",
          "'unsafe-inline'",
          'https://cdn.tailwindcss.com',
          'https://cdn.jsdelivr.net',
          'https://challenges.cloudflare.com'
        ],
        'frame-src': ["'self'", 'https://challenges.cloudflare.com'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"]
      }
    }
  })
);
app.use(compression());
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser(COOKIE_SECRET));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Make common values available to every template.
app.use((req, res, next) => {
  res.locals.turnstileSiteKey = TURNSTILE_SITE_KEY;
  res.locals.captchaEnabled = !!process.env.TURNSTILE_SECRET_KEY;
  res.locals.countries = COUNTRIES;
  res.locals.maxDuaas = MAX_DUAAS;
  res.locals.currentPath = req.path;
  next();
});

// ---- Helpers --------------------------------------------------------------

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    null;
}

// Avoid 0/O/I/1 to make the number easy to read aloud or transcribe.
const NUMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateRequestNumber() {
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (const b of bytes) s += NUMBER_ALPHABET[b % NUMBER_ALPHABET.length];
  return `HD-${s}`;
}

function isValidEmail(s) {
  if (!s) return false;
  if (s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function isValidCountryCode(code) {
  if (!code) return false;
  return COUNTRIES.some(c => c.code === code);
}

function getOrCreatePilgrimSession(req, res) {
  let id = req.signedCookies.pid;
  if (id && db.prepare('SELECT 1 FROM pilgrim_sessions WHERE session_id = ?').get(id)) {
    return id;
  }
  id = crypto.randomUUID();
  db.prepare('INSERT INTO pilgrim_sessions (session_id) VALUES (?)').run(id);
  res.cookie('pid', id, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30,
    secure: process.env.NODE_ENV === 'production'
  });
  return id;
}

function getPilgrimSession(req) {
  const id = req.signedCookies.pid;
  if (!id) return null;
  return db
    .prepare('SELECT * FROM pilgrim_sessions WHERE session_id = ?')
    .get(id);
}

const formLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false
});

// Tighter cap on the high-frequency action: marking duaas complete.
const completeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

// ---- Pages ----------------------------------------------------------------

app.get('/', (req, res) => {
  res.render('home');
});

// Request a duaa
app.get('/request', (req, res) => {
  res.render('request', { error: null, values: {} });
});

app.post('/request', formLimiter, async (req, res) => {
  const duaaText = (req.body.duaa_text || '').trim();
  const country = (req.body.country || '').trim() || null;
  const email = (req.body.email || '').trim() || null;
  const captchaToken = req.body['cf-turnstile-response'];

  const values = { duaa_text: duaaText, country, email };

  if (duaaText.length < 5) {
    return res
      .status(400)
      .render('request', { error: 'Please write a duaa (at least a few words).', values });
  }
  if (duaaText.length > 1000) {
    return res
      .status(400)
      .render('request', { error: 'Please keep your duaa under 1000 characters.', values });
  }
  if (country && !isValidCountryCode(country)) {
    return res
      .status(400)
      .render('request', { error: 'Please choose a valid country.', values });
  }
  if (email && !isValidEmail(email)) {
    return res
      .status(400)
      .render('request', { error: 'That email address looks invalid.', values });
  }

  const captcha = await verifyCaptcha(captchaToken, clientIp(req));
  if (!captcha.ok) {
    return res
      .status(400)
      .render('request', { error: 'Captcha failed. Please try again.', values });
  }

  let number;
  let attempts = 0;
  // Collisions are vanishingly rare for 6 chars from a 32-char alphabet
  // (~10^9 space), but still retry on the off-chance.
  while (attempts++ < 5) {
    number = generateRequestNumber();
    try {
      db.prepare(
        `INSERT INTO duaa_requests (request_number, duaa_text, requester_country, requester_email)
         VALUES (?, ?, ?, ?)`
      ).run(number, duaaText, country, email);
      break;
    } catch (err) {
      if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
      number = null;
    }
  }
  if (!number) {
    return res
      .status(500)
      .render('request', { error: 'Could not save your duaa. Please try again.', values });
  }

  if (email) {
    db.prepare(
      `INSERT OR IGNORE INTO email_subscribers (email, role) VALUES (?, 'requester')`
    ).run(email);
  }

  res.redirect(`/request/success/${encodeURIComponent(number)}`);
});

app.get('/request/success/:number', (req, res) => {
  const row = db
    .prepare('SELECT request_number FROM duaa_requests WHERE request_number = ?')
    .get(req.params.number);
  if (!row) return res.redirect('/request');
  res.render('request-success', { number: row.request_number });
});

// Search / view a duaa
app.get('/search', (req, res) => {
  const q = (req.query.number || '').trim().toUpperCase();
  if (q) return res.redirect(`/duaa/${encodeURIComponent(q)}`);
  res.render('search', { error: null });
});

app.get('/duaa/:number', (req, res) => {
  const number = req.params.number.toUpperCase();
  const duaa = db
    .prepare(
      `SELECT id, request_number, duaa_text, requester_country,
              completion_count, created_at
       FROM duaa_requests WHERE request_number = ?`
    )
    .get(number);

  if (!duaa) {
    return res.status(404).render('search', {
      error: `No duaa found with number ${number}.`
    });
  }

  const completions = db
    .prepare(
      `SELECT pilgrim_country, created_at
       FROM duaa_completions WHERE duaa_id = ?
       ORDER BY created_at DESC`
    )
    .all(duaa.id);

  res.render('view-duaa', { duaa, completions, nameFor });
});

// Hajj flow
app.get('/hajj', (req, res) => {
  res.render('hajj-tour');
});

app.get('/hajj/setup', (req, res) => {
  res.render('hajj-setup', { error: null, values: {} });
});

app.post('/hajj/setup', formLimiter, (req, res) => {
  const country = (req.body.country || '').trim();
  const email = (req.body.email || '').trim() || null;
  const agreedHonor = req.body.honor === 'on';

  if (!agreedHonor) {
    return res.status(400).render('hajj-setup', {
      error: 'Please confirm the honor pledge to continue.',
      values: { country, email }
    });
  }
  if (!isValidCountryCode(country)) {
    return res.status(400).render('hajj-setup', {
      error: 'Please choose your country.',
      values: { country, email }
    });
  }
  if (email && !isValidEmail(email)) {
    return res.status(400).render('hajj-setup', {
      error: 'That email address looks invalid.',
      values: { country, email }
    });
  }

  const id = getOrCreatePilgrimSession(req, res);
  db.prepare(
    'UPDATE pilgrim_sessions SET country = ?, email = ? WHERE session_id = ?'
  ).run(country, email, id);

  if (email) {
    db.prepare(
      `INSERT OR IGNORE INTO email_subscribers (email, role) VALUES (?, 'pilgrim')`
    ).run(email);
  }

  res.redirect('/hajj/fulfill');
});

// Pick the next duaa for this pilgrim: prefer the one with the fewest
// completions, breaking ties by oldest. Skip ones this session already
// completed.
function pickNextDuaaFor(sessionId) {
  return db
    .prepare(
      `SELECT id, request_number, duaa_text, requester_country, completion_count
       FROM duaa_requests
       WHERE id NOT IN (
         SELECT duaa_id FROM duaa_completions WHERE session_id = ?
       )
       ORDER BY completion_count ASC, created_at ASC
       LIMIT 1`
    )
    .get(sessionId);
}

app.get('/hajj/fulfill', (req, res) => {
  const sess = getPilgrimSession(req);
  if (!sess || !sess.country) return res.redirect('/hajj/setup');

  if (sess.completed >= MAX_DUAAS) {
    return res.render('hajj-done', { sess, reason: 'limit' });
  }

  const duaa = pickNextDuaaFor(sess.session_id);
  if (!duaa) return res.render('hajj-done', { sess, reason: 'empty' });

  res.render('hajj-fulfill', { duaa, sess, nameFor });
});

app.post('/hajj/complete/:id', completeLimiter, async (req, res) => {
  const sess = getPilgrimSession(req);
  if (!sess || !sess.country) {
    return res.status(400).json({ ok: false, error: 'no-session' });
  }
  if (sess.completed >= MAX_DUAAS) {
    return res.status(400).json({ ok: false, error: 'limit' });
  }

  const duaaId = parseInt(req.params.id, 10);
  if (!Number.isInteger(duaaId)) {
    return res.status(400).json({ ok: false, error: 'bad-id' });
  }

  // Captcha gate. Required only after the first completion to keep the UX
  // light, then re-required every 10 completions to deter botting.
  const requireCaptcha = sess.completed > 0 && sess.completed % 10 === 0;
  if (requireCaptcha) {
    const captcha = await verifyCaptcha(req.body.captcha, clientIp(req));
    if (!captcha.ok) {
      return res.status(400).json({ ok: false, error: 'captcha' });
    }
  }

  const tx = db.transaction((duaaId, sessionId, country) => {
    const duaa = db
      .prepare('SELECT id FROM duaa_requests WHERE id = ?')
      .get(duaaId);
    if (!duaa) return { ok: false, error: 'not-found' };

    try {
      db.prepare(
        `INSERT INTO duaa_completions (duaa_id, pilgrim_country, session_id)
         VALUES (?, ?, ?)`
      ).run(duaaId, country, sessionId);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        // Already completed this duaa in this session — ignore silently
        // and advance.
        return { ok: true, duplicate: true };
      }
      throw err;
    }
    db.prepare(
      'UPDATE duaa_requests SET completion_count = completion_count + 1 WHERE id = ?'
    ).run(duaaId);
    db.prepare(
      'UPDATE pilgrim_sessions SET completed = completed + 1 WHERE session_id = ?'
    ).run(sessionId);
    return { ok: true };
  });

  const result = tx(duaaId, sess.session_id, sess.country);
  if (!result.ok) return res.status(400).json(result);

  res.json({ ok: true, completed: sess.completed + 1, max: MAX_DUAAS });
});

// Stats / "beauty of the ummah"
app.get('/stats', (req, res) => {
  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM duaa_requests) AS requests,
         (SELECT COUNT(*) FROM duaa_completions) AS completions,
         (SELECT COUNT(DISTINCT requester_country) FROM duaa_requests
            WHERE requester_country IS NOT NULL) AS requester_countries,
         (SELECT COUNT(DISTINCT pilgrim_country) FROM duaa_completions
            WHERE pilgrim_country IS NOT NULL) AS pilgrim_countries,
         (SELECT COUNT(*) FROM pilgrim_sessions WHERE completed > 0) AS pilgrims,
         (SELECT COUNT(*) FROM duaa_requests WHERE completion_count = 0) AS unfulfilled,
         (SELECT COUNT(*) FROM duaa_requests WHERE completion_count > 0) AS fulfilled`
    )
    .get();

  const requestsByCountry = db
    .prepare(
      `SELECT requester_country AS code, COUNT(*) AS n
       FROM duaa_requests WHERE requester_country IS NOT NULL
       GROUP BY requester_country ORDER BY n DESC LIMIT 12`
    )
    .all();

  const completionsByCountry = db
    .prepare(
      `SELECT pilgrim_country AS code, COUNT(*) AS n
       FROM duaa_completions WHERE pilgrim_country IS NOT NULL
       GROUP BY pilgrim_country ORDER BY n DESC LIMIT 12`
    )
    .all();

  // Daily activity for the past 30 days, two series.
  const daily = db
    .prepare(
      `WITH days(d) AS (
         SELECT date('now', '-29 days')
         UNION ALL SELECT date(d, '+1 day') FROM days WHERE d < date('now')
       )
       SELECT
         d AS day,
         (SELECT COUNT(*) FROM duaa_requests WHERE date(created_at) = d) AS requests,
         (SELECT COUNT(*) FROM duaa_completions WHERE date(created_at) = d) AS completions
       FROM days`
    )
    .all();

  res.render('stats', {
    totals,
    requestsByCountry: requestsByCountry.map(r => ({ name: nameFor(r.code) || r.code, n: r.n })),
    completionsByCountry: completionsByCountry.map(r => ({ name: nameFor(r.code) || r.code, n: r.n })),
    daily
  });
});

// Health check for load balancers / uptime monitors.
app.get('/health', (req, res) => res.json({ ok: true }));

// 404
app.use((req, res) => {
  res.status(404).render('error', {
    code: 404,
    message: 'That page does not exist.'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', {
    code: 500,
    message: 'Something went wrong on our side.'
  });
});

app.listen(PORT, () => {
  console.log(`hajjduaa listening on http://localhost:${PORT}`);
  if (!process.env.TURNSTILE_SECRET_KEY) {
    console.warn('[warn] TURNSTILE_SECRET_KEY not set — captcha is DISABLED.');
  }
});
