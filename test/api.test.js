'use strict';

// Run with: npm test   (starts a throw-away local PostgreSQL, no internet needed)
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const request = require('supertest');
const { Pool } = require('pg');

const { createApp } = require('../src/app');
const { migrate } = require('../src/migrate');
const { nameKey, matchUser } = require('../src/names');
const { redact } = require('../src/security');
const { todayIn, addDays } = require('../src/util');

const TZ = 'Asia/Kolkata';
const NVIDIA_FAKE = 'fake-nvidia-key-for-tests';
const APP_CLIENT = 'app-client.apps.googleusercontent.com';
const LAS_CLIENT = 'las-client.apps.googleusercontent.com';

let pg;
let pool;
let app;
const sent = [];
const fakePush = {
  async send(token, data) {
    sent.push({ token, data });
    return token === 'dead-token' ? 'invalid-token' : 'sent';
  },
};
const fetchCalls = [];
async function fakeFetch(url, opts) {
  fetchCalls.push({ url, opts });
  if (url.startsWith('https://integrate.api.nvidia.com')) {
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '"Short summary"' } }] }) };
  }
  if (url.includes('/drive/v3/files?')) {
    return { ok: true, status: 200, json: async () => ({ files: [{ id: 'FILEINFOLDER123', name: 'TT.pdf', mimeType: 'application/pdf' }] }) };
  }
  if (url.includes('/drive/v3/files/FILEINFOLDER123')) {
    const pdf = Buffer.from('%PDF-1.4 test');
    return { ok: true, status: 200, arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.length) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
}

/**
 * Fake Google: a test "ID token" looks like  g|<email>|<audience>|<verified 1/0>|<hd>
 * The real check (signature, expiry, issuer) is done by google-auth-library in src/google.js.
 */
async function fakeVerify(idToken, audiences) {
  const [g, email, aud, verified, hd] = String(idToken).split('|');
  if (g !== 'g') throw new Error('bad token');
  if (audiences && !audiences.includes(aud)) throw new Error('wrong audience');
  return { email, aud, email_verified: verified === '1', hd: hd || undefined, name: email.split('@')[0], iss: 'accounts.google.com' };
}
const gtok = (email, aud = APP_CLIENT, verified = '1', hd = '') => `g|${email}|${aud}|${verified}|${hd}`;

const today = todayIn(TZ);
const auth = (t) => ({ Authorization: `Bearer ${t}` });

before(async () => {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clazify-pg-')), 'data');
  pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'pw',
    port: 54329,
    persistent: false,
    initdbFlags: ['--lc-messages=C', '--locale=C'],
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('clazify');
  pool = new Pool({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'clazify' }); // throw-away local test DB

  // Start from the OLD schema with old data, to prove the upgrade works on the live database.
  const oldSchema = fs.readFileSync(path.join(__dirname, 'fixtures', 'old_db.sql'), 'utf8');
  await pool.query(oldSchema);
  await pool.query(
    "INSERT INTO users (id, name, email, team_id, fcm_token) VALUES ('old-1', 'Ms Old Trainer', 'oldtrainer@university.edu', 'T1', 'tok-old')"
  );
  await pool.query(
    "INSERT INTO adjustments (id, date, absent_trainer, assigned_to, class_name) VALUES ('2026-01-01_x_1', '2026-01-01', 'A', 'Mr X', 'C')"
  );
  await migrate(pool);
  await migrate(pool); // twice: must be repeatable

  app = createApp({
    db: pool,
    push: fakePush,
    fetch: fakeFetch,
    verifyGoogleIdToken: fakeVerify,
    config: {
      googleClientIds: `${APP_CLIENT},${LAS_CLIENT}`,
      timeZone: TZ,
      nvidiaKey: NVIDIA_FAKE,
      driveKey: 'AIzaTESTKEYTESTKEYTESTKEYTEST',
      driveFolderId: 'folder123',
      rateLimits: false,
    },
  });
});

after(async () => {
  if (pool) await pool.end();
  if (pg) await pg.stop();
});

const appSignIn = (email, fcmToken, opts = {}) =>
  request(app)
    .post('/api/auth/google')
    .send({ client: 'app', idToken: gtok(email, opts.aud || APP_CLIENT, opts.verified || '1', opts.hd || ''), fcmToken });
const lasSignIn = (email) => request(app).post('/api/auth/google').send({ client: 'las', idToken: gtok(email, LAS_CLIENT) });

const T = {}; // tokens

