#!/usr/bin/env node

/**
 * ingest-instagram-media.js
 *
 * Usage:
 *   node ingest-instagram-media.js --in "/path/to/instagram-export" --out ./out --concurrency 4 --materialize copy --debug
 *
 * What it does:
 *   - Walks the export dir, indexes all JSON files (by 'uri' and long 'id')
 *   - Finds every media file under export/media/** (posts, reels, other, etc.)
 *   - Derives a timestamp per file using this order:
 *       1) JSON match on uri/filename
 *       2) JSON match on long numeric id found in filename
 *       3) Best date found in parent folders (YYYY/MM or YYYY-MM or YYYY-MM-DD)
 *       4) File mtime
 *   - Copies / hardlinks / symlinks (per --materialize) to out/media/YYYY/MM/<original-filename>
 *   - Sets the mtime on the output file to the derived timestamp
 *   - Writes media.index.json and media.timeline.csv
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// --- CLI -------------------------------------------------------------

const minimist = require('minimist');
const argv = minimist(process.argv.slice(2), {
  string: ['in', 'out', 'materialize'],
  boolean: ['debug'],
  default: { concurrency: 4, materialize: 'copy', debug: false },
});

const IN_ROOT = argv.in || argv.i;
const OUT_ROOT = argv.out || argv.o || './out';
const CONCURRENCY = Math.max(1, Number(argv.concurrency || argv.c || 4));

const MATERIALIZE = String(argv.materialize || 'copy').toLowerCase();
if (!['copy', 'hardlink', 'symlink'].includes(MATERIALIZE)) {
  console.error(`--materialize must be one of copy|hardlink|symlink (got: ${argv.materialize})`);
  process.exit(1);
}

const DEBUG = !!argv.debug;

if (!IN_ROOT) {
  console.error('Missing --in "/path/to/instagram-export"');
  process.exit(1);
}

// --- helpers ---------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function asISO(tsMs) {
  try { return new Date(tsMs).toISOString(); } catch { return ''; }
}

function isMediaFile(p) {
  const ext = path.extname(p).toLowerCase();
  return ['.jpg','.jpeg','.png','.gif','.mp4','.mov','.m4v','.heic','.webp'].includes(ext);
}

function cleanRel(p) {
  // normalize slashes, strip leading ./ or /
  return p.replaceAll('\\', '/').replace(/^(\.\/|\/)+/, '');
}

async function walk(dir) {
  const out = [];
  async function _walk(d) {
    const entries = await fsp.readdir(d, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) {
        await _walk(abs);
      } else {
        out.push(abs);
      }
    }
  }
  await _walk(dir);
  return out;
}

function traverseJSON(value, visit) {
  if (Array.isArray(value)) {
    for (const v of value) traverseJSON(v, visit);
  } else if (value && typeof value === 'object') {
    visit(value);
    for (const v of Object.values(value)) traverseJSON(v, visit);
  }
}

function firstNumberLikeId(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{13,})/); // IG long ids often 14-17 digits
  return m ? m[1] : null;
}

function pickTimestamp(obj) {
  // common IG export keys
  const keys = [
    'creation_timestamp',
    'taken_at',
    'media_creation_time',
    'timestamp',
    'taken_at_timestamp',
  ];
  for (const k of keys) {
    if (obj && obj[k] != null) {
      const n = Number(obj[k]);
      if (!Number.isNaN(n) && n > 0 && n < 32503680000 /* year 3000 */) {
        return n * (n < 1e12 ? 1000 : 1); // seconds→ms if it looks like seconds
      }
    }
  }
  return null;
}

function bestDateFromPath(relPath) {
  // look through each path segment for YYYY-MM-DD or YYYY_MM_DD or YYYY/MM
  const parts = cleanRel(relPath).split('/');
  let year=null, month=null, day=null;

  for (const seg of parts) {
    let m;
    if ((m = seg.match(/^(\d{4})[-_](\d{2})[-_](\d{2})/))) {
      year = Number(m[1]); month = Number(m[2]); day = Number(m[3]);
      break;
    }
    if ((m = seg.match(/^(\d{4})[-_](\d{2})/))) {
      year = Number(m[1]); month = Number(m[2]); day = 15;
      // keep scanning in case we see a better (DD) later
    }
    if ((m = seg.match(/^(\d{4})$/))) {
      if (!year) { year = Number(m[1]); month = 7; day = 1; }
    }
  }

  if (year && month) {
    // noon UTC to avoid DST quirks
    const dt = Date.UTC(year, (month-1), day || 15, 12, 0, 0);
    return dt;
  }
  return null;
}

