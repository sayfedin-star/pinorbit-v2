import fs from 'node:fs';

const content = fs.readFileSync('src/pages/pinarchive.astro', 'utf8');
const idMatches = [...content.matchAll(/id=['"]([^'"]+)['"]/g)];
const ids = [...new Set(idMatches.map((m) => m[1]))].sort();

const dataMatches = [...content.matchAll(/(data-[a-z0-9-]+)(?:=['"][^'"]*['"])?/g)];
const dataAttrs = [...new Set(dataMatches.map((m) => m[1]))].sort();

fs.writeFileSync('.baseline-pinarchive-ids.json', JSON.stringify({ ids, dataAttrs }, null, 2));
console.log(`Extracted ${ids.length} unique DOM IDs and ${dataAttrs.length} data-* attributes from pinarchive.astro`);

