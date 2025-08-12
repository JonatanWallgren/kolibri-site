
//#!/usr/bin/env node
/* Visual fuzzy compare between Instagram dump and ingested Kolibri media.
 * Now with video thumbnail support (first frame), resized and padded.
 * Outputs a visual HTML report.
 */

const fs = require('fs-extra');
const path = require('path');
const { promisify } = require('util');
const sharp = require('sharp');
// const glob = require('glob');
const { imageHash } = require('image-hash');
const { spawn } = require('child_process');
const tmp = require('os').tmpdir();

const { glob } = require('glob');
function imageHashP(buf, bits = 16, asHex = true) {
  return new Promise((resolve, reject) => {
    imageHash({ data: buf }, bits, asHex, (err, hash) => {
      if (err) reject(err);
      else resolve(hash);
    });
  });
}
const args = require('minimist')(process.argv.slice(2), {
  string: ['insta', 'media', 'out'],
  default: {
    out: 'compare-report.html'
  }
});

if (!args.insta || !args.media) {
  console.error('Usage: node compare-visual-fuzzy.js --insta /path/to/instagram/media --media /path/to/ingested/media [--out compare.html]');
  process.exit(1);
}

const THUMB_SIZE = 128;

function isImage(p) {
  return /\.(jpg|jpeg|png|webp|heic|heif|bmp|tiff|gif)$/i.test(p);
}
function isVideo(p) {
  return /\.(mp4|mov|m4v|avi|webm|mkv)$/i.test(p);
}

async function extractThumb(input, isVideo) {
  try {
    if (isVideo) {
      const outPath = path.join(tmp, 'thumb_' + path.basename(input) + '.jpg');
      const args = ['-y', '-i', input, '-frames:v', '1', '-q:v', '2', '-vf', `scale=${THUMB_SIZE}:${THUMB_SIZE}:force_original_aspect_ratio=decrease,pad=${THUMB_SIZE}:${THUMB_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black`, outPath];
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', args);
        ff.on('exit', code => (code === 0 ? resolve() : reject(new Error('ffmpeg failed'))));
        ff.on('error', reject);
      });
      const buf = await fs.readFile(outPath);
      return buf;
    } else {
      const buf = await sharp(input)
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'contain', background: 'black' })
        .toBuffer();
      return buf;
    }
  } catch (e) {
    return null;
  }
}

async function buildIndex(dir) {
  const files = await glob('**/*.*', { cwd: dir, nodir: true });
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const isVid = isVideo(f);
    const isImg = isImage(f);
    if (!isVid && !isImg) continue;

    const buf = await extractThumb(full, isVid);
    if (!buf) continue;

    // const hash = await imageHashP({ data: buf, bits: 16, hash: 'hex' });
    const hash = await imageHashP(buf, 16, true);
    out.push({ file: f, hash, buf });
  }
  return out;
}

function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) n++;
  }
  return n;
}

function matchEntries(src, dst) {
  const matches = [];
  const unmatched = [];

  for (const s of src) {
    let best = null;
    let minDist = Infinity;

    for (const d of dst) {
      const dist = hamming(s.hash, d.hash);
      if (dist < minDist) {
        best = d;
        minDist = dist;
      }
    }

    if (minDist <= 10) {
      matches.push({ src: s, dst: best, dist: minDist });
    } else {
      unmatched.push(s);
    }
  }

  return { matches, unmatched };
}

function toDataUrl(buf) {
  return 'data:image/webp;base64,' + buf.toString('base64');
}

function makeReport(unmatched, outPath) {
  const rows = unmatched.map(f => `
    <tr>
      <td><div class="thumb"><img src="${toDataUrl(f.buf)}" alt="${f.file}" /></div></td>
      <td><code>${f.file}</code></td>
    </tr>`).join('\n');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<title>Missing or unmatched media</title>
<style>
body { font-family: sans-serif; background: #111; color: #eee; }
table { width: 100%; border-collapse: collapse; margin: 1em 0; }
td { padding: 6px; vertical-align: middle; }
.thumb { width: 128px; height: 128px; background: #222; display: inline-block; }
img { width: 128px; height: 128px; object-fit: contain; background: #000; }
code { color: #ccc; font-family: monospace; word-break: break-all; }
</style>
</head>
<body>
<h1>Unmatched media from Instagram export</h1>
<p>${unmatched.length} files from the Instagram dump could not be matched visually with anything in the ingested media.</p>
<table>${rows}</table>
</body></html>`;

  fs.writeFileSync(outPath, html, 'utf8');
}

(async () => {
  console.log('Indexing Instagram dump...');
  const insta = await buildIndex(args.insta);
  console.log('Indexing Kolibri media...');
  const kolibri = await buildIndex(args.media);

  console.log('Comparing...');
  const { unmatched } = matchEntries(insta, kolibri);

  console.log('Writing report to', args.out);
  makeReport(unmatched, args.out);
})();
