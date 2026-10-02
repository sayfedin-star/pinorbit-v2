import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  PINARCHIVE_SHEET_HEADERS,
  formatSheetDate,
  parseSheetTimestamp,
  escapeSheetTitle,
  parseCredentials,
  clearTokenCache,
  clearTabsCache,
  getGoogleAccessToken,
  ensureSheetExists,
  readSheetRows,
  buildSheetRow,
  rowNeedsUpdate,
  writeToSheetsApi,
  getAccountAgesFromSheetsApi,
} from '../../../scripts/lib/sheets-client.mjs';
import { writeToGoogleSheet } from '../../../scripts/lib/pa-client.mjs';

describe('PinArchive Sheets Client & Service Account API v4 Suite', () => {
  // Generate a valid RSA keypair in-memory for testing crypto signing
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const validCreds = {
    client_email: 'pinorbit-automation@test-project.iam.gserviceaccount.com',
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
    project_id: 'test-project',
  };

  const mockSpreadsheetId = '1zIG_W8ExS0pbUsxmhXY4zL8awztP8_l-Ip_fUX5LKpA';

  beforeEach(() => {
    vi.restoreAllMocks();
    clearTokenCache();
    clearTabsCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearTokenCache();
    clearTabsCache();
  });

  const createMockResponse = (status: number, body: any, contentType = 'application/json') => {
    const textBody = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': contentType }),
      text: async () => textBody,
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    };
  };

  describe('1. Credentials Parser & Formatting Helpers', () => {
    it('parses valid credentials object', () => {
      const parsed = parseCredentials(validCreds);
      expect(parsed.client_email).toBe(validCreds.client_email);
      expect(parsed.private_key).toBe(privateKey.trim());
      expect(parsed.token_uri).toBe(validCreds.token_uri);
    });

    it('parses valid credentials JSON string with escaped newlines', () => {
      const escapedKey = privateKey.replace(/\n/g, '\\n');
      const jsonStr = JSON.stringify({
        client_email: validCreds.client_email,
        private_key: escapedKey,
      });

      const parsed = parseCredentials(jsonStr);
      expect(parsed.client_email).toBe(validCreds.client_email);
      expect(parsed.private_key).toBe(privateKey);
      expect(parsed.token_uri).toBe('https://oauth2.googleapis.com/token');
    });

    it('throws on null, empty, or invalid JSON credentials', () => {
      expect(() => parseCredentials('')).toThrow(/credentials missing/i);
      expect(() => parseCredentials(null)).toThrow(/credentials missing/i);
      expect(() => parseCredentials('{ invalid json')).toThrow(/Invalid JSON/i);
      expect(() => parseCredentials(123 as any)).toThrow(/must be an object/i);
    });

    it('throws when client_email or private_key is missing', () => {
      expect(() => parseCredentials({ private_key: 'key' })).toThrow(/Missing client_email/i);
      expect(() => parseCredentials({ client_email: 'email' })).toThrow(/Missing private_key/i);
    });

    it('formatSheetDate formats dates to GMT "YYYY-MM-DD HH:mm:ss"', () => {
      const d = new Date('2026-10-02T15:30:45.000Z');
      expect(formatSheetDate(d)).toBe('2026-10-02 15:30:45');
      expect(formatSheetDate('invalid-date')).toBe('');
    });

    it('parseSheetTimestamp handles Dates, ISO strings, and sheet format timestamps', () => {
      const epoch = Date.parse('2026-05-10T12:00:00Z');
      expect(parseSheetTimestamp('2026-05-10 12:00:00')).toBe(epoch);
      expect(parseSheetTimestamp('2026-05-10T12:00:00Z')).toBe(epoch);
      expect(parseSheetTimestamp(new Date('2026-05-10T12:00:00Z'))).toBe(epoch);
      expect(parseSheetTimestamp('')).toBeNaN();
    });

    it('escapeSheetTitle encloses sheet names and escapes single quotes', () => {
      expect(escapeSheetTitle('pins_user')).toBe("'pins_user'");
      expect(escapeSheetTitle("pins_user's")).toBe("'pins_user''s'");
    });
  });

  describe('2. OAuth2 Access Token Bearer Generation & Caching', () => {
    it('signs JWT with RSA-SHA256 and exchanges for bearer token', async () => {
      const fetchMock = vi.fn().mockImplementation(async (url, init) => {
        expect(url).toBe(validCreds.token_uri);
        expect(init.method).toBe('POST');
        const bodyStr = init.body as string;
        expect(bodyStr).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
        expect(bodyStr).toContain('assertion=');

        // Extract assertion JWT and verify signature
        const urlParams = new URLSearchParams(bodyStr);
        const assertion = urlParams.get('assertion');
        const parts = assertion!.split('.');
        expect(parts.length).toBe(3);

        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        expect(header.alg).toBe('RS256');
        expect(claims.iss).toBe(validCreds.client_email);
        expect(claims.scope).toBe('https://www.googleapis.com/auth/spreadsheets');

        // Verify RSA signature
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(`${parts[0]}.${parts[1]}`);
        const isValid = verifier.verify(publicKey, parts[2], 'base64url');
        expect(isValid).toBe(true);

        return createMockResponse(200, {
          access_token: 'mock-access-token-xyz',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const token = await getGoogleAccessToken(validCreds);
      expect(token).toBe('mock-access-token-xyz');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Subsequent call within 50 minutes uses cached token
      const tokenCached = await getGoogleAccessToken(validCreds);
      expect(tokenCached).toBe('mock-access-token-xyz');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws error when token exchange returns HTTP error', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        createMockResponse(400, { error: 'invalid_grant', error_description: 'Invalid signature' })
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(getGoogleAccessToken(validCreds)).rejects.toThrow(
        /Google OAuth2 token exchange failed \(400\): Invalid signature/i
      );
    });
  });

  describe('3. Row Building & NeedsUpdate Detection', () => {
    const headerMap = {};
    PINARCHIVE_SHEET_HEADERS.forEach((h, i) => { headerMap[h] = i; });

    it('builds canonical 18-column row with annotations and Pinterest creation time', () => {
      const pin = {
        pin_id: '123456789',
        title: 'Delicious Pie',
        description: 'Apple Pie recipe',
        link: 'https://pie.example/recipe',
        domain: 'pie.example',
        board_name: 'Desserts',
        created_at_pinterest: '2026-01-01T00:00:00.000Z',
        image_url: 'https://i.pinimg.com/test.jpg',
        image_signature: 'sig_abc',
        dominant_color: '#ffaa00',
        saves: 150,
        repins: 25,
        comments: 3,
        velocity: 1.5,
        annotations: [{ name: 'Baking' }, { name: 'Desserts' }],
      };

      const row = buildSheetRow(pin, headerMap, 18, null, '2026-10-02 12:00:00');
      expect(row.length).toBe(18);
      expect(row[0]).toBe('123456789'); // pin_id
      expect(row[1]).toBe('Delicious Pie'); // title
      expect(row[6]).toBe('2026-01-01T00:00:00.000Z'); // created_at
      expect(row[10]).toBe(150); // saves
      expect(row[11]).toBe(25); // repins
      expect(row[12]).toBe(3); // comments
      expect(row[13]).toBe(1.5); // velocity
      expect(row[14]).toBe('2026-10-02 12:00:00'); // first_seen_at
      expect(row[15]).toBe('2026-10-02 12:00:00'); // last_updated_at
      expect(row[17]).toBe('Baking, Desserts'); // tags
    });

    it('preserves first_seen_at and archived_at from existing row', () => {
      const existingRow = new Array(18).fill('');
      existingRow[14] = '2025-01-01 00:00:00'; // first_seen_at
      existingRow[16] = '2025-06-01 00:00:00'; // archived_at

      const freshPin = {
        pin_id: '123456789',
        title: 'Updated Pie',
        saves: 200,
      };

      const row = buildSheetRow(freshPin, headerMap, 18, existingRow, '2026-10-02 12:00:00');
      expect(row[14]).toBe('2025-01-01 00:00:00');
      expect(row[16]).toBe('2025-06-01 00:00:00');
      expect(row[15]).toBe('2026-10-02 12:00:00'); // last_updated_at updated
    });

    it('rowNeedsUpdate detects metric and metadata changes accurately', () => {
      const baseRow = new Array(18).fill('');
      baseRow[0] = '123';
      baseRow[1] = 'Original Title';
      baseRow[10] = '50'; // saves
      baseRow[11] = '5';  // repins
      baseRow[12] = '1';  // comments
      baseRow[17] = 'tag1, tag2';

      // No changes -> false
      expect(rowNeedsUpdate(baseRow, headerMap, { saves: 50, repins: 5, comments: 1, title: 'Original Title', tags: ['tag1', 'tag2'] })).toBe(false);

      // Saves change -> true
      expect(rowNeedsUpdate(baseRow, headerMap, { saves: 55, repins: 5, comments: 1, title: 'Original Title' })).toBe(true);

      // Title change -> true
      expect(rowNeedsUpdate(baseRow, headerMap, { saves: 50, repins: 5, comments: 1, title: 'New Title' })).toBe(true);

      // Tags change -> true
      expect(rowNeedsUpdate(baseRow, headerMap, { saves: 50, repins: 5, comments: 1, title: 'Original Title', tags: ['tag1', 'tag3'] })).toBe(true);
    });
  });

  describe('4. Sheet Management & Table Schema (ensureSheetExists)', () => {
    it('skips tab creation if tab is already present in metadata', async () => {
      const fetchMock = vi.fn().mockImplementation(async (url) => {
        if (url.includes('oauth2.googleapis.com')) {
          return createMockResponse(200, { access_token: 'token', expires_in: 3600 });
        }
        if (url.includes('fields=sheets.properties')) {
          return createMockResponse(200, {
            sheets: [
              { properties: { sheetId: 1, title: 'pins_testuser' } },
            ],
          });
        }
        return createMockResponse(404, {});
      });
      vi.stubGlobal('fetch', fetchMock);

      const exists = await ensureSheetExists('token', mockSpreadsheetId, 'pins_testuser');
      expect(exists).toBe(true);
      // Only 1 call to get spreadsheet metadata
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('creates tab and writes header row when tab is missing', async () => {
      const calls: string[] = [];
      const fetchMock = vi.fn().mockImplementation(async (url, init) => {
        if (url.includes('fields=sheets.properties')) {
          calls.push('getSpreadsheetTabs');
          return createMockResponse(200, { sheets: [{ properties: { title: 'Control' } }] });
        }
        if (url.includes(':batchUpdate')) {
          calls.push('addSheet');
          expect(init.method).toBe('POST');
          const body = JSON.parse(init.body);
          expect(body.requests[0].addSheet.properties.title).toBe('pins_newuser');
          return createMockResponse(200, { replies: [{ addSheet: { properties: { sheetId: 99 } } }] });
        }
        if (url.includes('/values/')) {
          calls.push('writeHeaders');
          expect(init.method).toBe('PUT');
          const body = JSON.parse(init.body);
          expect(body.values[0]).toEqual(PINARCHIVE_SHEET_HEADERS);
          return createMockResponse(200, { updatedRows: 1 });
        }
        return createMockResponse(404, {});
      });
      vi.stubGlobal('fetch', fetchMock);

      await ensureSheetExists('token', mockSpreadsheetId, 'pins_newuser');
      expect(calls).toEqual(['getSpreadsheetTabs', 'getSpreadsheetTabs', 'addSheet', 'writeHeaders']);
    });
  });

  describe('5. writeToSheetsApi (Direct REST Append & Update)', () => {
    it('returns { ok: true, total_received: 0 } on empty rows payload', async () => {
      const res = await writeToSheetsApi(validCreds, mockSpreadsheetId, { username: 'testuser', rows: [] });
      expect(res).toEqual({
        ok: true,
        version: '4.0.0-api',
        total_received: 0,
        written: 0,
        appended: 0,
        updated: 0,
        unchanged: 0,
      });
    });

    it('handles mode: append by calling values:append with deduplicated rows', async () => {
      let appendPayload: any = null;
      const fetchMock = vi.fn().mockImplementation(async (url, init) => {
        if (url.includes('oauth2.googleapis.com')) {
          return createMockResponse(200, { access_token: 'token', expires_in: 3600 });
        }
        if (url.includes('fields=sheets.properties')) {
          return createMockResponse(200, { sheets: [{ properties: { title: 'pins_testuser' } }] });
        }
        if (url.includes('/values/') && !url.includes(':append')) {
          return createMockResponse(200, { values: [PINARCHIVE_SHEET_HEADERS] });
        }
        if (url.includes(':append')) {
          appendPayload = JSON.parse(init.body);
          return createMockResponse(200, { updates: { updatedRows: 2 } });
        }
        return createMockResponse(404, {});
      });
      vi.stubGlobal('fetch', fetchMock);

      const rows = [
        { pin_id: 'p1', title: 'Pin 1', saves: 10 },
        { pin_id: 'p1', title: 'Pin 1 Duplicate', saves: 10 }, // deduplicated
        { pin_id: 'p2', title: 'Pin 2', saves: 20 },
      ];

      const res = await writeToSheetsApi(validCreds, mockSpreadsheetId, {
        username: 'testuser',
        mode: 'append',
        rows,
      });

      expect(res.ok).toBe(true);
      expect(res.total_received).toBe(3);
      expect(res.written).toBe(2);
      expect(res.appended).toBe(2);
      expect(appendPayload.values.length).toBe(2);
      expect(appendPayload.values[0][0]).toBe('p1');
      expect(appendPayload.values[1][0]).toBe('p2');
    });

    it('handles mode: update with selective updates and new appends', async () => {
      let batchUpdatePayload: any = null;
      let appendPayload: any = null;

      const fetchMock = vi.fn().mockImplementation(async (url, init) => {
        if (url.includes('oauth2.googleapis.com')) {
          return createMockResponse(200, { access_token: 'token', expires_in: 3600 });
        }
        if (url.includes('fields=sheets.properties')) {
          return createMockResponse(200, { sheets: [{ properties: { title: 'pins_testuser' } }] });
        }
        if (url.includes('/values/') && !url.includes(':append') && !url.includes(':batchUpdate')) {
          // Existing rows: headers + p1 (unchanged) + p2 (will be updated)
          const p1Row = new Array(18).fill('');
          p1Row[0] = 'p1'; p1Row[1] = 'Pin 1'; p1Row[10] = '10';
          const p2Row = new Array(18).fill('');
          p2Row[0] = 'p2'; p2Row[1] = 'Pin 2 Old'; p2Row[10] = '20';

          return createMockResponse(200, {
            values: [PINARCHIVE_SHEET_HEADERS, p1Row, p2Row],
          });
        }
        if (url.includes(':batchUpdate')) {
          batchUpdatePayload = JSON.parse(init.body);
          return createMockResponse(200, { totalUpdatedRows: 1 });
        }
        if (url.includes(':append')) {
          appendPayload = JSON.parse(init.body);
          return createMockResponse(200, { updates: { updatedRows: 1 } });
        }
        return createMockResponse(404, {});
      });
      vi.stubGlobal('fetch', fetchMock);

      const rows = [
        { pin_id: 'p1', title: 'Pin 1', saves: 10 },           // unchanged
        { pin_id: 'p2', title: 'Pin 2 Fresh', saves: 25 },     // modified -> batch update
        { pin_id: 'p3', title: 'Brand New Pin', saves: 5 },     // new -> append
      ];

      const res = await writeToSheetsApi(validCreds, mockSpreadsheetId, {
        username: 'testuser',
        mode: 'update',
        rows,
      });

      expect(res.ok).toBe(true);
      expect(res.total_received).toBe(3);
      expect(res.written).toBe(2); // 1 updated + 1 appended
      expect(res.appended).toBe(1);
      expect(res.updated).toBe(1);
      expect(res.unchanged).toBe(1);

      // p2 updated on row 3 (header is row 1, p1 is row 2, p2 is row 3)
      expect(batchUpdatePayload.data[0].range).toBe("'pins_testuser'!A3:R3");
      expect(batchUpdatePayload.data[0].values[0][1]).toBe('Pin 2 Fresh');
      expect(batchUpdatePayload.data[0].values[0][10]).toBe(25);

      // p3 appended
      expect(appendPayload.values.length).toBe(1);
      expect(appendPayload.values[0][0]).toBe('p3');
    });

    it('retries on transient HTTP 429 and succeeds on subsequent attempt', async () => {
      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(async (url) => {
        if (url.includes('oauth2.googleapis.com')) {
          return createMockResponse(200, { access_token: 'token', expires_in: 3600 });
        }
        if (url.includes('fields=sheets.properties')) {
          callCount++;
          if (callCount === 1) {
            return createMockResponse(429, { error: { message: 'Quota exceeded' } });
          }
          return createMockResponse(200, { sheets: [{ properties: { title: 'pins_testuser' } }] });
        }
        if (url.includes('/values/')) {
          return createMockResponse(200, { values: [PINARCHIVE_SHEET_HEADERS] });
        }
        if (url.includes(':append')) {
          return createMockResponse(200, { updates: { updatedRows: 1 } });
        }
        return createMockResponse(404, {});
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await writeToSheetsApi(validCreds, mockSpreadsheetId, {
        username: 'testuser',
        mode: 'append',
        rows: [{ pin_id: 'p1', title: 'P1' }],
      });

      expect(res.ok).toBe(true);
      expect(callCount).toBe(2);
    });

    it('returns failure object without retrying on HTTP 400 validation error', async () => {
      const fetchMock = vi.fn().mockImplementation(async (url) => {
        if (url.includes('oauth2.googleapis.com')) {
          return createMockResponse(200, { access_token: 'token', expires_in: 3600 });
        }
        return createMockResponse(400, { error: { message: 'Invalid range' } });
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await writeToSheetsApi(validCreds, mockSpreadsheetId, {
        username: 'testuser',
        mode: 'append',
        rows: [{ pin_id: 'p1' }],
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain('Invalid range');
    });
  });

  describe('6. getAccountAgesFromSheetsApi (Fast Batch Oldest Pin Sync)', () => {
    it('executes batchGet across multiple creator tabs and resolves minimum timestamps', async () => {
      const fetchMock = vi.fn().mockImplementation(async (url) => {
        if (url.includes('oauth2.googleapis.com')) {
          return createMockResponse(200, { access_token: 'token', expires_in: 3600 });
        }
        if (url.includes('values:batchGet')) {
          return createMockResponse(200, {
            valueRanges: [
              {
                range: "'pins_creator1'!G2:G",
                values: [
                  ['2025-06-01 10:00:00'],
                  ['2024-01-15 08:30:00'], // oldest
                  ['2025-02-20 14:00:00'],
                ],
              },
              {
                range: "'pins_creator2'!G2:G",
                values: [
                  ['2023-11-05T00:00:00Z'], // oldest
                  ['2024-05-12 11:22:33'],
                ],
              },
              {
                range: "'pins_empty'!G2:G",
                values: [],
              },
            ],
          });
        }
        return createMockResponse(404, {});
      });
      vi.stubGlobal('fetch', fetchMock);

      const ages = await getAccountAgesFromSheetsApi(validCreds, mockSpreadsheetId, [
        'creator1',
        'creator2',
        'empty',
      ]);

      expect(ages.creator1).toBe('2024-01-15T08:30:00.000Z');
      expect(ages.creator2).toBe('2023-11-05T00:00:00.000Z');
      expect(ages.empty).toBeNull();
    });
  });

  describe('7. writeToGoogleSheet Unified Writer Routing', () => {
    it('routes to writeToSheetsApi when credentials and spreadsheetId are present', async () => {
      const fetchMock = vi.fn().mockImplementation(async (url) => {
        if (url.includes('oauth2.googleapis.com')) {
          return createMockResponse(200, { access_token: 'token', expires_in: 3600 });
        }
        if (url.includes('fields=sheets.properties')) {
          return createMockResponse(200, { sheets: [{ properties: { title: 'pins_testuser' } }] });
        }
        if (url.includes('/values/') && !url.includes(':append')) {
          return createMockResponse(200, { values: [PINARCHIVE_SHEET_HEADERS] });
        }
        if (url.includes(':append')) {
          return createMockResponse(200, { updates: { updatedRows: 1 } });
        }
        return createMockResponse(404, {});
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await writeToGoogleSheet({
        credentials: validCreds,
        spreadsheetId: mockSpreadsheetId,
        payload: { username: 'testuser', mode: 'append', rows: [{ pin_id: 'p1' }] },
      });

      expect(res.ok).toBe(true);
      expect(res.version).toBe('4.0.0-api');
    });

    it('falls back to writeToGas when service account credentials are empty', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        createMockResponse(200, { ok: true, version: '2.8.4', written: 5, appended: 5, updated: 0, unchanged: 0 })
      );
      vi.stubGlobal('fetch', fetchMock);

      const res = await writeToGoogleSheet({
        credentials: '',
        spreadsheetId: '',
        gasUrl: 'https://script.google.com/macros/s/mock/exec',
        secret: 'test_sec',
        payload: { username: 'testuser', mode: 'update', rows: [] },
      });

      expect(res.ok).toBe(true);
      expect(res.version).toBe('2.8.4');
    });

    it('skips write cleanly when neither Sheets API nor GAS is configured', async () => {
      const res = await writeToGoogleSheet({
        credentials: '',
        spreadsheetId: '',
        gasUrl: '',
        secret: '',
        payload: { username: 'testuser', rows: [] },
      });

      expect(res).toEqual({ ok: true, skipped: true });
    });
  });
});
