#!/usr/bin/env python3
import argparse, os, sys, json, shutil, subprocess, shlex
from pathlib import Path
from datetime import datetime
from PIL import Image, ImageOps

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp'}
VIDEO_EXTS = {'.mp4', '.mov', '.m4v', '.webm'}

def has_ffmpeg():
    try:
        subprocess.run(['ffmpeg', '-version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        return True
    except FileNotFoundError:
        return False

def slugify(name):
    keep = "abcdefghijklmnopqrstuvwxyz0123456789-_"
    s = name.lower().replace(' ', '-')
    s = ''.join(c for c in s if c in keep)
    while '--' in s:
        s = s.replace('--','-')
    return s.strip('-') or 'item'

def hash_bytes(p: Path, n=8):
    import hashlib
    h = hashlib.sha1(p.read_bytes()).hexdigest()
    return h[:n]

def process_image(src: Path, out_full: Path, out_thumb: Path, max_full=1280, max_thumb=400, quality=82, force=False):
    try:
        if not force and out_full.exists() and out_thumb.exists():
            return True
        im = Image.open(src).convert('RGB')
        im = ImageOps.exif_transpose(im)
        w, h = im.size
        # full
        if w > max_full:
            new_h = int(h * (max_full / w))
            im_full = im.resize((max_full, new_h), Image.LANCZOS)
        else:
            im_full = im.copy()
        out_full.parent.mkdir(parents=True, exist_ok=True)
        im_full.save(out_full, 'WEBP', quality=quality, method=6)
        # thumb
        if w > max_thumb:
            th_h = int(h * (max_thumb / w))
            im_thumb = im.resize((max_thumb, th_h), Image.LANCZOS)
        else:
            im_thumb = im.copy()
        out_thumb.parent.mkdir(parents=True, exist_ok=True)
        im_thumb.save(out_thumb, 'WEBP', quality=quality, method=6)
        return True
    except Exception as e:
        print(f"[image] skip {src.name}: {e}")
        return False

def process_video(src: Path, out_mp4: Path, out_poster: Path, ff_ok: bool, force=False):
    if not ff_ok:
        print(f"[video] ffmpeg not found; skipping {src.name}")
        return False
    try:
        if not force and out_mp4.exists() and out_poster.exists():
            return True
        out_mp4.parent.mkdir(parents=True, exist_ok=True)
        out_poster.parent.mkdir(parents=True, exist_ok=True)
        # 720p h264 with audio (AAC), mobile-safe pix_fmt, +faststart for web
        cmd1 = [
            'ffmpeg','-y','-nostdin','-i', str(src),
            '-vf',"scale='min(1280,iw)':-2,format=yuv420p",
            '-c:v','libx264','-preset','slow','-crf','23',
            '-c:a','aac','-b:a','160k','-ac','2',
            '-movflags','+faststart',
            str(out_mp4)
        ]
        subprocess.run(cmd1, check=True)
        # poster frame
        cmd2 = ['ffmpeg','-y','-nostdin','-i', str(out_mp4), '-ss','00:00:01.000','-vframes','1', str(out_poster)]
        subprocess.run(cmd2, check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"[video] ffmpeg error on {src.name}: {e}")
        return False

def guess_date(path: Path):
    try:
        ts = path.stat().st_mtime
        return datetime.fromtimestamp(ts).isoformat()
    except Exception:
        return None

def main():
    ap = argparse.ArgumentParser(description="Process Instagram export into web-ready assets + media.json")
    ap.add_argument('--in', dest='inp', required=True, help='Path to Instagram export (or any media folder)')
    ap.add_argument('--out', dest='out', required=True, help='Path to site root (contains index.html)')
    ap.add_argument('--exclude-dirs', default='messages,inbox,direct', help='Comma-separated dir names to ignore if they appear in path')
    ap.add_argument('--force', action='store_true', help='Overwrite existing outputs')
    args = ap.parse_args()

    inp = Path(args.inp)
    out_root = Path(args.out)
    if not inp.exists():
        print("Input path does not exist."); sys.exit(1)

    excludes = [s.strip().lower() for s in args.exclude_dirs.split(',') if s.strip()]
    def excluded(path: Path):
        parts = [p.lower() for p in path.parts]
        return any(x in parts for x in excludes)

    # Output dirs
    img_full = out_root / 'assets' / 'media' / 'img' / 'full'
    img_thumbs = out_root / 'assets' / 'media' / 'img' / 'thumbs'
    vid_dir = out_root / 'assets' / 'media' / 'video' / '720p'
    vid_posters = out_root / 'assets' / 'media' / 'video' / 'posters'
    for p in [img_full, img_thumbs, vid_dir, vid_posters]: p.mkdir(parents=True, exist_ok=True)

    ff_ok = has_ffmpeg()
    items = []; count_img = count_vid = 0

    for root, _, files in os.walk(inp):
        for fname in files:
            p = Path(root) / fname
            if excluded(p): 
                continue
            ext = p.suffix.lower()
            if ext in IMAGE_EXTS:
                base = slugify(p.stem) + "-" + hash_bytes(p)
                out_full = img_full / f"{base}.webp"
                out_thumb = img_thumbs / f"{base}.webp"
                if process_image(p, out_full, out_thumb, force=args.force):
                    items.append({
                        "id": base, "type": "image",
                        "src": str(out_full.relative_to(out_root).as_posix()),
                        "thumb": str(out_thumb.relative_to(out_root).as_posix()),
                        "date": guess_date(p), "caption": "", "hidden": False
                    }); count_img += 1
            elif ext in VIDEO_EXTS:
                base = slugify(p.stem) + "-" + hash_bytes(p)
                out_mp4 = vid_dir / f"{base}.mp4"
                out_poster = vid_posters / f"{base}.jpg"
                if process_video(p, out_mp4, out_poster, ff_ok, force=args.force):
                    items.append({
                        "id": base, "type": "video",
                        "src": str(out_mp4.relative_to(out_root).as_posix()),
                        "thumb": str(out_poster.relative_to(out_root).as_posix()),
                        "date": guess_date(p), "caption": "", "hidden": False
                    }); count_vid += 1

    # newest first for nicer browsing
    items.sort(key=lambda x: (x.get("date") or ""), reverse=True)

    with open(out_root / 'media.json', 'w', encoding='utf-8') as f:
        json.dump(items, f, ensure_ascii=False, indent=2)

    print(f"Done. Images: {count_img}, Videos: {count_vid}")
    print(f"Wrote {out_root / 'media.json'}")
    if excludes:
        print("Excluded dirs:", ', '.join(excludes))

if __name__ == "__main__":
    main()
