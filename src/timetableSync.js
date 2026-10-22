'use strict';

const crypto = require('crypto');
const { parseTimetablePdf, PARSER_VERSION } = require('./timetable');
const { nameKey, matchUser } = require('./names');
const { logError } = require('./security');

const MIN_CHECK_GAP_MS = 60 * 1000; // public refresh: at most one Drive check per minute
const KEEP_OLD = 2; // old timetables kept for history

/**
 * Keeps the team timetable in the database up to date with the newest PDF in the Drive folder.
 *
 * deps.db             pg Pool
 * deps.driveList()    -> [{ id, name, modifiedTime, createdTime }] newest first, or null when Drive fails
 * deps.driveDownload(id) -> Buffer (a checked PDF) or throws
 */
/**
 * Version of ONE trainer's timetable. The app sends it back as ?known=...; when it is the same,
 * the server answers "unchanged" and the phone keeps its local copy (no lectures are sent).
 */
function lectureVersion(meta, rows) {
  const lines = rows
    .map((e) => [e.day_of_week, (e.slots || []).join(','), e.course_code || '', e.venue || '', e.class_name || ''].join('|'))
    .sort();
  const head = meta ? `${meta.effective_from || ''}|${meta.file_name || ''}` : 'none';
  return crypto.createHash('sha256').update(head + '\n' + lines.join('\n')).digest('hex').slice(0, 32);
}

/** Lectures only (no file name): used to decide who gets a "timetable changed" push. */
function lecturesKey(rows) {
  return lectureVersion(null, rows);
}

function createTimetableSync({ db, driveList, driveDownload, onUpdated }) {
  let running = null; // promise of the refresh in progress
  let lastCheckAt = 0;
  let last = { state: 'never', at: null, message: '' };

  async function teamRows() {
    const r = await db.query('SELECT email, name, name_key FROM team_members WHERE active = TRUE ORDER BY email');
    return r.rows.map((m) => ({ ...m, name_key: m.name_key || nameKey(m.name) }));
  }

  function teamHash(team) {
    const text = `v${PARSER_VERSION}\n` + team.map((m) => `${m.email}:${m.name_key}`).join('\n');
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  async function activeRow() {
    const r = await db.query('SELECT * FROM timetables WHERE is_active = TRUE ORDER BY id DESC LIMIT 1');
    return r.rows[0] || null;
  }

  function effectiveFrom(fileName) {
    const m = /(\d{2})[.-](\d{2})[.-](\d{4})/.exec(fileName || '');
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  }

  async function doRefresh(force) {
    lastCheckAt = Date.now();
    const files = await driveList();
    if (!files) throw Object.assign(new Error('Google Drive unavailable'), { publicMessage: 'Google Drive unavailable' });
    if (!files.length) return { status: 'no-file' };
    const file = files[0]; // newest PDF in the folder
    const team = await teamRows();
    const hash = teamHash(team);
    const current = await activeRow();
    if (
      !force &&
      current &&
      current.drive_file_id === file.id &&
      current.drive_modified === (file.modifiedTime || '') &&
      current.team_hash === hash
    ) {
      return { status: 'unchanged', timetableId: current.id };
    }

    const pdf = await driveDownload(file.id);

    // Read every page header; parse only pages whose teacher is in the team.
    const taken = new Map(); // email -> teacher name on the PDF
    const teacherNames = [];
    const parsed = await parseTimetablePdf(pdf, (teacher) => {
      teacherNames.push(teacher);
      const m = matchUser(teacher, team.filter((t) => !taken.has(t.email)));
      if (!m) return null;
      taken.set(m.email, teacher);
      return m;
    });

    const lectures = [];
    for (const t of parsed.teachers) {
      for (const l of t.lectures) {
        lectures.push({ email: t.match.email, teacher: t.teacher, ...l });
      }
    }
    const unmatched = team.filter((m) => !taken.has(m.email)).map((m) => m.name);

    // Old lectures per trainer, to find out whose timetable really changed.
    const oldKeys = new Map();
    if (current) {
      const old = await db.query(
        'SELECT email, day_of_week, slots, course_code, venue, class_name FROM timetable_entries WHERE timetable_id = $1',
        [current.id]
      );
      const by = new Map();
      for (const r of old.rows) {
        if (!by.has(r.email)) by.set(r.email, []);
        by.get(r.email).push(r);
      }
      for (const [email, rows] of by) oldKeys.set(email, lecturesKey(rows));
    }

    const client = await db.connect();
    let id;
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO timetables (drive_file_id, file_name, drive_modified, effective_from, generated_on, page_count,
                                 team_hash, teacher_names, unmatched, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE) RETURNING id`,
        [
          file.id,
          String(file.name || '').slice(0, 255),
          file.modifiedTime || '',
          effectiveFrom(file.name),
          parsed.generated || '',
          parsed.pages,
          hash,
          JSON.stringify(teacherNames.slice(0, 1000)),
          JSON.stringify(unmatched),
        ]
      );
      id = ins.rows[0].id;
      for (const l of lectures) {
        await client.query(
          `INSERT INTO timetable_entries (timetable_id, email, teacher_name, day_of_week, slots, course_code, venue, class_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, l.email, l.teacher, l.day, l.slots, l.course, l.venue, l.className]
        );
      }
      await client.query('UPDATE timetables SET is_active = (id = $1)', [id]);
      await client.query(
        `DELETE FROM timetables WHERE id NOT IN (SELECT id FROM timetables ORDER BY id DESC LIMIT $1)`,
        [KEEP_OLD + 1]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    // Who must fetch again: anyone whose own lectures are different (added, changed or removed).
    const newBy = new Map();
    for (const l of lectures) {
      if (!newBy.has(l.email)) newBy.set(l.email, []);
      newBy.get(l.email).push({ day_of_week: l.day, slots: l.slots, course_code: l.course, venue: l.venue, class_name: l.className });
    }
    const changed = [];
    for (const email of new Set([...oldKeys.keys(), ...newBy.keys()])) {
      const after = newBy.has(email) ? lecturesKey(newBy.get(email)) : null;
      if (oldKeys.get(email) !== after) changed.push(email);
    }
    if (onUpdated && changed.length) {
      Promise.resolve()
        .then(() => onUpdated({ timetableId: id, changedEmails: changed, firstTimetable: !current }))
        .catch((err) => logError('timetable onUpdated', err));
    }

    return {
      status: 'updated',
      timetableId: id,
      trainersChanged: changed.length,
      fileName: file.name,
      pages: parsed.pages,
      teachersMatched: parsed.teachers.length,
      lectures: lectures.length,
      unmatched,
    };
  }

  /** Runs one refresh at a time; a second caller waits for the same result. */
  function refresh({ force = false } = {}) {
    if (!running) {
      running = doRefresh(force)
        .then((r) => {
          last = { state: 'ok', at: new Date().toISOString(), message: r.status };
          return r;
        })
        .catch((err) => {
          last = { state: 'error', at: new Date().toISOString(), message: err.publicMessage || 'Timetable could not be read' };
          logError('timetable refresh', err);
          throw err;
        })
        .finally(() => {
          running = null;
        });
    }
    return running;
  }

  /** For the public cron ping: starts a check in the background and answers at once. */
  function ping() {
    if (running) return 'busy';
    if (Date.now() - lastCheckAt < MIN_CHECK_GAP_MS) return 'recent';
    refresh().catch(() => {});
    return 'started';
  }

  return { refresh, ping, status: () => ({ ...last, running: !!running }), activeRow };
}

module.exports = { createTimetableSync, lectureVersion };
