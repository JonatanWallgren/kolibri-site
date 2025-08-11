#!/usr/bin/env node
/* Minimal Instagram ingest — square-one version.
 * - Input:   --in   /path/to/instagram-export
 * - Output:  --out  .   (project root; will write media/YYYY/MM/* and media.json)
 * - Options: --public-base /    (prefix for src urls in media.json)
 *           --img-max 1920
 *           --vid-max 1920
 *           --concurrency 4
 *           --dry-run
 *           --verbose
 *
 * Only dependency: ffmpeg must be installed and in PATH.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const extsImage = new Set(['.jpg','.jpeg','.png','.webp','.heic','.heif','.bmp','.tif','.tiff','.gif']);
const extsVideo = new Set(['.mp4','.mov','.m4v','.avi','.mkv','.webm','.3gp','.mts','.m2ts']);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    inDir: null,
    outDir: '.',
    publicBase: '/',
    imgMax: 1920,
    vidMax: 1920,
    concurrency: 4,
    dryRun: false,
    verbose: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--in') opts.inDir = args[++i];
    else if (a === '--out') opts.outDir = args[++i];
    else if (a === '--public-base') opts.publicBase = args[++i];
    else if (a === '--img-max') opts.imgMax = parseInt(args[++i], 10);
    else if (a === '--vid-max') opts.vidMax = parseInt(args[++i], 10);
    else if (a === '--concurrency') opts.concurrency = Math.max(1, parseInt(args[++i], 10));
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--verbose' || a === '--debug') opts.verbose = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!opts.inDir) {
    console.error('Usage: node ingest-instagram.js --in "/path/to/export" [--out .] [--public-base /] [--img-max 1920] [--vid-max 1920] [--concurrency 4] [--dry-run] [--verbose]');
    process.exit(1);
  }
  return opts;
}

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

async function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

function hashShort(str) {
  return crypto.createHash('sha1').update(str).digest('hex').slice(0, 8);
}

function isoFromUnixSeconds(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function pickFirstDate(obj) {
  if (!obj || typeof obj !== 'object') return null;
  // Common keys in IG export
  if (obj.creation_timestamp) return isoFromUnixSeconds(obj.creation_timestamp);
  if (obj.taken_at) return isoFromUnixSeconds(obj.taken_at);
  if (obj.timestamp) return isoFromUnixSeconds(obj.timestamp);
  if (typeof obj.date === 'string') {
    const t = Date.parse(obj.date);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

// Recursively scan arbitrary JSON trees to grab { uri -> date }
function indexJsonDates(root, mapByRelPath, mapByBase) {
  if (!root || typeof root !== 'object') return;
  if (Array.isArray(root)) {
    for (const v of root) indexJsonDates(v, mapByRelPath, mapByBase);
    return;
  }
  // IG export often has { "media": [{ "uri": "media/posts/...", "creation_timestamp": 168... }, ...] }
  const date = pickFirstDate(root);
  if (root.uri && typeof root.uri === 'string') {
    const uri = root.uri.replace(/^\.?\/*/, ''); // normalize
    if (date) {
      mapByRelPath.set(uri, date);
      mapByBase.set(path.basename(uri), date);
    }
  }
  // Also catch file lists under different keys
  for (const k of Object.keys(root)) {
    indexJsonDates(root[k], mapByRelPath, mapByBase);
  }
}

async function buildDateIndex(inDir, verbose=false) {
  const contentDir = path.join(inDir, 'content');
  const mapByRelPath = new Map();
  const mapByBase = new Map();
  if (await exists(contentDir)) {
    const files = await fsp.readdir(contentDir).catch(() => []);
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(contentDir, name);
      try {
        const raw = await fsp.readFile(p, 'utf8');
        const json = JSON.parse(raw);
        indexJsonDates(json, mapByRelPath, mapByBase);
      } catch (e) {
        if (verbose) console.warn('[warn] could not parse', p, e.message);
      }
    }
  }
  if (verbose) {
    console.log(`JSON index: ${mapByRelPath.size} by relative path, ${mapByBase.size} by basename.`);
  }
  return { mapByRelPath, mapByBase };
}

function toPosix(p) { return p.split(path.sep).join('/'); }

async function guessDateFor(absPath, inDir, maps) {
  const rel = toPosix(path.relative(inDir, absPath)); // e.g., media/posts/2023/.../file.jpg
  const base = path.basename(absPath);

  // Prefer exact relative path match
  if (maps.mapByRelPath.has(rel)) return maps.mapByRelPath.get(rel);
  // Try just basename match (common when export layout varies)
  if (maps.mapByBase.has(base)) return maps.mapByBase.get(base);

  // Fallback: file mtime
  const st = await fsp.stat(absPath).catch(() => null);
  if (st) return new Date(st.mtimeMs).toISOString();

  // Last resort: now
  return new Date().toISOString();
}

function ensureTrailingSlash(s) { return s.endsWith('/') ? s : s + '/'; }
function cleanBase(s) { return ensureTrailingSlash(s.replace(/\/+$/,'/')); }

function makeDest(inAbs, isoDate, type, outDir) {
  const d = new Date(isoDate);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth()+1).padStart(2,'0');
  const dd = String(d.getUTCDate()).padStart(2,'0');
  const hh = String(d.getUTCHours()).padStart(2,'0');
  const mi = String(d.getUTCMinutes()).padStart(2,'0');
  const ss = String(d.getUTCSeconds()).padStart(2,'0');

  const base = path.basename(inAbs, path.extname(inAbs));
  const tag = `${yyyy}${mm}${dd}_${hh}${mi}${ss}-${hashShort(inAbs)}`;

  let ext = (type === 'video') ? '.mp4' : '.webp';
  const rel = path.join('media', yyyy, mm, `${tag}${ext}`);
  const abs = path.join(outDir, rel);
  return { rel, abs, yyyy, mm };
}

