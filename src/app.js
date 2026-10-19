'use strict';

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const { nameKey } = require('./names');
const { sha256Hex, newDeviceToken, bearerToken, logError } = require('./security');
const { BadRequest, str, int, isoDate, todayIn, addDays, daysBetween } = require('./util');

const TEAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@ -]{0,99}$/;
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,100}$/;
const EVENT_TYPES = new Set(['ST', 'EXAM', 'LEAVE']);
const TOPIC_STATUS = new Set(['Pending', 'In Progress', 'Completed']);
const MAX_PDF_BYTES = 20 * 1024 * 1024;

/**
 * Builds the Express app.
 * deps.db       pg Pool (or anything with query() and connect())
 * deps.push     { send(fcmToken, data) } from push.js
 * deps.config   secrets and settings (see server.js)
 * deps.fetch    fetch implementation (for NVIDIA / Google Drive); defaults to global fetch
 * deps.verifyGoogleIdToken(idToken, audiences|null) -> payload; see google.js
 */
function createApp({ db, push, config, fetch: fetchImpl = globalThis.fetch, verifyGoogleIdToken }) {
  const list = (v, fallback = '') =>
    String(v || fallback)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  const cfg = {
    googleClientIds: String(config.googleClientIds || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    allowedDomains: list(config.allowedDomains, 'codequotient.com,cqst.in'),
    managerEmails: list(config.managerEmails),
    timeZone: config.timeZone || 'Asia/Kolkata',
    nvidiaKey: config.nvidiaKey || '',
    nvidiaModel: config.nvidiaModel || 'meta/llama-4-maverick-17b-128e-instruct',
    driveKey: config.driveKey || '',
    driveFolderId: config.driveFolderId || '',
    rateLimits: config.rateLimits !== false,
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render puts one proxy in front of the app
  app.use(helmet());
  // No CORS middleware on purpose: no browser page calls this API
  // (Android app, LAS desktop app and Google Apps Script are not browsers).
  app.use(express.json({ limit: '1mb' }));

  const limiter = (windowMs, limit, keyGenerator) =>
    cfg.rateLimits
      ? rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator })
      : (req, res, next) => next();

  app.use('/api', limiter(15 * 60 * 1000, 600));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------- identity: Google account + allowed work domains ----------

  const EMAIL_RE = /^[a-z0-9._%+-]+@([a-z0-9-]+\.)+[a-z]{2,}$/;

  function normEmail(v) {
    return typeof v === 'string' ? v.trim().toLowerCase() : '';
  }

  function emailAllowed(email) {
    if (!EMAIL_RE.test(email)) return false;
    const domain = email.split('@')[1];
    return cfg.allowedDomains.includes(domain);
  }

  /**
   * Checks a Google ID token and returns the verified work email, or null.
   * audiences = null skips the client-ID check (Apps Script only).
   */
  async function verifiedEmail(idToken, audiences) {
    if (!idToken || typeof idToken !== 'string' || idToken.length > 4096) return null;
    let p;
    try {
      p = await verifyGoogleIdToken(idToken, audiences);
    } catch (err) {
      return null;
    }
    const email = normEmail(p && p.email);
    if (!p || p.email_verified !== true || !emailAllowed(email)) return null;
    // Google Workspace accounts carry "hd" (hosted domain); if present it must match too.
    if (p.hd && !cfg.allowedDomains.includes(String(p.hd).toLowerCase())) return null;
    return { email, name: typeof p.name === 'string' ? p.name.slice(0, 100) : '' };
  }

  // When MANAGER_EMAILS is set it is the final word: only those emails are managers.
  // Removing an email there ends that person's manager access at the next request.
  function isManagerEmail(email, member) {
    if (cfg.managerEmails.length) return cfg.managerEmails.includes(email);
    return !!member && member.role === 'MANAGER';
  }
  if (cfg.managerEmails.length) {
    db.query("UPDATE team_members SET role = 'TRAINER' WHERE role = 'MANAGER' AND NOT (email = ANY($1::text[]))", [cfg.managerEmails])
      .catch(() => {});
  }

  async function activeMember(email) {
    const r = await db.query('SELECT email, name, name_key, role FROM team_members WHERE email = $1 AND active = TRUE', [email]);
    return r.rows[0] || null;
  }

  async function newSession(email, kind) {
    const token = newDeviceToken();
    await db.query('INSERT INTO sessions (token_hash, email, kind) VALUES ($1, $2, $3)', [sha256Hex(token), email, kind]);
    return token;
  }

  async function sessionFor(req, kind) {
    const token = bearerToken(req);
    if (!token) return null;
    const r = await db.query(
      `SELECT s.email, s.kind FROM sessions s
       JOIN team_members t ON t.email = s.email AND t.active = TRUE
       WHERE s.token_hash = $1 AND s.kind = $2`,
      [sha256Hex(token), kind]
    );
    if (!r.rows[0]) return null;
    db.query('UPDATE sessions SET last_used_at = NOW() WHERE token_hash = $1', [sha256Hex(token)]).catch(() => {});
    return r.rows[0];
  }

  // Clazify app (trainer phone). Removing a trainer from the LAS team list ends access at once.
  async function requireDevice(req, res, next) {
    try {
      const token = bearerToken(req);
      const raw = token
        ? await db.query("SELECT email FROM sessions WHERE token_hash = $1 AND kind = 'app'", [sha256Hex(token)])
        : { rows: [] };
      if (!raw.rows[0]) return res.status(401).json({ error: 'Not signed in' });
      const s = await sessionFor(req, 'app');
      if (!s) {
        // Signed in with Google, but the manager has not added this email in LAS yet.
        return res.status(403).json({ error: 'Waiting for your manager to add your email in LAS.', pending: true });
      }
      const r = await db.query(
        'SELECT id, name, name_key, email, designation, team_id, role, fcm_token FROM users WHERE LOWER(email) = $1',
        [s.email]
      );
      if (!r.rows[0]) return res.status(401).json({ error: 'Not signed in' });
      req.user = r.rows[0];
      req.sessionKind = 'app';
      db.query('UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id = $1', [req.user.id]).catch(() => {});
      next();
    } catch (err) {
      next(err);
    }
  }

  // LAS desktop app, signed in by a manager.
  async function requireManager(req, res, next) {
    try {
      const s = await sessionFor(req, 'las');
      if (!s) return res.status(401).json({ error: 'Manager not signed in' });
      const m = await activeMember(s.email);
      if (!m || !isManagerEmail(s.email, m)) return res.status(403).json({ error: 'Only a manager can do this' });
      req.manager = m;
      next();
    } catch (err) {
      next(err);
    }
  }

  async function clearInvalidToken(userId) {
    await db.query('UPDATE users SET fcm_token = NULL WHERE id = $1', [userId]).catch(() => {});
  }

  async function pushTo(user, data) {
    if (!user || !user.fcm_token) return 'no-token';
    const result = await push.send(user.fcm_token, data);
    if (result === 'invalid-token') await clearInvalidToken(user.id);
    return result;
  }

  // ---------- health ----------

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // ---------- public pages (needed for the Google sign-in consent screen) ----------

  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.6;color:#1f2a16}
h1{color:#3d7a14}h2{margin-top:28px}a{color:#3d7a14}</style></head><body>${body}</body></html>`;

  app.get('/', (req, res) => {
    res.type('html').send(page('Clazify', `
<h1>Clazify</h1>
<p>Clazify is an internal Android app for CodeQuotient trainers. It shows each trainer's timetable,
syllabus progress and attendance, and notifies trainers when the manager assigns a proxy (substitute) lecture
from the CodeQuotient Lecture Adjustment System (LAS).</p>
<p>Only CodeQuotient staff with an <b>@codequotient.com</b> or <b>@cqst.in</b> Google account, added to the team by their manager, can sign in.</p>
<p><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of use</a></p>`));
  });

  app.get('/privacy', (req, res) => {
    res.type('html').send(page('Clazify – Privacy policy', `
<h1>Clazify – Privacy policy</h1>
<p>Last updated: 15 October 2026</p>
<h2>Who we are</h2>
<p>Clazify is an internal tool for CodeQuotient trainers and their managers. It is not offered to the public.</p>
<h2>What we collect</h2>
<ul>
<li><b>From Google sign-in:</b> your name and work email address. We do not receive your Google password and do not access Gmail, Drive, Contacts or any other Google data.</li>
<li><b>From the manager (LAS):</b> the team list (trainer names and work emails) and lecture adjustments (date, time, class, room, and the trainer who is absent and the one assigned).</li>
<li><b>From the app:</b> a push-notification token for your phone, and the syllabus progress you mark in the app.</li>
<li><b>Attendance:</b> class attendance counts sent from the institute's attendance sheet.</li>
</ul>
<h2>How we use it</h2>
<p>Only to run Clazify: to check that you are a team member, to show your lectures and proxy lectures, and to send you notifications about them.
We do not sell, rent or share this data with anyone, and we do not use it for advertising.</p>
<h2>Where it is stored</h2>
<p>On Clazify's server (hosted on Render, database on Supabase) and on your phone. Notifications are delivered through Firebase Cloud Messaging.
Connections are encrypted (HTTPS). Sign-in tokens are stored only as one-way hashes on the server and encrypted on the phone.</p>
<h2>How long we keep it</h2>
<p>As long as you are in the team. When the manager removes you, your access ends at once. Ask your manager to have your data deleted.</p>
<h2>Contact</h2>
<p>clazify.rd@gmail.com</p>`));
  });

  app.get('/terms', (req, res) => {
    res.type('html').send(page('Clazify – Terms of use', `
<h1>Clazify – Terms of use</h1>
<p>Clazify is provided for internal use by CodeQuotient staff only. Use it only for your own teaching work,
keep student data confidential, and do not share your account. Access can be removed by your manager at any time.</p>
<p><a href="/privacy">Privacy policy</a></p>`));
  });

  // ---------- sign-in with Google ----------

  /**
   * body: { idToken, client: 'app' | 'las', fcmToken? }
   * - app: the email must be in the manager's team list (LAS).
   * - las: the email must be a manager. The very first LAS sign-in becomes the manager when
   *   no manager exists yet (or MANAGER_EMAILS decides, when set).
   * Returns a session token ONCE; only its SHA-256 is stored.
   */
  app.post(
    '/api/auth/google',
    limiter(60 * 60 * 1000, 60), // campus Wi-Fi: many trainers share one IP
    wrap(async (req, res) => {
      if (!cfg.googleClientIds.length) return res.status(503).json({ error: 'Google sign-in is not configured on the server' });
      const body = req.body || {};
      const client = body.client === 'las' ? 'las' : body.client === 'app' ? 'app' : '';
      if (!client) throw new BadRequest('client must be "app" or "las"');
      const who = await verifiedEmail(body.idToken, cfg.googleClientIds);
      if (!who) {
        return res.status(401).json({
          error: `Sign in with your work Google account (${cfg.allowedDomains.map((d) => '@' + d).join(' or ')}).`,
        });
      }

      if (client === 'las') {
        let member = await activeMember(who.email);
        let isManager = isManagerEmail(who.email, member) && member && member.role === 'MANAGER';
        if (!isManager) {
          const listed = cfg.managerEmails.includes(who.email);
          const anyManager = await db.query("SELECT 1 FROM team_members WHERE role = 'MANAGER' AND active = TRUE LIMIT 1");
          const firstEver = !cfg.managerEmails.length && !anyManager.rows.length;
          if (listed || firstEver) {
            const name = (member && member.name) || who.name || who.email.split('@')[0];
            await db.query(
              `INSERT INTO team_members (email, name, name_key, role, active, updated_at)
               VALUES ($1, $2, $3, 'MANAGER', TRUE, CURRENT_TIMESTAMP)
               ON CONFLICT (email) DO UPDATE SET role = 'MANAGER', active = TRUE, updated_at = CURRENT_TIMESTAMP`,
              [who.email, name, nameKey(name)]
            );
            member = await activeMember(who.email);
            isManager = true;
            console.log(`[auth] ${listed ? 'listed' : 'first'} manager signed in from LAS`);
          }
        }
        if (!isManager) return res.status(403).json({ error: 'This account is not a manager.' });
        const token = await newSession(who.email, 'las');
        return res.json({ token, user: { email: who.email, name: member.name, role: 'MANAGER' } });
      }

      // client === 'app'
      // Not in the team list yet? The phone still gets its session, but it only starts working
      // when the manager adds this email in LAS (then the phone is told by a push).
      const member = await activeMember(who.email);
      const pending = !member;
      const displayName = member ? member.name : who.name || who.email.split('@')[0];
      const displayKey = member ? member.name_key || nameKey(member.name) : nameKey(displayName);
      const fcmToken = str(body.fcmToken, 'fcmToken', 4096) || null;
      const existing = await db.query('SELECT id, fcm_token FROM users WHERE LOWER(email) = $1', [who.email]);
      let id;
      if (existing.rows[0]) {
        id = existing.rows[0].id;
        const prev = existing.rows[0];
        const hadSession = await db.query("SELECT 1 FROM sessions WHERE email = $1 AND kind = 'app' LIMIT 1", [who.email]);
        // One phone per trainer: the old phone is signed out and told about it.
        if (hadSession.rows.length && prev.fcm_token && prev.fcm_token !== fcmToken) {
          await pushTo(prev, {
            type: 'SIGNED_OUT',
            title: 'Clazify: signed in on another phone',
            body: 'Your account was signed in on a different phone. If this was not you, tell your manager.',
          });
        }
        await db.query(
          `UPDATE users SET name = $2, name_key = $3, fcm_token = $4, last_active = CURRENT_TIMESTAMP WHERE id = $1`,
          [id, displayName, displayKey, fcmToken]
        );
      } else {
        id = crypto.randomUUID();
        await db.query(
          `INSERT INTO users (id, name, name_key, email, role, fcm_token, last_active)
           VALUES ($1, $2, $3, $4, 'MEMBER', $5, CURRENT_TIMESTAMP)`,
          [id, displayName, displayKey, who.email, fcmToken]
        );
      }
      await db.query("DELETE FROM sessions WHERE email = $1 AND kind = 'app'", [who.email]);
      const token = await newSession(who.email, 'app');

      // Adjustments that arrived before this trainer signed in.
      await linkPendingAdjustments();

      const me = await db.query('SELECT id, name, email, designation, team_id, role FROM users WHERE id = $1', [id]);
      res.json({ token, pending, user: publicUser(me.rows[0]) });
    })
  );

  app.post(
    '/api/auth/signout',
    wrap(async (req, res) => {
      const token = bearerToken(req);
      if (token) {
        const r = await db.query('DELETE FROM sessions WHERE token_hash = $1 RETURNING email, kind', [sha256Hex(token)]);
        if (r.rows[0] && r.rows[0].kind === 'app') {
          await db.query('UPDATE users SET fcm_token = NULL WHERE LOWER(email) = $1', [r.rows[0].email]);
        }
      }
      res.json({ success: true });
    })
  );

  app.get('/api/me', requireDevice, (req, res) => res.json({ user: publicUser(req.user) }));

  app.put(
    '/api/me',
    requireDevice,
    wrap(async (req, res) => {
      const body = req.body || {};
      const designation = body.designation !== undefined ? str(body.designation, 'designation', 100) : req.user.designation;
      const fcmToken = body.fcmToken !== undefined ? str(body.fcmToken, 'fcmToken', 4096) || null : req.user.fcm_token;
      let teamId = req.user.team_id;
      if (body.teamId !== undefined) {
        const t = str(body.teamId, 'teamId', 50);
        if (t && !TEAM_ID_RE.test(t)) throw new BadRequest('Invalid team code');
        teamId = t || null;
      }
      await db.query('UPDATE users SET designation = $2, fcm_token = $3, team_id = $4 WHERE id = $1', [
        req.user.id,
        designation,
        fcmToken,
        teamId,
      ]);
      const me = await db.query('SELECT id, name, email, designation, team_id, role FROM users WHERE id = $1', [req.user.id]);
      res.json({ user: publicUser(me.rows[0]) });
    })
  );

  function publicUser(u) {
    return {
      id: u.id,
      name: u.name,
      email: u.email || '',
      designation: u.designation || '',
      teamId: u.team_id || null,
      role: u.role || 'MEMBER',
    };
  }

  // ---------- team list (manager, from LAS) ----------

  async function teamView() {
    const r = await db.query(
      `SELECT t.email, t.name, t.role,
              EXISTS (SELECT 1 FROM sessions s WHERE s.email = t.email AND s.kind = 'app') AS signed_in
       FROM team_members t WHERE t.active = TRUE ORDER BY t.name ASC`
    );
    return r.rows.map((m) => ({ email: m.email, name: m.name, role: m.role, signedIn: m.signed_in }));
  }

  app.get('/api/team', requireManager, wrap(async (req, res) => res.json({ members: await teamView() })));

  /**
   * LAS sends the WHOLE team list: [{ email, name }]. People missing from the list lose access
   * (their sessions end). Managers stay managers; the calling manager can never remove himself.
   */
  app.put(
    '/api/team',
    requireManager,
    limiter(60 * 1000, 30),
    wrap(async (req, res) => {
      const members = (req.body || {}).members;
      if (!Array.isArray(members) || members.length > 500) throw new BadRequest('members must be an array (max 500)');
      const clean = new Map();
      const rejected = [];
      for (const m of members) {
        if (!m || typeof m !== 'object') throw new BadRequest('Invalid member');
        const email = normEmail(m.email);
        const name = str(m.name, 'name', 100);
        if (!email) continue; // members without email are simply not in Clazify yet
        if (!emailAllowed(email) || !name) {
          rejected.push(email.slice(0, 150));
          continue;
        }
        clean.set(email, name);
      }
      const before = await db.query('SELECT email FROM team_members WHERE active = TRUE');
      const wasActive = new Set(before.rows.map((r) => r.email));
      const client = await db.connect();
      let removed = [];
      try {
        await client.query('BEGIN');
        for (const [email, name] of clean) {
          await client.query(
            `INSERT INTO team_members (email, name, name_key, role, active, updated_at)
             VALUES ($1, $2, $3, 'TRAINER', TRUE, CURRENT_TIMESTAMP)
             ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, name_key = EXCLUDED.name_key,
               active = TRUE, updated_at = CURRENT_TIMESTAMP`,
            [email, name, nameKey(name)]
          );
          await client.query('UPDATE users SET name = $2, name_key = $3 WHERE LOWER(email) = $1', [email, name, nameKey(name)]);
        }
        const gone = await client.query(
          `UPDATE team_members SET active = FALSE, updated_at = CURRENT_TIMESTAMP
           WHERE active = TRUE AND role <> 'MANAGER' AND NOT (email = ANY($1::text[])) RETURNING email`,
          [[...clean.keys()]]
        );
        removed = gone.rows.map((r) => r.email);
        if (removed.length) {
          await client.query('DELETE FROM sessions WHERE email = ANY($1::text[])', [removed]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      await linkPendingAdjustments();
      // People who had already signed in from the app and were waiting: tell them they are in.
      const added = [...clean.keys()].filter((e) => !wasActive.has(e));
      if (added.length) {
        const waiting = await db.query(
          `SELECT u.id, u.fcm_token FROM users u
           WHERE LOWER(u.email) = ANY($1::text[])
             AND EXISTS (SELECT 1 FROM sessions s WHERE s.email = LOWER(u.email) AND s.kind = 'app')`,
          [added]
        );
        for (const u of waiting.rows) {
          await pushTo(u, {
            type: 'ACCESS_GRANTED',
            title: 'Clazify is ready',
            body: 'Your manager added you to the team. Proxy lectures from LAS will now reach this phone.',
          });
        }
      }
      res.json({ success: true, members: await teamView(), removed, rejected });
    })
  );

  function requireSameTeam(req, res, next) {
    if (!req.user.team_id || req.user.team_id !== req.params.teamId) {
      return res.status(403).json({ error: 'Not a member of this team' });
    }
    next();
  }

  // ---------- teams ----------

  app.get(
    '/api/teams/:teamId/members',
    requireDevice,
    requireSameTeam,
    wrap(async (req, res) => {
      const r = await db.query('SELECT id, name, designation, role FROM users WHERE team_id = $1 ORDER BY name ASC', [
        req.params.teamId,
      ]);
      // No emails, no push tokens.
      res.json(r.rows.map((u) => ({ trainerId: u.id, name: u.name, designation: u.designation || '', role: u.role || 'MEMBER' })));
    })
  );

  app.post(
    '/api/tasks',
    requireDevice,
    wrap(async (req, res) => {
      const b = req.body || {};
      const id = str(b.id, 'id', 100, { required: true });
      if (!ID_RE.test(id)) throw new BadRequest('Invalid id');
      const content = str(b.content, 'content', 2000, { required: true });
      const assignedTo = str(b.assignedTo, 'assignedTo', 100, { required: true });
      const dueDate = str(b.dueDate, 'dueDate', 50) || null;

      if (!req.user.team_id) return res.status(403).json({ error: 'Join a team first' });
      const target = await db.query('SELECT id, name, team_id, fcm_token FROM users WHERE id = $1', [assignedTo]);
      const assignee = target.rows[0];
      if (!assignee || assignee.team_id !== req.user.team_id) {
        return res.status(403).json({ error: 'You can only assign tasks inside your team' });
      }

      const result = await db.query(
        `INSERT INTO tasks (id, content, assigned_by, assigned_by_name, assigned_to, assigned_to_name, due_date, is_completed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, content, req.user.id, req.user.name, assignee.id, assignee.name, dueDate]
      );
      if (!result.rows[0]) return res.status(409).json({ error: 'Task already exists' });

      await pushTo(assignee, {
        type: 'TASK',
        title: 'New task assigned',
        body: `${req.user.name}: ${content.length > 60 ? `${content.slice(0, 60)}…` : content}`,
        serverId: id,
        content,
        assignedById: req.user.id,
        assignedByName: req.user.name,
      });
      res.json({ success: true });
    })
  );

  app.post(
    '/api/events',
    requireDevice,
    wrap(async (req, res) => {
      const b = req.body || {};
      const id = str(b.id, 'id', 100, { required: true });
      if (!ID_RE.test(id)) throw new BadRequest('Invalid id');
      const title = str(b.title, 'title', 150, { required: true });
      const description = str(b.description, 'description', 2000);
      const eventType = str(b.eventType, 'eventType', 20, { required: true });
      if (!EVENT_TYPES.has(eventType)) throw new BadRequest('Invalid eventType');
      const start = Number(b.startTimestamp);
      const end = Number(b.endTimestamp);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw new BadRequest('Invalid time range');
      if (!req.user.team_id) return res.status(403).json({ error: 'Join a team first' });

      const r = await db.query(
        `INSERT INTO events (id, title, description, event_type, start_timestamp, end_timestamp, trainer_id, trainer_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, title, description, eventType, start, end, req.user.id, req.user.name]
      );
      if (!r.rows[0]) return res.status(409).json({ error: 'Event already exists' });

      const team = await db.query('SELECT id, fcm_token FROM users WHERE team_id = $1 AND id <> $2', [
        req.user.team_id,
        req.user.id,
      ]);
      for (const member of team.rows) {
        await pushTo(member, {
          type: 'EVENT',
          title: `New team event: ${eventType}`,
          body: `${req.user.name} scheduled: ${title}`,
          eventId: id,
          eventTitle: title,
          description,
          eventType,
          startTimestamp: start,
          endTimestamp: end,
          trainerId: req.user.id,
          trainerName: req.user.name,
        });
      }
      res.json({ success: true });
    })
  );

  app.get(
    '/api/teams/:teamId/events',
    requireDevice,
    requireSameTeam,
    wrap(async (req, res) => {
      const r = await db.query(
        `SELECT e.* FROM events e INNER JOIN users u ON e.trainer_id = u.id
         WHERE u.team_id = $1 ORDER BY e.start_timestamp ASC LIMIT 500`,
        [req.params.teamId]
      );
      res.json(
        r.rows.map((e) => ({
          eventId: e.id,
          title: e.title,
          description: e.description || '',
          eventType: e.event_type,
          startTimestamp: Number(e.start_timestamp),
          endTimestamp: Number(e.end_timestamp),
          trainerId: e.trainer_id,
          trainerName: e.trainer_name || '',
        }))
      );
    })
  );

  // ---------- syllabus progress ----------

  app.post(
    '/api/execution/sync',
    requireDevice,
    wrap(async (req, res) => {
      const b = req.body || {};
      const subjectName = str(b.subjectName, 'subjectName', 100, { required: true });
      const lectureInterval = str(b.lectureInterval, 'lectureInterval', 50, { required: true });
      const subTopicLabel = str(b.subTopicLabel, 'subTopicLabel', 255, { required: true });
      const status = str(b.status, 'status', 20, { required: true });
      if (!TOPIC_STATUS.has(status)) throw new BadRequest('Invalid status');
      await db.query(
        `INSERT INTO syllabus_progress (user_id, subject_name, lecture_interval, sub_topic_label, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, subject_name, lecture_interval) DO UPDATE SET
           sub_topic_label = EXCLUDED.sub_topic_label, status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP`,
        [req.user.id, subjectName, lectureInterval, subTopicLabel, status]
      );
      res.json({ success: true });
    })
  );

  app.get(
    '/api/teams/:teamId/coverage/:subject',
    requireDevice,
    requireSameTeam,
    wrap(async (req, res) => {
      const subject = str(req.params.subject, 'subject', 100, { required: true });
      const r = await db.query(
        `SELECT sp.subject_name, sp.lecture_interval, sp.sub_topic_label, sp.status, sp.updated_at, u.name AS trainer_name
         FROM syllabus_progress sp INNER JOIN users u ON sp.user_id = u.id
         WHERE u.team_id = $1 AND sp.subject_name = $2 ORDER BY sp.lecture_interval ASC`,
        [req.params.teamId, subject]
      );
      res.json(r.rows);
    })
  );

  // ---------- attendance (Google Apps Script -> backend -> app) ----------

  // The Apps Script proves who runs it with ScriptApp.getIdentityToken() (a Google ID token).
  // The Google account must be a work email in the team list. No shared secret needed.
  async function requireAttendanceScript(req, res, next) {
    try {
      const who = await verifiedEmail(bearerToken(req), null);
      if (!who || !(await activeMember(who.email))) {
        return res.status(401).json({ error: 'Attendance must come from a team member\'s work Google account' });
      }
      req.scriptEmail = who.email;
      next();
    } catch (err) {
      next(err);
    }
  }

  app.post(
    '/api/attendance/update',
    limiter(60 * 1000, 30),
    requireAttendanceScript,
    wrap(async (req, res) => {
      const records = (req.body || {}).records;
      if (!Array.isArray(records) || records.length > 2000) throw new BadRequest('records must be an array (max 2000)');
      let count = 0;
      for (const item of records) {
        if (!item || typeof item !== 'object') continue;
        const subjectCode = str(item.subjectCode, 'subjectCode', 50);
        const batchSection = str(item.batchSection, 'batchSection', 50);
        const date = str(item.date, 'date', 20);
        if (!subjectCode || !batchSection || !date) continue;
        await db.query(
          `INSERT INTO attendance_records
             (subject_code, batch_section, date, lecture_time_slot, lecture1_attendance, lecture2_attendance, total_students, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
           ON CONFLICT (subject_code, batch_section, date) DO UPDATE SET
             lecture_time_slot = EXCLUDED.lecture_time_slot,
             lecture1_attendance = EXCLUDED.lecture1_attendance,
             lecture2_attendance = EXCLUDED.lecture2_attendance,
             total_students = EXCLUDED.total_students,
             updated_at = CURRENT_TIMESTAMP`,
          [
            subjectCode,
            batchSection,
            date,
            str(item.lectureTimeSlot, 'lectureTimeSlot', 50),
            int(item.lecture1Attendance, 'lecture1Attendance', { max: 1000 }),
            int(item.lecture2Attendance, 'lecture2Attendance', { max: 1000 }),
            int(item.totalStudents, 'totalStudents', { max: 1000 }),
          ]
        );
        count++;
      }
      res.json({ success: true, count });
    })
  );

  app.get(
    '/api/attendance',
    requireDevice,
    wrap(async (req, res) => {
      const date = str(req.query.date, 'date', 20);
      const subject = str(req.query.subject, 'subject', 50);
      const section = str(req.query.section, 'section', 50);
      let query =
        'SELECT subject_code, batch_section, date, lecture_time_slot, lecture1_attendance, lecture2_attendance, total_students FROM attendance_records WHERE 1=1';
      const params = [];
      if (date) {
        params.push(date);
        query += ` AND date = $${params.length}`;
      }
      if (subject) {
        params.push(subject);
        query += ` AND subject_code = $${params.length}`;
      }
      if (section) {
        params.push(section);
        query += ` AND batch_section = $${params.length}`;
      }
      query += ' ORDER BY date DESC, subject_code ASC LIMIT 2000';
      const r = await db.query(query, params);
      res.json(
        r.rows.map((row) => ({
          subjectCode: row.subject_code,
          batchSection: row.batch_section,
          date: row.date,
          lectureTimeSlot: row.lecture_time_slot || '',
          lecture1Attendance: row.lecture1_attendance || 0,
          lecture2Attendance: row.lecture2_attendance || 0,
          totalStudents: row.total_students || 0,
        }))
      );
    })
  );

  // ---------- lecture adjustments (LAS -> backend -> proxy trainer's phone) ----------

  function adjustmentPayload(row) {
    return {
      id: row.id,
      date: row.date,
      dayOfWeek: row.day_of_week || '',
      absentTrainer: row.absent_trainer || '',
      assignedTo: row.assigned_to || '',
      className: row.class_name || '',
      courseCode: row.course_code || '',
      venue: row.venue || '',
      slotLabel: row.slot_label || '',
      timeSchedule: row.time_schedule || '',
    };
  }

  const SAME_FIELDS = ['absent_trainer', 'class_name', 'course_code', 'venue', 'slot_label', 'time_schedule', 'user_id', 'day_of_week'];

  // Trainers who can receive lectures: signed in at least once AND still in the team list.
  async function recipients() {
    const r = await db.query(
      `SELECT u.id, u.name, u.name_key, LOWER(u.email) AS email, u.fcm_token
       FROM users u JOIN team_members t ON t.email = LOWER(u.email) AND t.active = TRUE`
    );
    return r.rows;
  }

  // Lectures go ONLY by the email from the LAS team list. No email = nobody gets it.
  function pickRecipient(assignedEmail, users) {
    if (!assignedEmail) return null;
    return users.find((u) => u.email === assignedEmail) || null;
  }

  async function linkPendingAdjustments() {
    const today = todayIn(cfg.timeZone);
    const pending = await db.query(
      'SELECT id, assigned_email FROM adjustments WHERE user_id IS NULL AND assigned_email IS NOT NULL AND date >= $1',
      [addDays(today, -1)]
    );
    if (!pending.rows.length) return;
    const users = await recipients();
    for (const row of pending.rows) {
      const u = pickRecipient(row.assigned_email, users);
      if (u) await db.query('UPDATE adjustments SET user_id = $1 WHERE id = $2', [u.id, row.id]);
    }
  }

  // LAS sends the WHOLE plan for one date each time. Rows for that date that are no longer
  // in the plan are removed and their trainer gets an "adjustment cancelled" push.
  app.post(
    '/api/adjustments',
    requireManager,
    limiter(60 * 1000, 60),
    wrap(async (req, res) => {
      const b = req.body || {};
      const date = isoDate(b.date, 'date');
      const dayOfWeek = str(b.dayOfWeek, 'dayOfWeek', 10);
      if (!Array.isArray(b.adjustments) || b.adjustments.length > 300) {
        throw new BadRequest('adjustments must be an array (max 300)');
      }

      const users = await recipients();

      const incoming = [];
      const seen = new Set();
      for (const item of b.adjustments) {
        if (!item || typeof item !== 'object') throw new BadRequest('Invalid adjustment item');
        const assignedTo = str(item.assignedTo ?? item.assigned_to, 'assignedTo', 100);
        if (!assignedTo || assignedTo === 'Unassigned') continue;
        const slotLabel = str(item.slotLabel ?? item.slot_label, 'slotLabel', 50);
        let id = str(item.id, 'id', 100);
        if (!id) id = `${date}_${assignedTo}_${slotLabel || 'slot'}`.slice(0, 100);
        if (!id.startsWith(date)) throw new BadRequest('Adjustment id must start with the plan date');
        if (seen.has(id)) continue;
        seen.add(id);
        const assignedEmail = normEmail(item.assignedEmail ?? item.assigned_email);
        if (assignedEmail && !emailAllowed(assignedEmail)) throw new BadRequest('assignedEmail must be a work email');
        const user = pickRecipient(assignedEmail, users);
        incoming.push({
          id,
          date,
          day_of_week: dayOfWeek,
          absent_trainer: str(item.absentTrainer ?? item.absent_trainer, 'absentTrainer', 100) || 'Faculty',
          assigned_to: assignedTo,
          assigned_key: nameKey(assignedTo),
          assigned_email: assignedEmail || null,
          user_id: user ? user.id : null,
          class_name: str(item.className ?? item.class_name, 'className', 100),
          course_code: str(item.courseCode ?? item.course_code, 'courseCode', 100),
          venue: str(item.venue, 'venue', 100),
          slot_label: slotLabel,
          time_schedule: str(item.timeSchedule ?? item.time_schedule, 'timeSchedule', 50),
        });
      }

      const toNotify = [];
      const cancelled = [];
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const existingRes = await client.query('SELECT * FROM adjustments WHERE date = $1 FOR UPDATE', [date]);
        const existing = new Map(existingRes.rows.map((r) => [r.id, r]));

        for (const row of incoming) {
          const old = existing.get(row.id);
          const changed = !old || SAME_FIELDS.some((f) => (old[f] || '') !== (row[f] || ''));
          await client.query(
            `INSERT INTO adjustments (id, date, day_of_week, absent_trainer, assigned_to, assigned_key, user_id,
               class_name, course_code, venue, slot_label, time_schedule, assigned_email, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CURRENT_TIMESTAMP)
             ON CONFLICT (id) DO UPDATE SET
               date = EXCLUDED.date, day_of_week = EXCLUDED.day_of_week, absent_trainer = EXCLUDED.absent_trainer,
               assigned_to = EXCLUDED.assigned_to, assigned_key = EXCLUDED.assigned_key, user_id = EXCLUDED.user_id,
               assigned_email = EXCLUDED.assigned_email,
               class_name = EXCLUDED.class_name, course_code = EXCLUDED.course_code, venue = EXCLUDED.venue,
               slot_label = EXCLUDED.slot_label, time_schedule = EXCLUDED.time_schedule, updated_at = CURRENT_TIMESTAMP`,
            [row.id, row.date, row.day_of_week, row.absent_trainer, row.assigned_to, row.assigned_key, row.user_id,
              row.class_name, row.course_code, row.venue, row.slot_label, row.time_schedule, row.assigned_email]
          );
          if (changed && row.user_id) toNotify.push(row);
          // Recipient changed on the same id: tell the old trainer it is cancelled.
          if (old && old.user_id && old.user_id !== row.user_id) cancelled.push(old);
          existing.delete(row.id);
        }
        for (const old of existing.values()) {
          await client.query('DELETE FROM adjustments WHERE id = $1', [old.id]);
          if (old.user_id) cancelled.push(old);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      const byId = new Map(users.map((u) => [u.id, u]));
      let notified = 0;
      for (const row of toNotify) {
        const p = adjustmentPayload(row);
        const result = await pushTo(byId.get(row.user_id), {
          type: 'ADJUSTMENT',
          title: 'Proxy lecture assigned',
          body: `${p.className || 'Class'}${p.courseCode ? ` (${p.courseCode})` : ''} · ${p.venue || 'Room TBA'} · ${p.timeSchedule || `Slot ${p.slotLabel}`} · for ${p.absentTrainer}`,
          ...p,
        });
        if (result === 'sent') notified++;
      }
      for (const old of cancelled) {
        const p = adjustmentPayload(old);
        await pushTo(byId.get(old.user_id), {
          type: 'ADJUSTMENT_CANCELLED',
          title: 'Proxy lecture cancelled',
          body: `${p.className || 'Class'} · ${p.timeSchedule || `Slot ${p.slotLabel}`} on ${p.date} is no longer assigned to you`,
          id: p.id,
          date: p.date,
        });
      }

      const unmatched = [...new Set(incoming.filter((r) => !r.user_id).map((r) => r.assigned_to))];
      res.json({ success: true, count: incoming.length, notified, cancelled: cancelled.length, unmatched });
    })
  );

  // The signed-in trainer's adjustments for a short date range (default: today + 6 days).
  app.get(
    '/api/adjustments/mine',
    requireDevice,
    wrap(async (req, res) => {
      const today = todayIn(cfg.timeZone);
      const from = req.query.from ? isoDate(req.query.from, 'from') : today;
      const to = req.query.to ? isoDate(req.query.to, 'to') : addDays(today, 6);
      const span = daysBetween(from, to);
      if (span < 0 || span > 31) throw new BadRequest('Date range must be 0-31 days');
      const r = await db.query(
        `SELECT * FROM adjustments WHERE date >= $1 AND date <= $2
           AND (user_id = $3 OR (user_id IS NULL AND assigned_email = $4))
         ORDER BY date ASC, slot_label ASC`,
        [from, to, req.user.id, (req.user.email || '').toLowerCase()]
      );
      res.json({ from, to, adjustments: r.rows.map(adjustmentPayload) });
    })
  );

  // ---------- AI topic summary (key stays on the server) ----------

  app.post(
    '/api/ai/summarize',
    requireDevice,
    limiter(10 * 60 * 1000, 120, (req) => `ai:${req.user.id}`),
    wrap(async (req, res) => {
      if (!cfg.nvidiaKey) return res.status(503).json({ error: 'AI is not configured on the server' });
      const text = str((req.body || {}).text, 'text', 4000, { required: true });
      const r = await fetchImpl('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.nvidiaKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.nvidiaModel,
          messages: [
            {
              role: 'system',
              content:
                'Summarize the following syllabus topic into a single, concise sentence (max 10 words). Focus only on the core action or subject. Do not include introductory phrases or quotation marks.',
            },
            { role: 'user', content: text },
          ],
          temperature: 0.3,
          max_tokens: 64,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) {
        console.error(`[ai] NVIDIA answered HTTP ${r.status}`);
        return res.status(502).json({ error: 'AI service unavailable' });
      }
      const data = await r.json();
      const summary = String(data?.choices?.[0]?.message?.content || '')
        .trim()
        .replace(/^"|"$/g, '')
        .slice(0, 300);
      res.json({ summary: summary || text.slice(0, 300) });
    })
  );

  // ---------- timetable PDFs from the shared Google Drive folder (key stays on the server) ----------

  async function driveList() {
    const q = `'${cfg.driveFolderId}' in parents and mimeType = 'application/pdf' and trashed = false`;
    const url =
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}` +
      `&orderBy=createdTime%20desc&pageSize=50&fields=files(id,name,mimeType)&key=${encodeURIComponent(cfg.driveKey)}`;
    const r = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      console.error(`[drive] list answered HTTP ${r.status}`);
      return null;
    }
    const data = await r.json();
    return (data.files || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType || 'application/pdf' }));
  }

  app.get(
    '/api/timetable/files',
    requireDevice,
    limiter(10 * 60 * 1000, 60, (req) => `drive:${req.user.id}`),
    wrap(async (req, res) => {
      if (!cfg.driveKey || !cfg.driveFolderId) return res.status(503).json({ error: 'Timetable folder is not configured' });
      const files = await driveList();
      if (!files) return res.status(502).json({ error: 'Google Drive unavailable' });
      res.json({ files });
    })
  );

  app.get(
    '/api/timetable/files/:fileId',
    requireDevice,
    limiter(10 * 60 * 1000, 30, (req) => `drivefile:${req.user.id}`),
    wrap(async (req, res) => {
      if (!cfg.driveKey || !cfg.driveFolderId) return res.status(503).json({ error: 'Timetable folder is not configured' });
      const fileId = req.params.fileId;
      if (!DRIVE_ID_RE.test(fileId)) throw new BadRequest('Invalid file id');
      // Only files that are inside the configured folder can be downloaded.
      const files = await driveList();
      if (!files) return res.status(502).json({ error: 'Google Drive unavailable' });
      if (!files.some((f) => f.id === fileId)) return res.status(404).json({ error: 'File not found' });

      const r = await fetchImpl(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${encodeURIComponent(cfg.driveKey)}`,
        { redirect: 'follow', signal: AbortSignal.timeout(60000) }
      );
      if (!r.ok) return res.status(502).json({ error: 'Google Drive unavailable' });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_PDF_BYTES) return res.status(413).json({ error: 'File too large' });
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return res.status(415).json({ error: 'Not a PDF' });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment');
      res.send(buf);
    })
  );

  // ---------- errors ----------

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err && err.status === 400 && err.publicMessage) return res.status(400).json({ error: err.publicMessage });
    logError(`${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Server error' });
  });

  return app;
}

module.exports = { createApp };
