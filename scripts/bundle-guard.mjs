import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');

let errors = [];
let warnings = [];

// New domain modules forbidden in client <script> tags
const FORBIDDEN_DOMAIN_MODULES = [
  'accounts',
  'boards',
  'pins',
  'schedules',
  'webhooks',
  'logs',
  'dashboard',
];

const DOMAIN_IMPORT_REGEX = new RegExp(
  `from\\s+['"][^'"]*\\/lib\\/(${FORBIDDEN_DOMAIN_MODULES.join('|')})(['"\\/]|$)`
);

const ASTRO_SERVER_CLIENT_REGEX = /createAstroServerClient|server\/db\/astro-client/;

const LEGACY_SUPABASE_REGEX = /from\s+['"][^'"]*\/lib\/supabase(['"]|$)/;

function walkDir(dir, callback) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      walkDir(fullPath, callback);
    } else {
      callback(fullPath);
    }
  }
}

// 1. Check .astro files for client <script> violations
walkDir(srcDir, (filePath) => {
  if (!filePath.endsWith('.astro')) return;

  const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
  const content = fs.readFileSync(filePath, 'utf8');

  // Match all <script>...</script> blocks
  const scriptRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(content)) !== null) {
    const scriptContent = match[1];
    const scriptStartIndex = match.index;
    const linesBeforeScript = content.substring(0, scriptStartIndex).split('\n').length;
    const scriptLines = scriptContent.split('\n');

    scriptLines.forEach((line, idx) => {
      const lineNum = linesBeforeScript + idx;

      // Check createAstroServerClient in client script
      if (ASTRO_SERVER_CLIENT_REGEX.test(line)) {
        errors.push({
          file: relPath,
          line: lineNum,
          rule: "Banned client import/usage of 'createAstroServerClient' / 'server/db/astro-client'",
          snippet: line.trim(),
        });
      }

      // Check legacy supabase import in client script (Promoted to fatal error in Tier 3)
      if (LEGACY_SUPABASE_REGEX.test(line)) {
        errors.push({
          file: relPath,
          line: lineNum,
          rule: "Forbidden client import of monolithic 'lib/supabase' shim (must import specific domain module)",
          snippet: line.trim(),
        });
      }
    });
  }
});

// 2. Check client-only modules in src/scripts/ and src/lib/
walkDir(path.join(srcDir, 'scripts'), (filePath) => {
  if (!filePath.endsWith('.ts') && !filePath.endsWith('.js')) return;
  const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');

  lines.forEach((line, idx) => {
    if (ASTRO_SERVER_CLIENT_REGEX.test(line)) {
      errors.push({
        file: relPath,
        line: idx + 1,
        rule: "Client script cannot import 'createAstroServerClient' or 'server/db/astro-client'",
        snippet: line.trim(),
      });
    }
    const domainMatch = DOMAIN_IMPORT_REGEX.exec(line);
    if (domainMatch) {
      errors.push({
        file: relPath,
        line: idx + 1,
        rule: `Client script cannot import domain module 'lib/${domainMatch[1]}'`,
        snippet: line.trim(),
      });
    }
  });
});

// 3. Check service_role leak outside server/ and pages/api/
walkDir(srcDir, (filePath) => {
  const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
  // Allow service_role only in src/server/ and src/pages/api/ (and tests / mocks)
  if (
    relPath.startsWith('src/server/') ||
    relPath.startsWith('src/pages/api/') ||
    relPath.includes('__tests__') ||
    relPath.includes('supabase-mock.ts')
  ) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    if (
      line.includes('SUPABASE_SERVICE_ROLE_KEY') ||
      /['"]service_role['"]/.test(line)
    ) {
      errors.push({
        file: relPath,
        line: idx + 1,
        rule: "Forbidden service_role key or role usage outside server/ and pages/api/",
        snippet: line.trim(),
      });
    }
  });
});

// 4. Check all <img> tags for required loading and decoding attributes
walkDir(srcDir, (filePath) => {
  if (!filePath.endsWith('.astro') && !filePath.startsWith(path.join(srcDir, 'scripts'))) return;
  if (filePath.includes('__tests__') || filePath.includes('.test.')) return;

  const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
  const content = fs.readFileSync(filePath, 'utf8');
  const imgRegex = /<img\b[\s\S]*?(?:\/?>)/gi;
  let match;

  while ((match = imgRegex.exec(content)) !== null) {
    const tag = match[0];
    const tagStartIndex = match.index;
    const lineNum = content.substring(0, tagStartIndex).split('\n').length;
    const snippet = tag.replace(/\s+/g, ' ').slice(0, 100);

    if (!tag.includes('loading=') && !tag.includes('loading')) {
      errors.push({
        file: relPath,
        line: lineNum,
        rule: "Missing 'loading' attribute on <img> tag (must be 'lazy' or 'eager')",
        snippet,
      });
    }

    if (!tag.includes('decoding=') && !tag.includes('decoding')) {
      errors.push({
        file: relPath,
        line: lineNum,
        rule: "Missing 'decoding' attribute on <img> tag (must be 'async')",
        snippet,
      });
    }
  }
});

// Report Results
console.log('\n🔍 --- PinOrbit Bundle Guard ---');

if (warnings.length > 0) {
  console.log(`\n⚠️  Found ${warnings.length} warning(s):`);
  for (const w of warnings) {
    console.log(`   [WARN] ${w.file}:${w.line} - ${w.rule}`);
    console.log(`          ${w.snippet}`);
  }
}

if (errors.length > 0) {
  console.error(`\n❌ Found ${errors.length} fatal error(s):`);
  for (const err of errors) {
    console.error(`   [ERROR] ${err.file}:${err.line} - ${err.rule}`);
    console.error(`           ${err.snippet}`);
  }
  console.error('\n🚫 Bundle guard failed. Please resolve the errors above before building.\n');
  process.exit(1);
}

console.log(`\n✅ Bundle guard passed cleanly (${warnings.length} warning(s), 0 errors).\n`);
process.exit(0);
