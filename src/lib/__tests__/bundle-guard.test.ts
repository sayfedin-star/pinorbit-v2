import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

describe('Bundle Guard Regression Suite (Task 5)', () => {
  const rootDir = path.resolve(__dirname, '../../..');
  const guardScriptPath = path.join(rootDir, 'scripts/bundle-guard.mjs');

  it('runs cleanly on the current codebase without errors', () => {
    const output = execSync(`node "${guardScriptPath}"`, {
      cwd: rootDir,
      encoding: 'utf8',
    });

    expect(output).toContain('Bundle guard passed cleanly');
    expect(output).toContain('0 errors');
  });

  it('flags legacy lib/supabase imports as warnings in Phase 1', () => {
    const output = execSync(`node "${guardScriptPath}"`, {
      cwd: rootDir,
      encoding: 'utf8',
    });

    expect(output).toContain('[WARN]');
    expect(output).toContain('Legacy import of \'lib/supabase\' in client script');
  });

  it('detects and blocks forbidden domain module imports in <script> tags', () => {
    const testAstroFile = path.join(rootDir, 'src/pages/__test_bundle_guard_fail.astro');
    fs.writeFileSync(
      testAstroFile,
      `---
export const prerender = false;
---
<script>
  import { getPins } from '../lib/pins';
  console.log(getPins);
</script>
`,
      'utf8'
    );

    try {
      expect(() => {
        execSync(`node "${guardScriptPath}"`, {
          cwd: rootDir,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      }).toThrow();
    } finally {
      if (fs.existsSync(testAstroFile)) {
        fs.unlinkSync(testAstroFile);
      }
    }
  });

  it('detects and blocks createAstroServerClient in client scripts', () => {
    const testAstroFile = path.join(rootDir, 'src/pages/__test_bundle_guard_server_client.astro');
    fs.writeFileSync(
      testAstroFile,
      `---
export const prerender = false;
---
<script>
  import { createAstroServerClient } from '../server/db/astro-client';
  console.log(createAstroServerClient);
</script>
`,
      'utf8'
    );

    try {
      expect(() => {
        execSync(`node "${guardScriptPath}"`, {
          cwd: rootDir,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      }).toThrow();
    } finally {
      if (fs.existsSync(testAstroFile)) {
        fs.unlinkSync(testAstroFile);
      }
    }
  });

  it('detects and blocks service_role leak outside server/ and pages/api/', () => {
    const testClientFile = path.join(rootDir, 'src/scripts/__test_bundle_guard_service_role.ts');
    fs.writeFileSync(
      testClientFile,
      `export const leak = process.env.SUPABASE_SERVICE_ROLE_KEY;`,
      'utf8'
    );

    try {
      expect(() => {
        execSync(`node "${guardScriptPath}"`, {
          cwd: rootDir,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      }).toThrow();
    } finally {
      if (fs.existsSync(testClientFile)) {
        fs.unlinkSync(testClientFile);
      }
    }
  });
});
