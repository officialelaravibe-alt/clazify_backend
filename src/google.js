'use strict';

const { OAuth2Client } = require('google-auth-library');

const client = new OAuth2Client();

/**
 * Verifies a Google ID token (signature, expiry, issuer) with Google's public keys.
 * audiences: list of allowed OAuth client IDs, or null to skip the audience check
 * (only used for the Apps Script attendance upload, whose client ID is created by Google).
 * Returns the token payload (email, email_verified, name, hd, aud, ...).
 */
async function verifyGoogleIdToken(idToken, audiences) {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: audiences && audiences.length ? audiences : undefined,
  });
  const payload = ticket.getPayload() || {};
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw new Error('wrong issuer');
  }
  return payload;
}

module.exports = { verifyGoogleIdToken };
