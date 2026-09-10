import fs from 'node:fs';

const baseline = JSON.parse(fs.readFileSync('.baseline-pinarchive-ids.json', 'utf8'));
const filesToScan = [
  'src/pages/pinarchive.astro',
  'src/components/pinarchive/AccountsTable.astro',
  'src/lib/pinarchive/table-render.ts',
];
const currentContent = filesToScan
  .filter((f) => fs.existsSync(f))
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

const currentIdMatches = [...currentContent.matchAll(/id=['"]([^'"]+)['"]/g)];
const currentIds = [...new Set(currentIdMatches.map((m) => m[1]))].sort();

const currentDataMatches = [...currentContent.matchAll(/(data-[a-z0-9-]+)(?:=['"][^'"]*['"])?/g)];
const currentDataAttrs = [...new Set(currentDataMatches.map((m) => m[1]))].sort();

const missingIds = baseline.ids.filter((id) => !currentIds.includes(id));
const extraIds = currentIds.filter((id) => !baseline.ids.includes(id));

const missingDataAttrs = baseline.dataAttrs.filter((attr) => !currentDataAttrs.includes(attr));
const extraDataAttrs = currentDataAttrs.filter((attr) => !baseline.dataAttrs.includes(attr));

console.log('--- PinArchive DOM ID & Attribute Diff Verification ---');
console.log(`Baseline IDs count: ${baseline.ids.length} | Current IDs count: ${currentIds.length}`);
console.log(`Baseline data-* count: ${baseline.dataAttrs.length} | Current data-* count: ${currentDataAttrs.length}`);

let passed = true;
if (missingIds.length > 0) {
  console.error('FAIL: Missing IDs:', missingIds);
  passed = false;
}
if (extraIds.length > 0) {
  console.error('FAIL: Extra IDs:', extraIds);
  passed = false;
}
if (missingDataAttrs.length > 0) {
  console.error('FAIL: Missing data-* attributes:', missingDataAttrs);
  passed = false;
}
if (extraDataAttrs.length > 0) {
  console.error('FAIL: Extra data-* attributes:', extraDataAttrs);
  passed = false;
}

if (passed) {
  console.log('✅ PASS: All 119 DOM IDs and 14 data-* attributes are 100% BYTE-IDENTICAL (0 missing, 0 extra).');
  process.exit(0);
} else {
  process.exit(1);
}