describe('names', () => {
  test('titles, dots and case are ignored', () => {
    assert.equal(nameKey('Mr. Baljeet  Singh'), 'baljeet singh');
    assert.equal(nameKey('Ms Aparna Sharma'), 'aparna sharma');
    assert.equal(nameKey('Mr Ritesh'), 'ritesh');
  });
  test('only one clear match is accepted', () => {
    const users = [
      { id: 1, name_key: 'aparna sharma' },
      { id: 2, name_key: 'ritesh kumar' },
      { id: 3, name_key: 'deepak shoran' },
      { id: 4, name_key: 'deepak verma' },
    ];
    assert.equal(matchUser('Ms Aparna Sharma', users).id, 1);
    assert.equal(matchUser('Mr Ritesh', users).id, 2);
    assert.equal(matchUser('Mr Deepak', users), null);
  });
});

describe('migration', () => {
  test('old made-up emails are cleared, old rows get normalised names', async () => {
    const u = await pool.query("SELECT name_key, email FROM users WHERE id = 'old-1'");
    assert.equal(u.rows[0].name_key, 'old trainer');
    assert.equal(u.rows[0].email, null);
    const a = await pool.query("SELECT assigned_key FROM adjustments WHERE id = '2026-01-01_x_1'");
    assert.equal(a.rows[0].assigned_key, 'x');
  });
});

describe('manager sign-in (LAS)', () => {
  test('outside domains and unverified emails are refused', async () => {
    assert.equal((await lasSignIn('someone@gmail.com')).status, 401);
    const r = await request(app).post('/api/auth/google').send({ client: 'las', idToken: gtok('boss@codequotient.com', LAS_CLIENT, '0') });
    assert.equal(r.status, 401);
    const hd = await request(app)
      .post('/api/auth/google')
      .send({ client: 'las', idToken: gtok('boss@codequotient.com', LAS_CLIENT, '1', 'otherschool.edu') });
    assert.equal(hd.status, 401);
    const wrongApp = await request(app).post('/api/auth/google').send({ client: 'las', idToken: gtok('boss@codequotient.com', 'evil-client') });
    assert.equal(wrongApp.status, 401);
  });
  test('first LAS sign-in becomes the manager; nobody else can after that', async () => {
    const r = await lasSignIn('Sandeep.Rana@CodeQuotient.com');
    assert.equal(r.status, 200);
    assert.equal(r.body.user.role, 'MANAGER');
    assert.equal(r.body.user.email, 'sandeep.rana@codequotient.com');
    T.las = r.body.token;
    const second = await lasSignIn('other@cqst.in');
    assert.equal(second.status, 403);
  });
  test('switched off when Google client IDs are not configured', async () => {
    const off = createApp({ db: pool, push: fakePush, verifyGoogleIdToken: fakeVerify, config: { rateLimits: false } });
    assert.equal((await request(off).post('/api/auth/google').send({ client: 'app', idToken: 'x' })).status, 503);
  });
});

describe('MANAGER_EMAILS is the final word', () => {
  test('a listed manager can sign in; removing the email ends manager access', async () => {
    const withList = createApp({
      db: pool, push: fakePush, verifyGoogleIdToken: fakeVerify,
      config: { googleClientIds: `${APP_CLIENT},${LAS_CLIENT}`, managerEmails: 'tester.dev@cqst.in', rateLimits: false },
    });
    const r = await request(withList).post('/api/auth/google').send({ client: 'las', idToken: gtok('tester.dev@cqst.in', LAS_CLIENT) });
    assert.equal(r.status, 200);
    assert.equal((await request(withList).get('/api/team').set(auth(r.body.token))).status, 200);
    // Same database, MANAGER_EMAILS changed (tester removed): access ends, role is demoted.
    const without = createApp({
      db: pool, push: fakePush, verifyGoogleIdToken: fakeVerify,
      config: { googleClientIds: `${APP_CLIENT},${LAS_CLIENT}`, managerEmails: 'sandeep.rana@codequotient.com', rateLimits: false },
    });
    assert.equal((await request(without).get('/api/team').set(auth(r.body.token))).status, 403);
    await new Promise((res) => setTimeout(res, 200));
    const role = await pool.query("SELECT role FROM team_members WHERE email = 'tester.dev@cqst.in'");
    assert.equal(role.rows[0].role, 'TRAINER');
    await pool.query("DELETE FROM team_members WHERE email = 'tester.dev@cqst.in'");
    await pool.query("DELETE FROM sessions WHERE email = 'tester.dev@cqst.in'");
  });
});

