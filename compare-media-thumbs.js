// compare-media-thumbs.js (CommonJS)
// Usage: node compare-media-thumbs.js --src /path/to/insta/media --dst /path/to/site/media --out ./report
// Requires: sharp, image-hash, fs-extra, glob

const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');
const { imageHash } = require('image-hash');
const glob = require('glob');

const argv = require('minimist')(process.argv.slice(2));
const SRC_DIR = argv.src;
const DST_DIR = argv.dst;
const OUT_DIR = argv.out || './report';
const THUMB_SIZE = 128;

if (!SRC_DIR || !DST_DIR) {
  console.error('Usage: node compare-media-thumbs.js --src ./instagram/media --dst ./site/media --out ./report');
  process.exit(1);
}

const hashImage = (filepath) => {
  return new Promise((resolve, reject) => {
    imageHash(filepath, 16, true, (err, hash) => {
      if (err) reject(err);
      else resolve(hash);
    });
  });
};

const makeThumbnail = async (srcPath, outPath) => {
  await sharp(srcPath)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'contain', background: 'black' })
    .toFile(outPath);
};

(async () => {
  const srcFiles = glob.sync(`${SRC_DIR}/**/*.{jpg,jpeg,png,webp}`, { nocase: true });
  const dstFiles = glob.sync(`${DST_DIR}/**/*.{webp,jpg,jpeg,png}`, { nocase: true });

  const srcThumbDir = path.join(OUT_DIR, 'thumbs/src');
  const dstThumbDir = path.join(OUT_DIR, 'thumbs/dst');
  await fs.ensureDir(srcThumbDir);
  await fs.ensureDir(dstThumbDir);

  const srcHashes = [];
  for (const file of srcFiles) {
    const thumbPath = path.join(srcThumbDir, path.basename(file) + '.png');
    await makeThumbnail(file, thumbPath);
    const hash = await hashImage(thumbPath);
    srcHashes.push({ file, thumb: path.relative(OUT_DIR, thumbPath), hash });
  }

  const dstHashes = [];
  for (const file of dstFiles) {
    const thumbPath = path.join(dstThumbDir, path.basename(file) + '.png');
    await makeThumbnail(file, thumbPath);
    const hash = await hashImage(thumbPath);
    dstHashes.push({ file, thumb: path.relative(OUT_DIR, thumbPath), hash });
  }

  const matched = [];
  const unmatchedSrc = [];

  for (const src of srcHashes) {
    const match = dstHashes.find(d => d.hash === src.hash);
    if (match) {
      matched.push({ src, dst: match });
    } else {
      unmatchedSrc.push(src);
    }
  }

  const html = [];
  html.push(`<html><head><meta charset="utf-8"><title>Media Comparison</title><style>body{font-family:sans-serif} .pair{display:flex;gap:1em;margin-bottom:2em} img{border:1px solid #ccc;width:${THUMB_SIZE}px;height:${THUMB_SIZE}px;object-fit:contain}</style></head><body>`);
  html.push(`<h1>Matched Media</h1>`);
  for (const { src, dst } of matched) {
    html.push(`<div class="pair"><div><img src="${src.thumb}" /><br/><small>${path.basename(src.file)}</small></div><div><img src="${dst.thumb}" /><br/><small>${path.basename(dst.file)}</small></div></div>`);
  }
  html.push(`<h1>Unmatched Instagram Media</h1>`);
  for (const src of unmatchedSrc) {
    html.push(`<div><img src="${src.thumb}" /><br/><small>${path.basename(src.file)}</small></div>`);
  }
  html.push('</body></html>');

  await fs.writeFile(path.join(OUT_DIR, 'compare-report.html'), html.join('\n'), 'utf8');
  console.log('Comparison report written to', path.join(OUT_DIR, 'compare-report.html'));
})();