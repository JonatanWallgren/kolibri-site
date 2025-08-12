#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (let file of list) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      results = results.concat(walk(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function relativeSet(baseDir, files) {
  const baseLen = baseDir.length + 1;
  return new Set(files.map(f => f.slice(baseLen)));
}

function compareDirs(refDir, targetDir) {
  const refFiles = walk(refDir);
  const targetFiles = walk(targetDir);

  const refSet = relativeSet(refDir, refFiles);
  const targetSet = relativeSet(targetDir, targetFiles);

  const missing = [...refSet].filter(f => !targetSet.has(f));
  const extra = [...targetSet].filter(f => !refSet.has(f));

  console.log(`\nReference dir: ${refDir}`);
  console.log(`Target dir:    ${targetDir}`);
  console.log(`\n--- Missing in target:`);
  if (missing.length) {
    for (const f of missing) console.log('  -', f);
  } else {
    console.log('  (none)');
  }

  console.log(`\n--- Extra in target:`);
  if (extra.length) {
    for (const f of extra) console.log('  +', f);
  } else {
    console.log('  (none)');
  }
  console.log('');
}

// === Entry point ===

if (process.argv.length !== 4) {
  console.error('Usage: node compare-media-folders.js /path/to/instagram/media /path/to/kolibri/media');
  process.exit(1);
}

const [refDir, targetDir] = process.argv.slice(2);

if (!fs.existsSync(refDir) || !fs.existsSync(targetDir)) {
  console.error('One or both directories do not exist.');
  process.exit(1);
}

compareDirs(refDir, targetDir);
