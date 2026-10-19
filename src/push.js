'use strict';

const { logError } = require('./security');

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Sends DATA-ONLY push messages.
 *
 * Why data-only: when a message carries a "notification" block and the app is in the
 * background, Android shows it by itself and the app's code never runs, so the lecture
 * was never saved on the phone. With data-only + high priority the app always receives
 * the payload, saves it, and builds the notification itself.
 *
 * messaging: firebase-admin messaging() instance, or null (then pushes are only counted).
 */
function createPush(messaging) {
  async function send(fcmToken, data) {
    if (!fcmToken) return 'no-token';
    if (!messaging) return 'disabled';

    const stringData = {};
    for (const [k, v] of Object.entries(data)) stringData[k] = v === undefined || v === null ? '' : String(v);

    try {
      await messaging.send({
        token: fcmToken,
        data: stringData,
        android: { priority: 'high', ttl: 24 * 60 * 60 * 1000 },
      });
      return 'sent';
    } catch (err) {
      if (err && INVALID_TOKEN_CODES.has(err.code)) return 'invalid-token';
      logError('push', err);
      return 'failed';
    }
  }
  return { send };
}

module.exports = { createPush };
