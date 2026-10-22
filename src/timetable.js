'use strict';

/**
 * Timetable PDF parser (aSc "Teacher wise" timetables).
 *
 * Plan (keeps memory and time low on a small server):
 *   1. For every page read ONLY the text, and from it the teacher name in the header.
 *   2. Only pages whose teacher is in the team are parsed fully.
 *   3. Cells are found from the table's drawn lines, so merged cells (2-slot lectures,
 *      4-slot labs) are detected exactly: no line between two columns = one lecture.
 *
 * Nothing here runs scripts from the PDF: eval is off, fonts are not loaded.
 */

const DAYS = new Set(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
const PARSER_VERSION = 1;

// pdf.js operator codes (stable in pdf.js 4.x)
const OP_MOVE_TO = 13;
const OP_LINE_TO = 14;
const OP_RECTANGLE = 19;

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function openPdf(buffer) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice();
  return pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  }).promise;
}

// ---------------- text ----------------

/** Text items in "top-down" page coordinates: { s, x, top, w, h, base } */
async function pageWords(page) {
  const height = page.view[3] - page.view[1];
  const tc = await page.getTextContent();
  const out = [];
  for (const it of tc.items) {
    const s = typeof it.str === 'string' ? it.str.trim() : '';
    if (!s) continue;
    const h = Math.abs(it.height || it.transform[3] || 0);
    const x = it.transform[4];
    const base = height - it.transform[5]; // baseline, measured from the top
    out.push({ s, x, w: it.width || 0, h, base, top: base - h });
  }
  return out;
}

/** Groups items into lines (same baseline), left to right. Returns [{ text, items, top, base, h }]. */
function toLines(items) {
  const sorted = [...items].sort((a, b) => a.base - b.base || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    const tol = Math.max(1, Math.min(it.h, last ? last.h : it.h) * 0.4);
    if (last && Math.abs(last.base - it.base) <= tol) {
      last.items.push(it);
      last.h = Math.max(last.h, it.h);
    } else {
      lines.push({ items: [it], base: it.base, h: it.h });
    }
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    for (const it of l.items) {
      if (prevEnd !== null && it.x - prevEnd > Math.max(0.8, it.h * 0.15)) text += ' ';
      text += it.s;
      prevEnd = it.x + it.w;
    }
    l.text = text.replace(/\s+/g, ' ').trim();
    l.top = Math.min(...l.items.map((i) => i.top));
  }
  return lines;
}

/** Teacher name written in the page header ("Teacher Ms Asha Verma"), or ''. */
function teacherFromWords(words) {
  for (const line of toLines(words)) {
    const m = /^Teacher\s+(.+)$/.exec(line.text);
    if (m) return m[1].trim().slice(0, 100);
  }
  return '';
}

// ---------------- lines of the table ----------------

function mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** Straight horizontal / vertical segments drawn on the page, in top-down coordinates. */
async function pageSegments(page, pdfjs) {
  const height = page.view[3] - page.view[1];
  const ol = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const H = [];
  const V = [];
  const pt = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], height - (ctm[1] * x + ctm[3] * y + ctm[5])];
  const add = (p, q) => {
    if (Math.abs(p[1] - q[1]) < 0.6) H.push({ y: (p[1] + q[1]) / 2, x0: Math.min(p[0], q[0]), x1: Math.max(p[0], q[0]) });
    else if (Math.abs(p[0] - q[0]) < 0.6) V.push({ x: (p[0] + q[0]) / 2, y0: Math.min(p[1], q[1]), y1: Math.max(p[1], q[1]) });
  };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    const args = ol.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.constructPath) {
      const [ops, coords] = args;
      let k = 0;
      let cur = null;
      for (const op of ops) {
        if (op === OP_MOVE_TO) {
          cur = pt(coords[k], coords[k + 1]);
          k += 2;
        } else if (op === OP_LINE_TO) {
          const p = pt(coords[k], coords[k + 1]);
          k += 2;
          if (cur) add(cur, p);
          cur = p;
        } else if (op === OP_RECTANGLE) {
          const [x, y, w, h] = coords.slice(k, k + 4);
          k += 4;
          const a = pt(x, y);
          const b = pt(x + w, y);
          const c = pt(x + w, y + h);
          const d = pt(x, y + h);
          add(a, b);
          add(b, c);
          add(c, d);
          add(d, a);
          cur = null;
        } else {
          // curves etc.: skip their coordinates
          k += { 15: 6, 16: 4, 17: 4 }[op] || 0;
        }
      }
    }
  }
  return { H, V };
}

// ---------------- grid ----------------

const EPS = 1.2;

function cluster(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) {
    if (out.length && v - out[out.length - 1].max <= EPS) {
      const c = out[out.length - 1];
      c.max = v;
      c.sum += v;
      c.n += 1;
    } else out.push({ max: v, sum: v, n: 1 });
  }
  return out.map((c) => c.sum / c.n);
}

function joinClassLines(lines) {
  let s = '';
  for (const t of lines) {
    if (!s) s = t;
    else if (/^[A-Za-z0-9]{1,2}$/.test(t) && /[A-Za-z0-9-]$/.test(s)) s += t; // "BE-CSE-5" + "F"
    else if (/^[a-z]/.test(t) && /[A-Za-z]$/.test(s)) s += t; // word broken over two lines: "Pharmace" + "utics"
    else s += ' ' + t;
  }
  return s;
}

/**
 * Parses one teacher page into lectures:
 * [{ day, slots: [n..], course, venue, className }]
 */
