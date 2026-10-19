'use strict';

const crypto = require('crypto');

const MIN_SECRET_LENGTH = 24;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// Constant-time comparison (hash both sides first so lengths always match).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function newDeviceToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const m = /^Bearer\s+(\S{1,512})$/i.exec(header.trim());
  return m ? m[1] : '';
}

// A configured server secret is only accepted when it is long enough.
function usableSecret(value) {
  return typeof value === 'string' && value.trim().length >= MIN_SECRET_LENGTH ? value.trim() : '';
}

// Removes things that look like secrets before text goes to logs.
function redact(text) {
  return String(text)
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1***@')
    .replace(/(Bearer\s+)\S+/gi, '$1***')
    .replace(/nvapi-[A-Za-z0-9_-]+/g, 'nvapi-***')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza***')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***PRIVATE KEY***');
}

function logError(where, err) {
  const msg = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
  console.error(`[${where}] ${redact(msg)}`);
}

module.exports = {
  MIN_SECRET_LENGTH,
  sha256Hex,
  safeEqual,
  newDeviceToken,
  bearerToken,
  usableSecret,
  redact,
  logError,
};
