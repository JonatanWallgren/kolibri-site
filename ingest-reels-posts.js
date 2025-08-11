#!/usr/bin/env node
"use strict";

/**
 * Kolibri ingest — v7
 * - Scans IG export: /media/posts, /media/reels, /media/other
 * - Date choice (best → worst): JSON -> fuzzy JSON by numeric ID -> ffprobe -> folder(YYYYMM) -> file mtime
 * - Skips /media/recently_deleted
 * - Robust video pipeline: transcode -> remux -> synth (audio-only → black video), then poster fallback
 * - Progress bars, concurrency, debug, skipped-file logging to ingest-skipped.log
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const sharp = require("sharp");

// ---------- CLI ----------
const args = process.argv.slice(2);
function getArg(flag, def){ const i=args.indexOf(flag); return i>=0 ? args[i+1] : def; }
const IN_DIR  = getArg("--in");
const OUT_DIR = getArg("--out");
const FORCE   = args.includes("--force");
const DEBUG   = args.includes("--debug");
const NO_PROGRESS = args.includes("--no-progress");
const CONCURRENCY = Math.max(1, Number(getArg("--concurrency", 3)) || 3);

if(!IN_DIR || !OUT_DIR){
  console.error(`Usage: node ingest-reels-posts.js --in "/path/to/IG_export" --out . [--force] [--debug] [--concurrency 3] [--no-progress]`);
  process.exit(1);
}

// ---------- constants ----------
const IMAGE_EXTS = new Set([".jpg",".jpeg",".png",".webp"]);
const VIDEO_EXTS = new Set([".mp4",".mov",".m4v",".webm"]);
const MAX_W = 1280, THUMB_W = 400;

const NOW = Date.now();
const MIN_TS = Date.UTC(2010,0,1);
const MAX_TS = NOW + 3*24*3600*1000;
const plausible = (t) => Number.isFinite(t) && t >= MIN_TS && t <= MAX_TS;

// ---------- utils ----------
function ensureDir(p){ fs.mkdirSync(p,{recursive:true}); }
function slugify(s){ return (s||"").normalize("NFKD").replace(/[^\w\s-]/g,"").trim().replace(/\s+/g,"-").toLowerCase(); }
async function hashFile(p, n=8){
  return await new Promise((res,rej)=>{
    const h=crypto.createHash("sha1");
    fs.createReadStream(p).on("error",rej).on("data",d=>h.update(d)).on("end",()=>res(h.digest("hex").slice(0,n)));
  });
}
async function hasBin(bin){
  return await new Promise((ok)=>{
    const p=spawn(bin,["-version"]);
    p.on("error",()=>ok(false));
    p.on("close",(c)=>ok(c===0));
  });
}
async function* walk(dir){
  const ents = await fsp.readdir(dir, {withFileTypes:true});
  for(const e of ents){
    const full = path.join(dir, e.name);
    if(e.isDirectory()) yield* walk(full);
    else yield full;
  }
}
function isImage(p){ return IMAGE_EXTS.has(path.extname(p).toLowerCase()); }
function isVideo(p){ return VIDEO_EXTS.has(path.extname(p).toLowerCase()); }
function extractNumericTokens(name){ return (name.match(/\d{10,}/g) || []); }

// ---------- progress ----------
const SHOW_PROGRESS = !NO_PROGRESS && process.stdout.isTTY;
const spin = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
function bar(p, w=28){ const f=Math.round(p*w); return "█".repeat(f)+"░".repeat(Math.max(0,w-f)); }
function fmtETA(sec){ if(!(sec>0)) return "—"; const m=Math.floor(sec/60), s=Math.floor(sec%60); return m?`${m}m${s}s`:`${s}s`; }
function makeProgress(total, label){
  const state={total, done:0, start:Date.now(), tick:0, label};
  let timer=null;
  function render(){
    if(!SHOW_PROGRESS) return;
    const pct = state.total ? state.done/state.total : 0;
    const elapsed = (Date.now()-state.start)/1000;
    const rate = state.done/Math.max(elapsed,0.001);
    const remain = rate>0 ? (state.total-state.done)/rate : Infinity;
    const f = spin[state.tick++%spin.length];
    const line = `${f} ${label}  [${bar(pct)}] ${Math.round(pct*100)}%  ${state.done}/${state.total}  ETA ${fmtETA(remain)}`;
    process.stdout.write("\r"+line.padEnd(process.stdout.columns||80));
  }
  function start(){ if(SHOW_PROGRESS) timer=setInterval(render,100); }
  function stop(note){ if(!SHOW_PROGRESS) return; clearInterval(timer); render(); process.stdout.write("\n"); if(note) console.log(note); }
  function inc(n=1){ state.done+=n; }
  return { inc, start, stop, state };
}

// ---------- metadata from JSON ----------
const metaDir = path.join(IN_DIR, "your_instagram_activity", "media");
const jsonMatch = /^(posts?|reels?|stories|igtv_videos)(?:_.*)?\.json$/i;

function getTsMs(rec){
  const cand = rec?.creation_timestamp ?? rec?.taken_at ?? rec?.taken_at_timestamp ?? rec?.created_at ?? null;
  if(cand){ const n=Number(cand); if(Number.isFinite(n)) return String(n).length<13 ? n*1000 : n; }
  if(Array.isArray(rec?.media) && rec.media[0]?.creation_timestamp){
    const n = Number(rec.media[0].creation_timestamp);
    if(Number.isFinite(n)) return String(n).length<13 ? n*1000 : n;
  }
  return null;
}
function getCaption(rec){ return rec?.title || rec?.caption || rec?.description || ""; }

function collectUrisDeep(node, out){
  if(!node) return;
  if(Array.isArray(node)){ for(const v of node) collectUrisDeep(v, out); return; }
  if(typeof node === "object"){ for(const v of Object.values(node)) collectUrisDeep(v, out); return; }
  if(typeof node === "string"){
    const s = node.trim();
    const base = path.basename(s.split("?")[0]);
    const ext = path.extname(base).toLowerCase();
    if(IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext)) out.add(base);
  }
}

async function buildMetaIndex(){
  const byBase = new Map();         // "filename.ext" -> { ts, caption }
  const byNumericId = new Map();    // "1791234..."   -> { ts, caption }
  if(!fs.existsSync(metaDir)) return { byBase, byNumericId };

  const files = (await fsp.readdir(metaDir)).filter(f => jsonMatch.test(f));
  const pb = makeProgress(files.length, "Indexing JSON");
  pb.start();

  for(const fn of files){
    try{
      const raw = await fsp.readFile(path.join(metaDir, fn), "utf-8");
      const obj = JSON.parse(raw);
      const records = Array.isArray(obj) ? obj : (Array.isArray(obj?.media) ? obj.media : []);
      for(const rec of records){
        const ts = getTsMs(rec);
        const caption = getCaption(rec);
        const uris = new Set(); collectUrisDeep(rec, uris);
        for(const base of uris){
          if(!byBase.has(base)) byBase.set(base, { ts, caption });
          for(const token of extractNumericTokens(base)){
            if(!byNumericId.has(token)) byNumericId.set(token, { ts, caption });
          }
        }
      }
    }catch(e){
      if(DEBUG) console.warn("JSON parse fail:", fn, e.message);
    }
    pb.inc();
  }
  pb.stop(`Indexed ${byBase.size} direct URIs and ${byNumericId.size} numeric tokens.`);
  if(DEBUG) console.log("JSON files used:", files);
  return { byBase, byNumericId };
}

// ---------- ffprobe helpers & folder date ----------
async function ffprobeCreationTime(src){
  return await new Promise((res)=>{
    const p = spawn("ffprobe",[
      "-v","error",
      "-show_entries","format_tags=creation_time",
      "-of","default=nw=1:nk=1",
      src
    ]);
    let out=""; p.stdout.on("data",d=>out+=d);
    p.on("error",()=>res(null));
    p.on("close",()=>{
      const s = out.trim();
      const t = Date.parse(s);
      res(Number.isFinite(t) ? t : null);
    });
  });
}
async function probeStreams(src){
  return await new Promise((res)=>{
    const p = spawn("ffprobe",[
      "-v","error","-print_format","json",
      "-show_streams","-select_streams","v:a",
      src
    ]);
    let out=""; p.stdout.on("data",d=>out+=d);
    p.on("error",()=>res({ hasVideo:false, hasAudio:false }));
    p.on("close",()=>{
      try{
        const j = JSON.parse(out||"{}");
        const streams = j.streams || [];
        const hasVideo = streams.some(s=>s.codec_type==="video");
        const hasAudio = streams.some(s=>s.codec_type==="audio");
        res({ hasVideo, hasAudio });
      }catch{ res({ hasVideo:false, hasAudio:false }); }
    });
  });
}
function tsFromFolder(absPath){
  const m = absPath.replace(/\\/g,"/").match(/\/media\/(posts|reels)\/(20\d{2})(\d{2})\//);
  if(!m) return null;
  const y = Number(m[2]), mo = Number(m[3])-1;
  return Date.UTC(y, mo, 15, 12, 0, 0);
}

// ---------- scanning ----------
async function collectDiskMedia(){
  const roots = [
    path.join(IN_DIR, "media", "posts"),
    path.join(IN_DIR, "media", "reels"),
    path.join(IN_DIR, "media", "other"),
  ].filter(fs.existsSync);

  const files = [];
  const pb = makeProgress(roots.length, "Scanning folders");
  pb.start();

  for(const r of roots){
    for await (const f of walk(r)){
      const rel = f.replace(/\\/g,"/");
      if(rel.includes("/media/recently_deleted/")) continue;
      const ext = path.extname(f).toLowerCase();
      if(IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext)) files.push(f);
    }
    pb.inc();
  }
  pb.stop(`Found ${files.length} media files on disk.`);
  if(DEBUG){
    const img = files.filter(isImage).length;
    const vid = files.filter(isVideo).length;
    const byRoot = {};
    for (const f of files) {
      const seg = f.split(/\/media\//)[1]?.split("/")[0] || "unknown";
      byRoot[seg] = (byRoot[seg] || 0) + 1;
    }
    console.log(`Images: ${img}, Videos: ${vid}`);
    console.log("By folder:", byRoot);
  }
  return files;
}

// ---------- skip logging ----------
const SKIP_LOG = path.join(OUT_DIR, "ingest-skipped.log");
async function logSkip(abs, reason) {
  const line = `[${new Date().toISOString()}] ${reason} :: ${abs}\n`;
  await fsp.appendFile(SKIP_LOG, line).catch(()=>{});
}

// ---------- processors ----------
async function processImage(src, outFull, outThumb){
  if(!FORCE && fs.existsSync(outFull) && fs.existsSync(outThumb)) return true;
  try{
    const im = sharp(src, {failOn:"none"}).rotate();
    const full = await im.clone().resize({width:MAX_W, withoutEnlargement:true}).webp({quality:82}).toBuffer();
    ensureDir(path.dirname(outFull)); await fsp.writeFile(outFull, full);
    const th = await im.clone().resize({width:THUMB_W, withoutEnlargement:true}).webp({quality:82}).toBuffer();
    ensureDir(path.dirname(outThumb)); await fsp.writeFile(outThumb, th);
    return true;
  }catch(e){
    console.warn("[image] skip", src, e.message);
    await logSkip(src, "image process failed: "+e.message);
    return false;
  }
}

async function ffmpegPoster(mp4, jpg){
  await new Promise((res,rej)=>{
    const p=spawn("ffmpeg",["-y","-nostdin","-i",mp4,"-ss","00:00:01.000","-vframes","1",jpg],{stdio:"ignore"});
    p.on("error",rej); p.on("close",c=>c===0?res():rej(new Error("poster failed")));
  });
}
async function makeSolidPoster(jpg, size="720x1280"){
  await new Promise((res,rej)=>{
    const p = spawn("ffmpeg",["-y","-f","lavfi","-i",`color=c=black:s=${size}:d=1`,"-frames:v","1",jpg],{stdio:"ignore"});
    p.on("error",rej); p.on("close",c=>c===0?res():rej(new Error("solid poster failed")));
  });
}
async function tryMakePoster(srcForFrame, outPoster){
  try{ await ffmpegPoster(srcForFrame, outPoster); return true; }
  catch{ /* next */ }
  try{ await makeSolidPoster(outPoster); return true; }
  catch{ return false; }
}