describe('team list from LAS', () => {
  test('only the manager can change it; only work emails are accepted', async () => {
    const body = {
      members: [
        { email: 'baljeet.singh@codequotient.com', name: 'Mr. Baljeet Singh' },
        { email: 'aparna@cqst.in', name: 'Ms Aparna Sharma' },
        { email: 'muskan@cqst.in', name: 'Ms Muskan Jaglan' },
        { email: 'friend@gmail.com', name: 'Outsider' },
        { name: 'Mr Ritesh' }, // no email yet: not in Clazify
      ],
    };
    assert.equal((await request(app).put('/api/team').send(body)).status, 401);
    const r = await request(app).put('/api/team').set(auth(T.las)).send(body);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.rejected, ['friend@gmail.com']);
    const emails = r.body.members.map((m) => m.email).sort();
    assert.deepEqual(emails, ['aparna@cqst.in', 'baljeet.singh@codequotient.com', 'muskan@cqst.in', 'sandeep.rana@codequotient.com']);
  });
});

describe('trainer sign-in (Clazify app)', () => {
  test('outside domain is refused', async () => {
    assert.equal((await appSignIn('baljeet.singh@gmail.com', 'fcm-x')).status, 401);
  });
  test('trainer can sign in BEFORE the manager adds the email; access starts when added', async () => {
    const r = await appSignIn('early.bird@cqst.in', 'fcm-early');
    assert.equal(r.status, 200);
    assert.equal(r.body.pending, true);
    const me = await request(app).get('/api/me').set(auth(r.body.token));
    assert.equal(me.status, 403); // waiting, not signed out
    assert.equal(me.body.pending, true);
    sent.length = 0;
    const team = await request(app).put('/api/team').set(auth(T.las)).send({
      members: [
        { email: 'baljeet.singh@codequotient.com', name: 'Mr. Baljeet Singh' },
        { email: 'aparna@cqst.in', name: 'Ms Aparna Sharma' },
        { email: 'muskan@cqst.in', name: 'Ms Muskan Jaglan' },
        { email: 'early.bird@cqst.in', name: 'Mr Early Bird' },
      ],
    });
    assert.equal(team.status, 200);
    assert.ok(team.body.members.find((m) => m.email === 'early.bird@cqst.in').signedIn); // matched automatically
    assert.ok(sent.some((x) => x.token === 'fcm-early' && x.data.type === 'ACCESS_GRANTED'));
    const me2 = await request(app).get('/api/me').set(auth(r.body.token));
    assert.equal(me2.status, 200);
    assert.equal(me2.body.user.name, 'Mr Early Bird'); // name now comes from the LAS list
  });
  test('team member signs in with Google; name comes from the LAS list', async () => {
    const b = await appSignIn('baljeet.singh@codequotient.com', 'fcm-baljeet-old');
    assert.equal(b.status, 200);
    assert.equal(b.body.user.name, 'Mr. Baljeet Singh');
    T.baljeetOld = b.body.token;
    const a = await appSignIn('aparna@cqst.in', 'fcm-aparna');
    T.aparna = a.body.token;
    T.aparnaId = a.body.user.id;
    const stored = await pool.query('SELECT token_hash FROM sessions WHERE email = $1', ['aparna@cqst.in']);
    assert.notEqual(stored.rows[0].token_hash, T.aparna); // only the hash is stored
  });
  test('new phone replaces the old one and warns it', async () => {
    sent.length = 0;
    const b2 = await appSignIn('baljeet.singh@codequotient.com', 'fcm-baljeet');
    T.baljeet = b2.body.token;
    T.baljeetId = b2.body.user.id;
    assert.equal((await request(app).get('/api/me').set(auth(T.baljeetOld))).status, 401);
    assert.equal((await request(app).get('/api/me').set(auth(T.baljeet))).status, 200);
    assert.ok(sent.some((s) => s.token === 'fcm-baljeet-old' && s.data.type === 'SIGNED_OUT'));
  });
  test('an app token cannot act as LAS, and the LAS token cannot act as the app', async () => {
    assert.equal((await request(app).post('/api/adjustments').set(auth(T.baljeet)).send({ date: today, adjustments: [] })).status, 401);
    assert.equal((await request(app).get('/api/me').set(auth(T.las))).status, 401);
  });
  test('reading data needs a signed-in phone', async () => {
    for (const url of ['/api/attendance', '/api/adjustments/mine', '/api/teams/T1/members', '/api/timetable/files']) {
      assert.equal((await request(app).get(url)).status, 401, url);
    }
  });
});

