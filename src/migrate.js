'use strict';

const fs = require('fs');
const path = require('path');
const { nameKey } = require('./names');

// Upgrades for databases created by the first version of this backend.
const UPGRADES = [
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS name_key VARCHAR(100)',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS token_hash CHAR(64)',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS token_created_at TIMESTAMPTZ',
  'ALTER TABLE users ALTER COLUMN email DROP NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS users_token_hash_idx ON users(token_hash)',
  'CREATE INDEX IF NOT EXISTS users_name_key_idx ON users(name_key)',
  'CREATE INDEX IF NOT EXISTS users_team_idx ON users(team_id)',
  'ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS assigned_key VARCHAR(100)',
  'ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS user_id VARCHAR(100)',
  'ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
  'ALTER TABLE adjustments ADD COLUMN IF NOT EXISTS assigned_email VARCHAR(150)',
  'CREATE INDEX IF NOT EXISTS adjustments_date_idx ON adjustments(date)',
  'CREATE INDEX IF NOT EXISTS adjustments_user_idx ON adjustments(user_id)',
  // Old app versions saved made-up emails (name@university.edu). Only real work emails are kept.
  "UPDATE users SET email = NULL WHERE email IS NOT NULL AND LOWER(email) NOT LIKE '%@codequotient.com' AND LOWER(email) NOT LIKE '%@cqst.in'",
  'CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users(LOWER(email))',
  'CREATE INDEX IF NOT EXISTS sessions_email_idx ON sessions(email)',
  // Old device tokens (join-code sign-in) are no longer accepted.
  'UPDATE users SET token_hash = NULL WHERE token_hash IS NOT NULL',
];

async function migrate(pool) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db.sql'), 'utf8');
  await pool.query(schema);
  for (const sql of UPGRADES) {
    await pool.query(sql);
  }

  // Fill normalised names for rows created before name_key existed.
  const users = await pool.query('SELECT id, name FROM users WHERE name_key IS NULL');
  for (const u of users.rows) {
    await pool.query('UPDATE users SET name_key = $1 WHERE id = $2', [nameKey(u.name), u.id]);
  }
  const adj = await pool.query('SELECT id, assigned_to FROM adjustments WHERE assigned_key IS NULL');
  for (const a of adj.rows) {
    await pool.query('UPDATE adjustments SET assigned_key = $1 WHERE id = $2', [nameKey(a.assigned_to), a.id]);
  }
}

module.exports = { migrate };