async function processVideo(src, outMp4, outPoster){
  if(!FORCE && fs.existsSync(outMp4) && fs.existsSync(outPoster)) return true;
  ensureDir(path.dirname(outMp4)); ensureDir(path.dirname(outPoster));

  const transcode = () => new Promise((res,rej)=>{
    const args=["-y","-nostdin","-i",src,
      "-vf","scale='min(1280,iw)':-2,format=yuv420p",
      "-c:v","libx264","-preset","slow","-crf","23",
      "-c:a","aac","-b:a","160k","-ac","2",
      "-movflags","+faststart", outMp4];
    const p=spawn("ffmpeg",args,{stdio:"ignore"});
    p.on("error",rej); p.on("close",c=>c===0?res():rej(new Error("encode failed")));
  });

  const remux = () => new Promise((res,rej)=>{
    const p=spawn("ffmpeg",["-y","-nostdin","-i",src,"-c","copy","-movflags","+faststart",outMp4],{stdio:"ignore"});
    p.on("error",rej); p.on("close",c=>c===0?res():rej(new Error("remux failed")));
  });

  const synth = async () => {
    const { hasAudio } = await probeStreams(src);
    if(!hasAudio) throw new Error("no audio to synth");
    await new Promise((res,rej)=>{
      const args=["-y",
        "-f","lavfi","-i","color=c=black:s=720x1280:d=600",
        "-i",src,"-shortest",
        "-map","0:v:0","-map","1:a:0",
        "-c:v","libx264","-preset","slow","-crf","23",
        "-c:a","aac","-b:a","160k","-ac","2",
        "-movflags","+faststart", outMp4];
      const p=spawn("ffmpeg",args,{stdio:"ignore"});
      p.on("error",rej); p.on("close",c=>c===0?res():rej(new Error("synth failed")));
    });
  };

  try {
    await transcode();
  } catch (e1) {
    try {
      await remux();
    } catch (e2) {
      try {
        await synth();
      } catch (e3) {
        await logSkip(src, `video failed: transcode -> ${e1.message}; remux -> ${e2.message}; synth -> ${e3.message}`);
        return false;
      }
    }
  }

  const posterOK = await tryMakePoster(outMp4, outPoster) || await tryMakePoster(src, outPoster);
  if(!posterOK){
    await logSkip(src, "poster failed; using solid placeholder");
    try { await makeSolidPoster(outPoster); } catch {}
  }
  return true;
}