async function ensureUniquePath(dst) {
  let attempt = 0;
  const dir = path.dirname(dst);
  const base = path.basename(dst, path.extname(dst));
  const ext = path.extname(dst);
  let candidate = dst;

  while (true) {
    try {
      await fsp.access(candidate, fs.constants.F_OK);
      // exists, bump
      attempt += 1;
      candidate = path.join(dir, `${base}-${attempt}${ext}`);
    } catch {
      return candidate;
    }
  }
}

async function materializeFile(srcPath, dstPath, mode = 'copy') {
  await fsp.mkdir(path.dirname(dstPath), { recursive: true });
  // clean existing
  try { await fsp.unlink(dstPath); } catch (_) {}
  if (mode === 'hardlink') {
    try {
      await fsp.link(srcPath, dstPath);
      return 'hardlink';
    } catch (err) {
      if (['EXDEV','EPERM','EACCES'].includes(err.code)) {
        await fsp.copyFile(srcPath, dstPath);
        return 'copy(fallback)';
      }
      throw err;
    }
  }
  if (mode === 'symlink') {
    const rel = path.relative(path.dirname(dstPath), srcPath);
    await fsp.symlink(rel, dstPath);
    return 'symlink';
  }
  await fsp.copyFile(srcPath, dstPath);
  return 'copy';
}

