// prune-unused-media.js
const fs = require('fs');
const path = require('path');

const mediaJson = JSON.parse(fs.readFileSync('media.json'));
const usedFiles = new Set();

for (const item of mediaJson) {
  if (item.src) usedFiles.add(path.basename(item.src));
  if (item.thumb) usedFiles.add(path.basename(item.thumb));
}

const mediaDir = './media/';
for (const file of fs.readdirSync(mediaDir)) {
  if (!usedFiles.has(file)) {
    console.log('Unused file:', file);
    // Uncomment the line below to actually delete
    // fs.unlinkSync(path.join(mediaDir, file));
  }
}