// ---------- async pool ----------
async function asyncPool(limit, tasks, onProgress){
  const ret = [];
  let i = 0, active = 0;
  return await new Promise((resolve)=>{
    const next = ()=>{
      if(i >= tasks.length && active === 0) return resolve(Promise.all(ret));
      while(active < limit && i < tasks.length){
        const idx = i++;
        active++;
        const p = tasks[idx]().catch(()=>{}).finally(()=>{ onProgress?.(); active--; next(); });
        ret.push(p);
      }
    };
    next();
  });
}

// ---------- main ----------
(async function main(){
  const hasFFMPEG = await hasBin("ffmpeg");
  const hasFFPROBE = await hasBin("ffprobe");
  if(!hasFFMPEG){ console.error("ffmpeg not found (install e.g. `brew install ffmpeg`)"); process.exit(1); }
  if(!hasFFPROBE && DEBUG){ console.warn("ffprobe not found — container timestamps will be skipped."); }

  // Prepare out dirs
  const imgFullDir = path.join(OUT_DIR,"assets/media/img/full");
  const imgThumbDir= path.join(OUT_DIR,"assets/media/img/thumbs");
  const vidDir     = path.join(OUT_DIR,"assets/media/video/720p");
  const vidPosters = path.join(OUT_DIR,"assets/media/video/posters");
  [imgFullDir,imgThumbDir,vidDir,vidPosters].forEach(ensureDir);

  // Start
  const { byBase, byNumericId } = await buildMetaIndex();
  const diskFiles = await collectDiskMedia();

  const items = [];
  let countImg=0, countVid=0;

  const tasks = diskFiles.map(abs => async () => {
    const ext = path.extname(abs).toLowerCase();
    const base = path.basename(abs);
    const stem = path.parse(base).name;
    const hash = await hashFile(abs, 8);
    const id = `${slugify(stem)}-${hash}`;

    // JSON meta: direct base, else fuzzy numeric id
    let meta = byBase.get(base) || null;
    if(!meta){
      for(const tok of extractNumericTokens(base)){
        if(byNumericId.has(tok)){ meta = byNumericId.get(tok); break; }
      }
    }

    const stat = await fsp.stat(abs);
    let ts = meta?.ts ?? null;
    if(!plausible(ts)) ts = null;

    let probeTs = null;
    if(!ts && isVideo(abs) && hasFFPROBE){
      probeTs = await ffprobeCreationTime(abs);
      if(!plausible(probeTs)) probeTs = null;
    }

    let folderTs = tsFromFolder(abs);
    if(!plausible(folderTs)) folderTs = null;

    ts = ts ?? probeTs ?? folderTs ?? stat.mtimeMs;
    const dateISO = new Date(ts).toISOString();
    const caption = meta?.caption ?? "";

    if(isImage(abs)){
      const outFull  = path.join(imgFullDir,  `${id}.webp`);
      const outThumb = path.join(imgThumbDir, `${id}.webp`);
      if(await processImage(abs, outFull, outThumb)){
        items.push({
          id, type:"image",
          src: path.relative(OUT_DIR,outFull).split(path.sep).join("/"),
          thumb: path.relative(OUT_DIR,outThumb).split(path.sep).join("/"),
          ts, date: dateISO, caption, hidden:false
        });
        countImg++;
      }
    }else if(isVideo(abs)){
      const outMp4   = path.join(vidDir,     `${id}.mp4`);
      const outPoster= path.join(vidPosters, `${id}.jpg`);
      if(await processVideo(abs, outMp4, outPoster)){
        items.push({
          id, type:"video",
          src: path.relative(OUT_DIR,outMp4).split(path.sep).join("/"),
          thumb: path.relative(OUT_DIR,outPoster).split(path.sep).join("/"),
          ts, date: dateISO, caption, hidden:false
        });
        countVid++;
      }
    }

    if(DEBUG && !meta && (folderTs || probeTs)){
      console.warn("[no JSON match] used", folderTs ? "folderTs" : (probeTs ? "ffprobeTs" : "mtime"), base, "->", dateISO);
    }
  });

  const pb = makeProgress(tasks.length, `Processing media (×${CONCURRENCY})`);
  pb.start();
  await asyncPool(CONCURRENCY, tasks, ()=> pb.inc());
  pb.stop();

  // de-dupe + sort
  const seen = new Set();
  const out = [];
  for(const it of items){
    const key = it.type + "|" + it.src;
    if(seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  out.sort((a,b)=>(b.ts||0)-(a.ts||0));

  await fsp.writeFile(path.join(OUT_DIR,"media.json"), JSON.stringify(out, null, 2), "utf-8");

  // report
  const byYear = {};
  for (const it of out) {
    const y = new Date(it.ts).getUTCFullYear();
    byYear[y] = (byYear[y]||0) + 1;
  }
  console.log(`\nDone. Images: ${countImg}, Videos: ${countVid}. Total: ${out.length}`);
  console.log("Items by year:", byYear);

  try{
    const skipped = fs.existsSync(SKIP_LOG) ? (await fsp.readFile(SKIP_LOG,"utf-8")).trim().split("\n").filter(Boolean).length : 0;
    if(skipped>0){
      console.log(`Skipped files: ${skipped} (see ${path.relative(OUT_DIR, SKIP_LOG)})`);
    } else {
      console.log("Skipped files: 0");
    }
  }catch{}
})();