function formatBar(pct) {
  const width = 30;
  const filled = Math.round(width * pct);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

function etaString(startMs, done, total) {
  const elapsed = Math.max(1, Date.now() - startMs);
  const rate = done / (elapsed / 1000); // items / sec
  const remain = Math.max(0, total - done);
  const secs = rate > 0 ? Math.round(remain / rate) : 0;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m${String(s).padStart(2,'0')}s`;
}

// --- index JSON ------------------------------------------------------

async function buildJsonIndex(root) {
  const allFiles = await walk(root);
  const jsonFiles = allFiles.filter(f => f.toLowerCase().endsWith('.json'));

  const byFilename = new Map(); // basename -> ts
  const byId = new Map();       // long numeric id -> ts
  const byRelUri = new Map();   // rel path in export -> ts (normalized)

  for (const jf of jsonFiles) {
    let data;
    try {
      const raw = await fsp.readFile(jf, 'utf8');
      data = JSON.parse(raw);
    } catch {
      continue; // skip broken json
    }

    traverseJSON(data, (obj) => {
      const ts = pickTimestamp(obj);
      if (!ts) return;

      // uri-based (what IG usually stores)
      if (typeof obj.uri === 'string') {
        const rel = cleanRel(obj.uri);
        byRelUri.set(rel, ts);
        const base = path.basename(rel);
        byFilename.set(base, ts);
      }

      // Sometimes IG stores direct filename fields
      if (typeof obj.path === 'string') {
        const rel = cleanRel(obj.path);
        byRelUri.set(rel, ts);
        byFilename.set(path.basename(rel), ts);
      }

      // id-based
      const candIds = [];
      if (obj.id != null) candIds.push(String(obj.id));
      if (obj.media_id != null) candIds.push(String(obj.media_id));
      if (obj.ig_media_id != null) candIds.push(String(obj.ig_media_id));
      for (const id of candIds) {
        const longId = firstNumberLikeId(id);
        if (longId) byId.set(longId, ts);
      }
    });
  }

  // also add from relUri map to filename map (guarantee coverage)
  for (const [rel, ts] of byRelUri.entries()) {
    byFilename.set(path.basename(rel), ts);
  }

  return { byFilename, byId, byRelUri };
}

// --- main ------------------------------------------------------------

(async () => {
  const start = Date.now();

  // 1) discover media files
  const allFiles = await walk(IN_ROOT);
  const mediaFiles = allFiles.filter(f => cleanRel(f).startsWith('media') || cleanRel(path.relative(IN_ROOT, f)).startsWith('media'))
                             .map(f => path.resolve(f))
                             .filter(isMediaFile);

  console.log(`Found ${mediaFiles.length} media files.`);

  // 2) build JSON index
  process.stdout.write('Indexing JSON…\n');
  const { byFilename, byId, byRelUri } = await buildJsonIndex(IN_ROOT);
  console.log(`JSON index: ${byFilename.size} by filename, ${byId.size} by id.`);

  // 3) process with concurrency
  const indexRecords = [];
  let processed = 0;
  let printedLine = false;

  const tasks = mediaFiles.map((absPath) => async () => {
    const relFromRoot = cleanRel(path.relative(IN_ROOT, absPath));
    const base = path.basename(absPath);
    const idFromName = firstNumberLikeId(base);

    // resolve timestamp
    let ts = null;
    let tsSource = null;

    // A) exact rel uri match
    if (byRelUri.has(relFromRoot)) {
      ts = byRelUri.get(relFromRoot);
      tsSource = 'json:uri';
    }

    // B) filename match
    if (!ts && byFilename.has(base)) {
      ts = byFilename.get(base);
      tsSource = 'json:filename';
    }

    // C) id match
    if (!ts && idFromName && byId.has(idFromName)) {
      ts = byId.get(idFromName);
      tsSource = 'json:id';
    }

    // D) folder date guess
    if (!ts) {
      const guessed = bestDateFromPath(relFromRoot);
      if (guessed) {
        ts = guessed;
        tsSource = 'folderTs';
      }
    }

    // E) mtime fallback
    if (!ts) {
      const st = await fsp.stat(absPath);
      ts = st.mtimeMs;
      tsSource = 'mtime';
    }

    const d = new Date(ts);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');

    const outDir = path.join(OUT_ROOT, 'media', yyyy, mm);
    let outPath = path.join(outDir, base);
    outPath = await ensureUniquePath(outPath);

    // materialize
    const how = await materializeFile(absPath, outPath, MATERIALIZE);

    // set mtime/atime to ts
    try {
      await fsp.utimes(outPath, new Date(ts), new Date(ts));
    } catch (e) {
      // best effort; symlink utimes may fail (macOS), ignore
    }

    if (DEBUG && !tsSource.startsWith('json')) {
      console.log(`[no JSON match] used ${tsSource} ${base} -> ${asISO(ts)}`);
    }

    indexRecords.push({
      src: relFromRoot,
      out: cleanRel(path.relative(OUT_ROOT, outPath)),
      timestamp_ms: ts,
      timestamp_iso: asISO(ts),
      source: tsSource,
      materialized: how,
      ext: path.extname(absPath).toLowerCase().slice(1),
    });

    processed += 1;
  });

  // simple concurrency runner
  async function runPool(limit, jobs) {
    let i = 0;
    const running = new Set();
    const startMs = Date.now();

    async function spawn() {
      if (i >= jobs.length) return;
      const job = jobs[i++];
      const p = job().catch((e) => {
        console.error('\nError processing file:', e && e.message ? e.message : e);
      }).finally(() => {
        running.delete(p);
      });
      running.add(p);
    }

    // prime pool
    for (let k = 0; k < Math.min(limit, jobs.length); k++) await spawn();

    // progress loop
    while (running.size > 0 || i < jobs.length) {
      // print progress line
      const pct = processed / Math.max(1, mediaFiles.length);
      const bar = formatBar(pct);
      const eta = etaString(startMs, processed, mediaFiles.length);
      const line = `\rProcessing media (×${limit})  ${bar} ${Math.round(pct*100)}%  ${processed}/${mediaFiles.length}  ETA ${eta}  `;
      process.stdout.write(line);
      printedLine = true;

      // wait a bit
      await Promise.race([sleep(120), ...Array.from(running)]);
      // keep spawning until pool is full
      while (running.size < limit && i < jobs.length) await spawn();
    }

    // final line refresh
    const pct = processed / Math.max(1, mediaFiles.length);
    const bar = formatBar(pct);
    const eta = etaString(startMs, processed, mediaFiles.length);
    process.stdout.write(`\rProcessing media (×${limit})  ${bar} ${Math.round(pct*100)}%  ${processed}/${mediaFiles.length}  ETA ${eta}  \n`);
  }

  await runPool(CONCURRENCY, tasks);

  // 4) write indexes
  await fsp.mkdir(OUT_ROOT, { recursive: true });

  // media.index.json
  const indexPath = path.join(OUT_ROOT, 'media.index.json');
  await fsp.writeFile(indexPath, JSON.stringify(indexRecords, null, 2), 'utf8');

  // media.timeline.csv
  const csvPath = path.join(OUT_ROOT, 'media.timeline.csv');
  const csv = [
    'timestamp_iso,timestamp_ms,source,materialized,out,src,ext',
    ...indexRecords
      .sort((a,b)=>a.timestamp_ms-b.timestamp_ms)
      .map(r => [
        r.timestamp_iso,
        r.timestamp_ms,
        r.source,
        r.materialized,
        `"${r.out.replace(/"/g,'""')}"`,
        `"${r.src.replace(/"/g,'""')}"`,
        r.ext
      ].join(',')),
  ].join('\n');
  await fsp.writeFile(csvPath, csv, 'utf8');

  if (printedLine === false) console.log(); // keep spacing tidy
  console.log('Done. Wrote:');
  console.log(`- ${path.resolve(indexPath)}`);
  console.log(`- ${path.resolve(csvPath)}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});