async function parseGrid(page, words, pdfjs) {
  const { H, V } = await pageSegments(page, pdfjs);
  if (!H.length || !V.length) return [];

  // Slot columns: the header row has the numbers 1..8, one per column.
  const boundaries = cluster(V.filter((v) => v.y1 - v.y0 > 5).map((v) => v.x));
  const numberWords = words.filter((w) => /^\d{1,2}$/.test(w.s));
  const columns = [];
  for (let n = 1; n <= 12; n++) {
    const cands = numberWords.filter((w) => Number(w.s) === n).sort((a, b) => a.top - b.top);
    if (!cands.length) break;
    const w = cands[0];
    const cx = w.x + w.w / 2;
    const left = Math.max(...boundaries.filter((b) => b < cx));
    const right = Math.min(...boundaries.filter((b) => b > cx));
    if (!Number.isFinite(left) || !Number.isFinite(right)) break;
    columns.push({ slot: n, left, right, cx: (left + right) / 2, headTop: w.top });
  }
  if (!columns.length) return [];
  const gridLeft = columns[0].left;
  const headerBottom = Math.min(
    ...H.filter((h) => h.y > columns[0].headTop && h.x0 <= gridLeft + EPS && h.x1 >= columns[columns.length - 1].right - EPS).map((h) => h.y)
  );

  const covers = {
    v: (v, y) => v.y0 - EPS <= y && y <= v.y1 + EPS,
    h: (h, x) => h.x0 - EPS <= x && x <= h.x1 + EPS,
  };

  // Day bands from the day labels in the first column.
  const bands = [];
  for (const w of words) {
    if (!DAYS.has(w.s) || w.x + w.w > gridLeft + EPS) continue;
    const cx = w.x + w.w / 2;
    const cy = w.top + w.h / 2;
    const above = H.filter((h) => h.y <= cy && covers.h(h, cx)).map((h) => h.y);
    const below = H.filter((h) => h.y >= cy && covers.h(h, cx)).map((h) => h.y);
    if (!above.length || !below.length) continue;
    bands.push({ day: w.s, top: Math.max(...above), bottom: Math.min(...below) });
  }
  if (!bands.length) return [];

  // Put every word of the grid into the cell drawn around it.
  const cells = new Map();
  for (const w of words) {
    const cx = w.x + w.w / 2;
    const cy = w.top + w.h / 2;
    if (cx < gridLeft || cy < headerBottom) continue;
    const lefts = V.filter((v) => v.x <= cx && v.x >= gridLeft - EPS && covers.v(v, cy)).map((v) => v.x);
    const rights = V.filter((v) => v.x >= cx && covers.v(v, cy)).map((v) => v.x);
    if (!lefts.length || !rights.length) continue;
    const left = Math.max(...lefts);
    const right = Math.min(...rights);
    // Horizontal lines are drawn per column, so test them just inside the cell's left edge.
    const px = left + 2 * EPS;
    const tops = H.filter((h) => h.y <= cy && h.x0 <= px && px <= h.x1).map((h) => h.y);
    const bottoms = H.filter((h) => h.y >= cy && h.x0 <= px && px <= h.x1).map((h) => h.y);
    const top = tops.length ? Math.max(...tops) : null;
    const bottom = bottoms.length ? Math.min(...bottoms) : null;
    if (top === null || bottom === null) continue;
    const key = [left, top, right, bottom].map((n) => n.toFixed(1)).join(',');
    if (!cells.has(key)) cells.set(key, { left, top, right, bottom, words: [] });
    cells.get(key).words.push(w);
  }

  const lectures = [];
  for (const c of cells.values()) {
    const cy = (c.top + c.bottom) / 2;
    const band = bands.find((b) => b.top - EPS <= cy && cy <= b.bottom + EPS);
    if (!band) continue;
    const slots = columns.filter((col) => col.cx > c.left && col.cx < c.right).map((col) => col.slot);
    if (!slots.length) continue;
    const lines = toLines(c.words).map((l) => l.text).filter(Boolean);
    if (!lines.length) continue;
    const head = lines[0].split(' ');
    const venue = head.length > 1 ? head[head.length - 1] : '';
    const course = head.length > 1 ? head.slice(0, -1).join(' ') : head[0];
    lectures.push({
      day: band.day,
      slots,
      course: course.slice(0, 100),
      venue: venue.slice(0, 100),
      className: joinClassLines(lines.slice(1)).slice(0, 100),
    });
  }
  const dayOrder = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  lectures.sort((a, b) => dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day) || a.slots[0] - b.slots[0]);
  return lectures;
}

/**
 * Parses a timetable PDF.
 *   wanted(teacherName) -> any truthy value to parse that page (e.g. the team member), or null to skip it.
 * Returns { pages, generated, teachers: [{ page, teacher, match, lectures }], skipped }
 */
async function parseTimetablePdf(buffer, wanted, { maxPages = 400 } = {}) {
  const pdfjs = await loadPdfjs();
  const doc = await openPdf(buffer);
  try {
    const pages = Math.min(doc.numPages, maxPages);
    const teachers = [];
    let skipped = 0;
    let generated = '';
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      try {
        const words = await pageWords(page);
        const teacher = teacherFromWords(words);
        if (!generated) {
          const g = words.map((w) => w.s).join(' ').match(/generated:\s*(\d{2})-(\d{2})-(\d{4})/);
          if (g) generated = `${g[3]}-${g[2]}-${g[1]}`;
        }
        const match = teacher ? wanted(teacher) : null;
        if (!match) {
          skipped += 1;
          continue;
        }
        teachers.push({ page: p, teacher, match, lectures: await parseGrid(page, words, pdfjs) });
      } finally {
        page.cleanup();
      }
    }
    return { pages, generated, teachers, skipped };
  } finally {
    await doc.destroy();
  }
}

module.exports = { parseTimetablePdf, joinClassLines, PARSER_VERSION };
