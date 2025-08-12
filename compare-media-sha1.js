const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// === Config: Adjust paths here ===
const originalMediaDir = '/Users/jonatanwallgren/Downloads/instagram-kolibrinkpg-2025-08-09-lgncXhkU/media'; // path to Instagram dump
const transcodedMediaDir = './media';     // path to your processed output

// === Utility: Recursively walk files ===
function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) out.push(fullPath);
    }
  }
  return out;
}

// === Utility: SHA1 hash of a file ===
function hashFileSync(filepath) {
  const buffer = fs.readFileSync(filepath);
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

// === Step 1: Hash original files ===
console.log('Hashing original Instagram files...');
const originalHashes = new Map();
for (const file of walkFiles(originalMediaDir)) {
  try {
    const hash = hashFileSync(file);
    originalHashes.set(hash, file);
  } catch (e) {
    console.warn(`Could not read original: ${file}`);
  }
}

// === Step 2: Hash transcoded files ===
console.log('Hashing transcoded media files...');
const transcodedHashes = new Set();
for (const file of walkFiles(transcodedMediaDir)) {
  try {
    const hash = hashFileSync(file);
    transcodedHashes.add(hash);
  } catch (e) {
    console.warn(`Could not read transcoded: ${file}`);
  }
}

// === Step 3: Report missing files ===
const missing = [];
for (const [hash, file] of originalHashes.entries()) {
  if (!transcodedHashes.has(hash)) {
    missing.push(file);
  }
}

console.log(`\n==== Missing files (${missing.length}) ====`);
for (const f of missing) {
  console.log(f);
}
