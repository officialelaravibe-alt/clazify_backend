'use strict';

// Trainer name matching between LAS (e.g. "Mr. Baljeet Singh") and the names trainers
// type in the Clazify app (e.g. "Baljeet Singh").
//
// Rule: never guess. A name matches only when exactly one registered trainer fits.
// Ambiguous or unknown names are reported back to LAS as "unmatched".

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'maam', 'madam', 'er']);

function nameKey(raw) {
  if (typeof raw !== 'string') return '';
  const words = raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && TITLES.has(words[0])) words.shift();
  return words.join(' ');
}

/**
 * Find the one user that `assignedTo` refers to.
 * users: [{ id, name_key }]
 * 1. exact key match (only if exactly one)
 * 2. otherwise: same first word AND one name is the start of the other
 *    ("ritesh" vs "ritesh kumar"), only if exactly one candidate
 */
function matchUser(assignedTo, users) {
  const key = nameKey(assignedTo);
  if (!key) return null;

  const exact = users.filter((u) => u.name_key === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const words = key.split(' ');
  const candidates = users.filter((u) => {
    if (!u.name_key) return false;
    const other = u.name_key.split(' ');
    if (other[0] !== words[0]) return false;
    const shorter = other.length <= words.length ? other : words;
    const longer = other.length <= words.length ? words : other;
    return shorter.every((w, i) => longer[i] === w);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

module.exports = { nameKey, matchUser };