function isVideoFile(p) { return extsVideo.has(path.extname(p).toLowerCase()); }
function isImageFile(p) { return extsImage.has(path.extname(p).toLowerCase()); }

function runFFmpeg(args, verbose=false) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: verbose ? 'inherit' : ['ignore','ignore','inherit'] });
    proc.on('exit', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function transcodeImage(inAbs, outAbs, imgMax, verbose=false) {
  const dir = path.dirname(outAbs);
  await fsp.mkdir(dir, { recursive: true });

  // Larger dimension clamped to imgMax, preserve AR
  const vf = `scale='if(gte(iw,ih),${imgMax},-2)':'if(gt(ih,iw),${imgMax},-2)'`;
  const args = [
    '-y',
    '-hide_banner',
    '-i', inAbs,
    '-vf', vf,
    '-q:v', '85',          // WebP quality-ish
    outAbs
  ];
  return await runFFmpeg(args, verbose);
}

async function transcodeVideo(inAbs, outAbs, vidMax, verbose=false) {
  const dir = path.dirname(outAbs);
  await fsp.mkdir(dir, { recursive: true });

  // Larger dimension clamped to vidMax
  const vf = `scale='if(gte(iw,ih),${vidMax},-2)':'if(gt(ih,iw),${vidMax},-2)'`;
  const args = [
    '-y',
    '-hide_banner',
    '-i', inAbs,
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '128k',
    outAbs
  ];
  return await runFFmpeg(args, verbose);
}

async function copyFallback(inAbs, outAbs) {
  await fsp.mkdir(path.dirname(outAbs), { recursive: true });
  await fsp.copyFile(inAbs, outAbs);
  return true;
}

async function main() {
  const opts = parseArgs();
  const inDir = path.resolve(opts.inDir);
  const outDir = path.resolve(opts.outDir);
  const publicBase = cleanBase(opts.publicBase);

  // Sanity: ffmpeg present?
  const ffTestOk = await new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('exit', (c) => resolve(c === 0));
    p.on('error', () => resolve(false));
  });
  if (!ffTestOk) {
    console.error('ffmpeg not found. Please install ffmpeg and ensure it is in PATH.');
    process.exit(1);
  }

  // Gather media files
  const mediaRoot = path.join(inDir, 'media');
  if (!(await exists(mediaRoot))) {
    console.error(`No "media" directory inside ${inDir}`);
    process.exit(1);
  }
  const allFiles = (await walk(mediaRoot))
    .filter(p => isImageFile(p) || isVideoFile(p))
    .sort();

  if (!allFiles.length) {
    console.log('No media files found.');
    process.exit(0);
  }

  console.log(`Found ${allFiles.length} media files.`);
  const maps = await buildDateIndex(inDir, opts.verbose);

  // Process with a tiny concurrency pool
  const results = [];
  let done = 0, failed = 0, copied = 0, transcoded = 0, unmatchedDates = 0;

  const queue = [...allFiles];
  async function worker() {
    while (queue.length) {
      const inAbs = queue.shift();
      const isVid = isVideoFile(inAbs);
      const type = isVid ? 'video' : 'image';

      const date = await guessDateFor(inAbs, inDir, maps);
      if (!maps.mapByRelPath.has(toPosix(path.relative(inDir, inAbs))) &&
          !maps.mapByBase.has(path.basename(inAbs))) {
        unmatchedDates++;
        if (opts.verbose) console.log('[date:fallback mtime]', inAbs, '->', date);
      }

      const { rel, abs } = makeDest(inAbs, date, type, outDir);

      let ok = true;
      if (!opts.dryRun) {
        try {
          if (type === 'image') {
            ok = await transcodeImage(inAbs, abs, opts.imgMax, opts.verbose);
          } else {
            ok = await transcodeVideo(inAbs, abs, opts.vidMax, opts.verbose);
          }
          if (!ok) {
            await copyFallback(inAbs, abs);
            copied++;
          } else {
            transcoded++;
          }
        } catch (e) {
          await copyFallback(inAbs, abs);
          copied++;
        }
      }

      // Record entry
      const src = publicBase + rel.replace(/^[\/]+/,'');
      results.push({
        type,
        date,
        src,
        thumb: src,     // simple for now; can add separate thumbs later
        id: hashShort(abs)
      });

      done++;
      if (!opts.verbose) {
        const pct = Math.floor((done / allFiles.length) * 100);
        process.stdout.write(`\rProcessing ${done}/${allFiles.length} (${pct}%)`);
      } else {
        console.log(`Processed: ${inAbs} -> ${rel}`);
      }
    }
  }

  const workers = [];
  const N = Math.min(opts.concurrency, allFiles.length);
  for (let i = 0; i < N; i++) workers.push(worker());
  await Promise.all(workers);
  if (!opts.verbose) process.stdout.write('\n');

  // Sort newest-first in output JSON to match your media.js behavior
  results.sort((a, b) => {
    const ta = Date.parse(a.date) || 0, tb = Date.parse(b.date) || 0;
    if (tb !== ta) return tb - ta;
    return String(b.id).localeCompare(String(a.id));
  });

  // Write media.json at out root (what media.js loads)
  const mediaJsonPath = path.join(outDir, 'media.json');
  if (!opts.dryRun) {
    await fsp.writeFile(mediaJsonPath, JSON.stringify(results, null, 2), 'utf8');
  }

  // Summary
  console.log('Done.');
  if (!opts.dryRun) console.log('-', mediaJsonPath);
  console.log(`Transcoded: ${transcoded}, Copied (fallback): ${copied}, Total: ${results.length}, Unmatched dates (used mtime): ${unmatchedDates}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
