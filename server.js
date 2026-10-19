'use strict';

require('dotenv').config();
const dns = require('dns');
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');

const { Pool } = require('pg');
const { createApp } = require('./src/app');
const { createPush } = require('./src/push');
const { migrate } = require('./src/migrate');
const { verifyGoogleIdToken } = require('./src/google');
const { logError } = require('./src/security');

const env = process.env;
const port = Number(env.PORT) || 5000;

if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Stopping.');
  process.exit(1);
}

// ---- Database TLS ----
// Verified TLS when DATABASE_CA_CERT (PEM text from Supabase: Settings -> Database -> SSL certificate) is set.
// Without it the connection is still encrypted but the server certificate is not checked; a warning is logged.
function databaseSsl(url) {
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(url)) return false;
  if (env.DATABASE_CA_CERT) {
    return { ca: env.DATABASE_CA_CERT.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  }
  console.warn('[security] DATABASE_CA_CERT is not set: database TLS certificate is NOT verified. Set it on Render.');
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: databaseSsl(env.DATABASE_URL),
  max: 10,
  idleTimeoutMillis: 30000,
});
pool.on('error', (err) => logError('db pool', err));

// ---- Firebase (push notifications) ----
let messaging = null;
if (env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
    messaging = admin.messaging();
    console.log('Firebase Admin ready.');
  } catch (err) {
    console.error('Firebase Admin could not start (check FIREBASE_SERVICE_ACCOUNT).');
  }
} else {
  console.warn('FIREBASE_SERVICE_ACCOUNT is not set: push notifications are disabled.');
}

// No shared secrets: everybody signs in with a Google work account.
//   GOOGLE_CLIENT_IDS     OAuth client IDs of the Clazify app (web client) and LAS (desktop client), comma separated
//   ALLOWED_EMAIL_DOMAINS default: codequotient.com,cqst.in
//   MANAGER_EMAILS        optional; if empty, the first LAS sign-in becomes the manager
const config = {
  googleClientIds: env.GOOGLE_CLIENT_IDS,
  allowedDomains: env.ALLOWED_EMAIL_DOMAINS,
  managerEmails: env.MANAGER_EMAILS,
  timeZone: env.APP_TIMEZONE || 'Asia/Kolkata',
  nvidiaKey: env.NVIDIA_API_KEY,
  nvidiaModel: env.NVIDIA_MODEL,
  driveKey: env.GOOGLE_DRIVE_API_KEY,
  driveFolderId: env.GOOGLE_DRIVE_FOLDER_ID,
};

if (!config.googleClientIds) {
  console.warn('[auth] GOOGLE_CLIENT_IDS is not set: Google sign-in for the app and LAS is switched off.');
}

const app = createApp({ db: pool, push: createPush(messaging), config, verifyGoogleIdToken });

migrate(pool)
  .then(() => {
    app.listen(port, () => console.log(`Clazify backend listening on port ${port}`));
  })
  .catch((err) => {
    logError('startup migration', err);
    process.exit(1);
  });