describe('adjustments: LAS -> phone', () => {
  const plan = (items) => ({ planId: 'adj_x', date: today, dayOfWeek: 'Thursday', adjustments: items });
  const item = (over = {}) => ({
    id: `${today}_Mr. Baljeet Singh_1`,
    absentTrainer: 'Mr Deepak Shoran',
    assignedTo: 'Mr. Baljeet Singh',
    assignedEmail: 'baljeet.singh@codequotient.com',
    className: 'BE-CSE-5A',
    courseCode: 'CS301',
    venue: 'Room 204',
    slotLabel: '1',
    timeSchedule: '9:30 - 10:20',
    ...over,
  });
  const post = (body) => request(app).post('/api/adjustments').set(auth(T.las)).send(body);

  test('matched by email: ONE data-only push; not-signed-in trainer reported', async () => {
    sent.length = 0;
    const r = await post(plan([item(), item({ id: `${today}_Ms Muskan Jaglan_2`, assignedTo: 'Ms Muskan Jaglan', assignedEmail: 'muskan@cqst.in', slotLabel: '2' })]));
    assert.equal(r.status, 200);
    assert.equal(r.body.notified, 1);
    assert.deepEqual(r.body.unmatched, ['Ms Muskan Jaglan']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].token, 'fcm-baljeet');
    assert.equal(sent[0].data.type, 'ADJUSTMENT');
    assert.equal(sent[0].data.notification, undefined);
  });
  test('same plan again: no spam; change: one update', async () => {
    sent.length = 0;
    await post(plan([item(), item({ id: `${today}_Ms Muskan Jaglan_2`, assignedTo: 'Ms Muskan Jaglan', assignedEmail: 'muskan@cqst.in', slotLabel: '2' })]));
    assert.equal(sent.length, 0);
    const r = await post(plan([item({ venue: 'Lab 3' }), item({ id: `${today}_Ms Muskan Jaglan_2`, assignedTo: 'Ms Muskan Jaglan', assignedEmail: 'muskan@cqst.in', slotLabel: '2' })]));
    assert.equal(r.body.notified, 1);
    assert.equal(sent[0].data.venue, 'Lab 3');
  });
  test('trainer sees only their own; later sign-in still gets the lecture', async () => {
    const mine = await request(app).get('/api/adjustments/mine').set(auth(T.baljeet));
    assert.equal(mine.body.adjustments.length, 1);
    assert.equal((await request(app).get('/api/adjustments/mine').set(auth(T.aparna))).body.adjustments.length, 0);
    const m = await appSignIn('muskan@cqst.in', 'fcm-muskan');
    const mm = await request(app).get('/api/adjustments/mine').set(auth(m.body.token));
    assert.equal(mm.body.adjustments.length, 1);
    assert.equal(mm.body.adjustments[0].slotLabel, '2');
  });
  test('moving the lecture to another trainer cancels it for the first one', async () => {
    sent.length = 0;
    const r = await post(plan([item({ id: `${today}_Ms Aparna Sharma_1`, assignedTo: 'Ms Aparna Sharma', assignedEmail: 'aparna@cqst.in' })]));
    assert.equal(r.body.cancelled, 2); // Baljeet's and Muskan's lectures left the plan
    assert.ok(sent.some((s) => s.token === 'fcm-baljeet' && s.data.type === 'ADJUSTMENT_CANCELLED'));
    assert.ok(sent.some((s) => s.token === 'fcm-aparna' && s.data.type === 'ADJUSTMENT'));
  });
  test('name-only items still match when the name fits exactly one trainer', async () => {
    sent.length = 0;
    await post(plan([item({ id: `${today}_Ms Aparna Sharma_1`, assignedTo: 'Ms Aparna Sharma', assignedEmail: undefined })]));
    const mine = await request(app).get('/api/adjustments/mine').set(auth(T.aparna));
    assert.equal(mine.body.adjustments.length, 1);
  });
  test('bad input is refused', async () => {
    for (const body of [
      { date: '15-10-2026', adjustments: [] },
      { date: today, adjustments: [item({ id: '2020-01-01_wrong_date' })] },
      { date: today, adjustments: [item({ assignedEmail: 'x@gmail.com' })] },
      { date: today, adjustments: [item({ className: 'x'.repeat(500) })] },
    ]) {
      assert.equal((await post(body)).status, 400, JSON.stringify(body).slice(0, 80));
    }
  });
});

describe('removing a trainer in LAS', () => {
  test('ends their access at once', async () => {
    const r = await request(app)
      .put('/api/team')
      .set(auth(T.las))
      .send({ members: [{ email: 'baljeet.singh@codequotient.com', name: 'Mr. Baljeet Singh' }, { email: 'aparna@cqst.in', name: 'Ms Aparna Sharma' }] });
    assert.deepEqual(r.body.removed.sort(), ['early.bird@cqst.in', 'muskan@cqst.in']);
    const s = await pool.query("SELECT 1 FROM sessions WHERE email = 'muskan@cqst.in'");
    assert.equal(s.rows.length, 0);
    const again = await appSignIn('muskan@cqst.in', 'fcm-muskan');
    assert.equal(again.body.pending, true); // can sign in, but has no access until added back
    assert.equal((await request(app).get('/api/adjustments/mine').set(auth(again.body.token))).status, 403);
    // the manager can never remove himself
    const mgr = await pool.query("SELECT active FROM team_members WHERE email = 'sandeep.rana@codequotient.com'");
    assert.equal(mgr.rows[0].active, true);
  });
});

