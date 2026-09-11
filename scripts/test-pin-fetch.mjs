#!/usr/bin/env node
/**
 * Probe: fetches a single pin from Pinterest public HTML and extracts enriched metrics.
 * Usage: node scripts/test-pin-fetch.mjs [pin_id]
 */

import { writeFileSync } from 'node:fs';
import { PINTEREST_PAGE_HEADERS as HEADERS, extractPinData } from './lib/pinterest.mjs';

const PIN_ID = process.argv[2] || '1079245498222414527';

async function main() {
  console.log(`\nFetching pin ${PIN_ID} ...\n`);
  const res = await fetch(`https://www.pinterest.com/pin/${PIN_ID}/`, { headers: HEADERS });
  console.log(`HTTP ${res.status} ${res.statusText}`);

  if (res.status !== 200) {
    console.log('Pinterest returned non-200. Body preview:');
    const text = await res.text();
    console.log(text.substring(0, 500));
    process.exit(1);
  }

  const html = await res.text();
  console.log(`HTML size: ${(html.length / 1024).toFixed(0)} KB`);
  console.log(`Has __PWS_DATA__: ${html.includes('__PWS_DATA__')}`);
  console.log(`Has pin_id: ${html.includes(PIN_ID)}`);
  console.log(`Has aggregated_stats: ${html.includes('aggregated_stats')}`);
  console.log(`Has visual_annotation: ${html.includes('visual_annotation')}\n`);

  const data = extractPinData(html, PIN_ID);

  if (data) {
    console.log('Extraction succeeded!');
    console.log(`Saves: ${data.saves}`);
    console.log(`Repins: ${data.repins}`);
    console.log(`Comments: ${data.comments}`);
    const annNames = (data.annotations || []).map(a => a.name || a);
    console.log(`Annotations (${annNames.length}): ${annNames.slice(0, 5).join(', ')}${annNames.length > 5 ? '...' : ''}`);
    if (data.seo_category) console.log(`SEO Category: ${data.seo_category}`);
    if (data.canonical_pin_id) console.log(`Canonical pin: ${data.canonical_pin_id}`);
    if (data.share_count !== undefined) console.log(`Share count: ${data.share_count}`);
    if (data.follower_count !== undefined) console.log(`Follower count: ${data.follower_count}`);
    if (data.title) console.log(`Title: ${data.title.substring(0, 60)}`);
  } else {
    console.log('Could not extract pin data from HTML.');
    console.log('Saving HTML to debug-pin.html for inspection...');
    writeFileSync('debug-pin.html', html);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal probe error:', err);
  process.exit(1);
});
