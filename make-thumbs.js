#!/usr/bin/env node
/* make-thumbs.js — generate thumbnails for media.json entries
 * - Images: downscaled JPEG thumbnail
 * - Videos: frame grab at ~20% duration, JPEG thumbnail
 * Writes thumb paths back into media.json
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

const exf = (cmd, args, opts={}) =>
  new Promise((res, rej) => execFile(cmd, args, opts, (e, out, err) => e ? rej(Object.assign(e, {out, err})) : res({out, err})));

const sleep = ms => new Promise(r => setTimeout(r, ms));

const isVideo = p => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(p);
const isImage = p => /\.(jpg|jpeg|png|gif|webp|bmp|tiff?)$/i.test(p);

(async function main(){
  const args = require('minimist')(process.argv.slice(2), {
    string: ['json','thumbDir','root'],
    default: {
      json: './media.json',
      thumbDir: './media/thumbs',
      width: 640,
      quality: 3,
      concurrency: 4,
      overwrite: false,
      root: '.'
    },
    boolean: ['overwrite']
  });

  const {
    json: jsonPath,
    thumbDir,
    width,
    quality,
    concurrency,
    overwrite,
    root
  } = args;

  const siteRoot = path.resolve(process.cwd(), root);
  const absJson = path.resolve(siteRoot, jsonPath);
  const absThumbDir = path.resolve(siteRoot, thumbDir);

  // Ensure ffmpeg / ffprobe exist
  try { await exf('ffmpeg', ['-version']); } catch { console.error('ffmpeg not found in PATH'); process.exit(1); }
  try { await exf('ffprobe', ['-version']); } catch { console.error('ffprobe not found in PATH'); process.exit(1); }

  // Load media.json
  let dataRaw;
  try {
    dataRaw = await fsp.readFile(absJson, 'utf8');
  } catch (e) {
    console.error(`Could not read ${absJson}:`, e.message);
    process.exit(1);
  }

  let items;
  try {
    items = JSON.parse(dataRaw);
    if (!Array.isArray(items)) throw new Error('media.json must be an array');
  } catch (e) {
    console.error('Invalid media.json:', e.message);
    process.exit(1);
  }

  await fsp.mkdir(absThumbDir, { recursive: true });

  const q = [];
  let done = 0;
  let changed = false;

  const total = items.length;
  const pad = n => String(n).padStart(String(total).length, ' ');

  const hashName = (relPath) => {
    const h = crypto.createHash('md5').update(relPath).digest('hex').slice(0,12);
    const base = path.basename(relPath, path.extname(relPath));
    return `${base}.${h}.jpg`;
  };

  const toPosix = p => p.split(path.sep).join('/');

  async function thumbForItem(item){
    const relSrc = String(item.src || '').trim();
    if(!relSrc){ return; }

    const relSrcClean = relSrc.replace(/^(\.\/|\/)/, '');
    const absSrc = path.resolve(siteRoot, relSrcClean);
    try {
      await fsp.access(absSrc, fs.constants.R_OK);
    } catch {
      // Source missing; skip
      return;
    }

    const thumbFile = hashName(relSrc);
    const absThumb = path.join(absThumbDir, thumbFile);
    const relThumb = toPosix(path.relative(siteRoot, absThumb));

    if (!overwrite && item.thumb && item.thumb === relThumb) {
      try {
        await fsp.access(absThumb, fs.constants.R_OK);
        return; // thumb path matches AND file exists -> skip
      } catch {
        // thumb file missing -> fall through and (re)generate
      }
    }
    if (!overwrite) {
      try { await fsp.access(absThumb, fs.constants.R_OK); 
        // file exists: just attach if not already the same
        if (item.thumb !== relThumb) { item.thumb = relThumb; changed = true; }
        return;
      } catch {}
    }

    // Make thumbnail
    if (isImage(relSrc)) {
      // Use ffmpeg to scale image to width, keep aspect
      try {
        await exf('ffmpeg', [
          '-y',
          '-i', absSrc,
          '-vf', `scale='min(${width},iw)':-2`,
          '-frames:v', '1',
          '-q:v', String(quality),
          absThumb
        ]);
        item.thumb = relThumb; changed = true;
      } catch (e) {
        // Try fallback without frames for still images
        try {
          await exf('ffmpeg', [
            '-y',
            '-i', absSrc,
            '-vf', `scale='min(${width},iw)':-2`,
            '-q:v', String(quality),
            absThumb
          ]);
          item.thumb = relThumb; changed = true;
        } catch (e2) {
          // give up silently for this item
        }
      }
    } else if (isVideo(relSrc)) {
      // Get duration to pick a frame around 20%
      let ts = 1.0;
      try {
        const { out } = await exf('ffprobe', [
          '-v','error','-select_streams','v:0',
          '-show_entries','stream=duration',
          '-of','default=nw=1:nk=1',
          absSrc
        ]);
        const dur = parseFloat((out||'').trim());
        if (isFinite(dur) && dur > 0) ts = Math.max(0.5, Math.min(dur - 0.5, dur * 0.20));
      } catch {}
      try {
        await exf('ffmpeg', [
          '-y',
          '-ss', String(ts),
          '-i', absSrc,
          '-frames:v','1',
          '-vf', `scale='min(${width},iw)':-2`,
          '-q:v', String(quality),
          absThumb
        ]);
        item.thumb = relThumb; changed = true;
      } catch (e) {
        // Fallback: first frame
        try {
          await exf('ffmpeg', [
            '-y',
            '-i', absSrc,
            '-frames:v','1',
            '-vf', `scale='min(${width},iw)':-2`,
            '-q:v', String(quality),
            absThumb
          ]);
          item.thumb = relThumb; changed = true;
        } catch {}
      }
    }
  }

  // Simple worker pool
  let i = 0;
  const workers = Array.from({length: Math.max(1, +concurrency|0)}, () => (async function worker(){
    while (true){
      const idx = i++;
      if (idx >= items.length) break;
      const item = items[idx];
      await thumbForItem(item).catch(()=>{});
      done++;
      if (done % 10 === 0 || done === total){
        process.stdout.write(`\rThumbnails: ${pad(done)}/${total}`);
      }
      // tiny pause to keep TTY responsive on some shells
      if (done % 50 === 0) await sleep(5);
    }
  })());

  await Promise.all(workers);
  process.stdout.write(`\rThumbnails: ${pad(done)}/${total}\n`);

  if (changed){
    const backup = absJson + '.bak';
    try { await fsp.copyFile(absJson, backup); } catch {}
    await fsp.writeFile(absJson, JSON.stringify(items, null, 2) + '\n', 'utf8');
    console.log(`Updated ${path.relative(process.cwd(), absJson)} (backup at ${path.relative(process.cwd(), backup)})`);
  } else {
    console.log('No changes to media.json');
  }

  console.log(`Thumbs are in: ${path.relative(process.cwd(), absThumbDir)}`);
})().catch(e => {
  console.error('\nFailed:', e && e.message ? e.message : e);
  process.exit(1);
});
