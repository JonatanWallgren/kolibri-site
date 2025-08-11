#!/usr/bin/env node
"use strict";

/**
 * Kolibri — Instagram posts-only ingest (Node)
 * - Reads posts_*.json from the IG export
 * - Processes only "grid posts" media referenced in those files
 * - Images -> WEBP (1280w full, 400w thumbs)
 * - Videos -> MP4 (H.264 + AAC, 720p max), with poster JPG
 * - Keeps real post timestamp from `creation_timestamp`
 * - Writes media.json compatible with your site (newest-first)
 *
 * Usage:
 *   node ingest-posts.js --in "/path/to/instagram-export" --out .
 * Options:
 *   --in         Input export directory (required)
 *   --out        Site root (where index.html lives) (required)
 *   --force      Overwrite existing outputs
 *   --maxW       Full image max width (default 1280)
 *   --thumbW     Thumb width (default 400)
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const sharp = require("sharp");

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm"]);

function argVal(flag, def = undefined) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const IN_DIR = argVal("--in");
const OUT_DIR = argVal("--out");
const FORCE = process.argv.includes("--force");
const MAX_W = parseInt(argVal("--maxW", "1280"), 10);
const THUMB_W = parseInt(argVal("--thumbW", "400"), 10);

if (!IN_DIR || !OUT_DIR) {
  console.error("Usage: node ingest-posts.js --in \"/path/to/IG_export\" --out . [--force] [--maxW 1280] [--thumbW 400]");
  process.exit(1);
}

// Ensure ffmpeg exists
async function hasFfmpeg() {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-version"]);
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function slugify(str) {
  return (str || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

async function hashFile(filePath, n = 8) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha1");
    const s = fs.createReadStream(filePath);
    s.on("error", reject);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex").slice(0, n)));
  });
}

async function* walk(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

// Find all posts_*.json in export (new format usually under content/)
async function findPostJsonFiles(root) {
  const out = [];
  for await (const p of walk(root)) {
    const base = path.basename(p).toLowerCase();
    if (base.startsWith("posts_") && base.endsWith(".json")) {
      out.push(p);
    }
  }
  return out.sort();
}

// Read and parse posts JSON files, return a flat array of post objects
async function readPosts(root) {
  const files = await findPostJsonFiles(root);
  if (files.length === 0) {
    throw new Error("No posts_*.json files found under the input directory.");
  }
  const posts = [];
  for (const f of files) {
    try {
      const txt = await fsp.readFile(f, "utf-8");
      const arr = JSON.parse(txt);
      if (Array.isArray(arr)) {
        posts.push(...arr);
      }
    } catch (e) {
      console.warn("Skip bad JSON:", f, e.message);
    }
  }
  return posts;
}

function resolveMediaPath(root, uri) {
  // IG JSON "uri" is usually a relative path inside the export
  // e.g., "media/20250101_123456_1234567890.jpg"
  // Sometimes it's under "content" or similar — join root+uri first
  const p = path.resolve(root, uri);
  return p;
}

async function processImage(src, outFull, outThumb) {
  if (!FORCE && fs.existsSync(outFull) && fs.existsSync(outThumb)) return true;
  try {
    const im = sharp(src, { failOn: "none" }).rotate();
    // Full
    const fullBuf = await im.clone().resize({ width: MAX_W, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    ensureDir(path.dirname(outFull));
    await fsp.writeFile(outFull, fullBuf);
    // Thumb
    const thBuf = await im.clone().resize({ width: THUMB_W, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    ensureDir(path.dirname(outThumb));
    await fsp.writeFile(outThumb, thBuf);
    return true;
  } catch (e) {
    console.warn("[image] skip", src, e.message);
    return false;
  }
}

async function ffmpegPoster(mp4, poster) {
  await new Promise((resolve, reject) => {
    const args = ["-y", "-nostdin", "-i", mp4, "-ss", "00:00:01.000", "-vframes", "1", poster];
    const p = spawn("ffmpeg", args, { stdio: "ignore" });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg poster failed"))));
  });
}

async function processVideo(src, outMp4, outPoster) {
  if (!FORCE && fs.existsSync(outMp4) && fs.existsSync(outPoster)) return true;
  try {
    ensureDir(path.dirname(outMp4));
    ensureDir(path.dirname(outPoster));
    const args = [
      "-y",
      "-nostdin",
      "-i",
      src,
      "-vf",
      "scale='min(1280,iw)':-2,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      outMp4,
    ];
    await new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", args, { stdio: "ignore" });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg encode failed"))));
    });
    await ffmpegPoster(outMp4, outPoster);
    return true;
  } catch (e) {
    console.warn("[video] skip", src, e.message);
    return false;
  }
}

function isImageExt(p) {
  return IMAGE_EXTS.has(path.extname(p).toLowerCase());
}
function isVideoExt(p) {
  return VIDEO_EXTS.has(path.extname(p).toLowerCase());
}

(async function main() {
  if (!(await hasFfmpeg())) {
    console.error("ffmpeg not found in PATH. Install it (e.g., `brew install ffmpeg`).");
    process.exit(1);
  }

  const posts = await readPosts(IN_DIR);
  // Output dirs
  const imgFullDir = path.join(OUT_DIR, "assets/media/img/full");
  const imgThumbDir = path.join(OUT_DIR, "assets/media/img/thumbs");
  const vidDir = path.join(OUT_DIR, "assets/media/video/720p");
  const vidPosters = path.join(OUT_DIR, "assets/media/video/posters");
  [imgFullDir, imgThumbDir, vidDir, vidPosters].forEach(ensureDir);

  const items = [];
  let countImg = 0,
    countVid = 0;

  // For each post, IG JSON example keys:
  // { "title"?, "caption"?, "creation_timestamp": 1712345678, "media": [{ "uri": "media/xxx.jpg" }, ...] }
  for (const post of posts) {
    const ts = post?.creation_timestamp ? new Date(post.creation_timestamp * 1000) : null;
    const iso = ts ? ts.toISOString() : null;
    const caption = post?.title || post?.caption || "";

    const mediaArr = Array.isArray(post?.media) ? post.media : [];
    for (const m of mediaArr) {
      const uri = m?.uri;
      if (!uri) continue;
      const abs = resolveMediaPath(IN_DIR, uri);
      if (!fs.existsSync(abs)) {
        // Try alternative guess if export wraps content under "content/"
        const alt = path.resolve(IN_DIR, "content", uri);
        if (fs.existsSync(alt)) {
          // use alt
          await handleOne(alt);
        } else {
          console.warn("[missing]", uri);
        }
      } else {
        await handleOne(abs);
      }
    }

    async function handleOne(srcPath) {
      const base = path.basename(srcPath);
      const stem = path.parse(base).name;
      const hash = await hashFile(srcPath, 8);
      const id = `${slugify(stem)}-${hash}`;

      if (isImageExt(srcPath)) {
        const outFull = path.join(imgFullDir, `${id}.webp`);
        const outThumb = path.join(imgThumbDir, `${id}.webp`);
        const ok = await processImage(srcPath, outFull, outThumb);
        if (ok) {
          items.push({
            id,
            type: "image",
            src: path.relative(OUT_DIR, outFull).split(path.sep).join("/"),
            thumb: path.relative(OUT_DIR, outThumb).split(path.sep).join("/"),
            date: iso,
            caption,
            hidden: false,
          });
          countImg++;
        }
      } else if (isVideoExt(srcPath)) {
        const outMp4 = path.join(vidDir, `${id}.mp4`);
        const outPoster = path.join(vidPosters, `${id}.jpg`);
        const ok = await processVideo(srcPath, outMp4, outPoster);
        if (ok) {
          items.push({
            id,
            type: "video",
            src: path.relative(OUT_DIR, outMp4).split(path.sep).join("/"),
            thumb: path.relative(OUT_DIR, outPoster).split(path.sep).join("/"),
            date: iso,
            caption,
            hidden: false,
          });
          countVid++;
        }
      } else {
        // ignore unknown types
      }
    }
  }

  // newest-first (true post dates)
  items.sort((a, b) => {
    const ta = a?.date ? Date.parse(a.date) : 0;
    const tb = b?.date ? Date.parse(b.date) : 0;
    if (tb !== ta) return tb - ta;
    return String(b?.id || "").localeCompare(String(a?.id || ""));
  });

  const mediaJsonPath = path.join(OUT_DIR, "media.json");
  await fsp.writeFile(mediaJsonPath, JSON.stringify(items, null, 2), "utf-8");

  console.log(`Done. Images: ${countImg}, Videos: ${countVid}`);
  console.log(`Wrote ${path.relative(process.cwd(), mediaJsonPath)}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
