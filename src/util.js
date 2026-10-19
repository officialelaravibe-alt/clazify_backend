'use strict';

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.publicMessage = message;
  }
}

// Reads an optional/required string field and enforces a maximum length.
function str(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadRequest(`Missing field: ${field}`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BadRequest(`Invalid field: ${field}`);
  }
  const s = String(value).trim();
  if (required && !s) throw new BadRequest(`Missing field: ${field}`);
  if (s.length > max) throw new BadRequest(`Field too long: ${field}`);
  return s;
}

function int(value, field, { min = 0, max = 100000 } = {}) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequest(`Invalid number: ${field}`);
  return n;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value, field, { required = true } = {}) {
  if (!value && !required) return '';
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw new BadRequest(`Invalid date (YYYY-MM-DD): ${field}`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new BadRequest(`Invalid date (YYYY-MM-DD): ${field}`);
  }
  return value;
}

// Today's date (YYYY-MM-DD) in the institute's time zone.
function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDays(isoDay, days) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

module.exports = { BadRequest, str, int, isoDate, todayIn, addDays, daysBetween };