describe('attendance from Google Apps Script', () => {
  const body = { records: [{ subjectCode: 'CS1', batchSection: '5A', date: '15/10/2026', lecture1Attendance: 40, totalStudents: 60 }] };
  test('accepted with the work Google identity of a team member (any client)', async () => {
    const r = await request(app).post('/api/attendance/update').set(auth(gtok('aparna@cqst.in', 'apps-script-client'))).send(body);
    assert.equal(r.status, 200);
    assert.equal(r.body.count, 1);
  });
  test('refused without identity, from outsiders, or from people not in the team', async () => {
    assert.equal((await request(app).post('/api/attendance/update').send(body)).status, 401);
    assert.equal((await request(app).post('/api/attendance/update').set(auth(gtok('x@gmail.com', 'a'))).send(body)).status, 401);
    assert.equal((await request(app).post('/api/attendance/update').set(auth(gtok('muskan@cqst.in', 'a'))).send(body)).status, 401);
  });
});

describe('teams, keys and errors', () => {
  test('members list has no emails or push tokens and is team-only', async () => {
    await request(app).put('/api/me').set(auth(T.baljeet)).send({ teamId: 'PA-5SEM' });
    await request(app).put('/api/me').set(auth(T.aparna)).send({ teamId: 'OTHER' });
    const r = await request(app).get('/api/teams/PA-5SEM/members').set(auth(T.baljeet));
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes('fcm') && !text.includes('@'));
    assert.equal((await request(app).get('/api/teams/PA-5SEM/members').set(auth(T.aparna))).status, 403);
  });
  test('tasks only inside your own team', async () => {
    const cross = await request(app).post('/api/tasks').set(auth(T.baljeet)).send({ id: 'task-1', content: 'Check papers', assignedTo: T.aparnaId });
    assert.equal(cross.status, 403);
  });
  test('AI summary via the server; key never reaches the phone', async () => {
    const r = await request(app).post('/api/ai/summarize').set(auth(T.baljeet)).send({ text: 'Long syllabus text' });
    assert.equal(r.body.summary, 'Short summary');
    assert.ok(!JSON.stringify(r.body).includes(NVIDIA_FAKE));
  });
  test('Drive: only files inside the folder', async () => {
    assert.equal((await request(app).get('/api/timetable/files/FILEINFOLDER123').set(auth(T.baljeet))).status, 200);
    assert.equal((await request(app).get('/api/timetable/files/SOMEOTHERFILE99').set(auth(T.baljeet))).status, 404);
  });
  test('sign out ends the session', async () => {
    await request(app).post('/api/auth/signout').set(auth(T.aparna));
    assert.equal((await request(app).get('/api/me').set(auth(T.aparna))).status, 401);
  });
  test('errors are generic; logs are redacted', async () => {
    const broken = createApp({
      db: { query: async () => { throw new Error('connect to ' + ['postgres://u', 'SECRETPW@host'].join(':') + ' failed'); } },
      push: fakePush,
      verifyGoogleIdToken: fakeVerify,
      config: { rateLimits: false },
    });
    const r = await request(broken).get('/api/me').set(auth('x'));
    assert.equal(r.status, 500);
    assert.ok(!JSON.stringify(r.body).includes('SECRETPW'));
    const out = redact(['postgres://user', 'SECRETPW@db'].join(':') + ' Bearer abc.def');
    assert.ok(!out.includes('SECRETPW') && !out.includes('abc.def'));
  });
  test('public home, privacy and terms pages exist (Google consent screen)', async () => {
    for (const url of ['/', '/privacy', '/terms']) {
      const r = await request(app).get(url);
      assert.equal(r.status, 200, url);
      assert.match(r.headers['content-type'], /html/);
    }
    assert.match((await request(app).get('/privacy')).text, /do not sell/);
  });
  test('security headers, no CORS, body limit', async () => {
    const r = await request(app).get('/health').set('Origin', 'https://evil.example');
    assert.equal(r.headers['x-powered-by'], undefined);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const big = await request(app)
      .post('/api/auth/google')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(1_200_000) }));
    assert.equal(big.status, 413);
  });
});
