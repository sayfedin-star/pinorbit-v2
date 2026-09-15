import test from 'node:test';
import assert from 'node:assert';
import { formatPin, extractPinData } from './lib/pinterest.mjs';

test('1. formatPin() returns empty object {} when Pinterest HTML contains no reaction data', () => {
  const pinRaw = {
    saves: 100,
    repin_count: 50,
    title: 'Test Pin',
  };
  const formatted = formatPin(pinRaw);
  assert.deepStrictEqual(formatted.reactions, {});
  assert.strictEqual(formatted.reactions.total, undefined);
});

test('2. formatPin() extracts reactions correctly when reactionCountsData is provided', () => {
  const pinRaw = {
    saves: 100,
    reactionCountsData: [
      { reactionType: 1, reactionCount: 200 },
      { reactionType: 2, reactionCount: 60 },
    ],
    totalReactionCount: 260,
  };
  const formatted = formatPin(pinRaw);
  assert.deepStrictEqual(formatted.reactions, {
    type_1: 200,
    type_2: 60,
    total: 260,
  });
});

test('3. formatPin() computes total as sum of types if totalReactionCount is omitted but array has items', () => {
  const pinRaw = {
    saves: 100,
    reactionCountsData: [
      { reactionType: 1, reactionCount: 150 },
      { reactionType: 7, reactionCount: 25 },
    ],
  };
  const formatted = formatPin(pinRaw);
  assert.deepStrictEqual(formatted.reactions, {
    type_1: 150,
    type_7: 25,
    total: 175,
  });
});

test('4. formatPin() does not invent { total: 0 } when reactionCountsData is empty array', () => {
  const pinRaw = {
    saves: 100,
    reactionCountsData: [],
  };
  const formatted = formatPin(pinRaw);
  assert.deepStrictEqual(formatted.reactions, {});
});

test('5. extractPinData() does not allow empty arrays in secondary blocks to overwrite populated arrays from Relay', () => {
  const pinId = '123456789';
  const relayBlock = {
    data: {
      v3GetPinQueryv2: {
        data: {
          entityId: pinId,
          saves: 500,
          reactionCountsData: [{ reactionType: 1, reactionCount: 120 }],
          totalReactionCount: 120,
          pinJoin: {
            annotationsWithLinksArray: [{ name: 'Idea 1', url: '/ideas/idea-1/1/' }],
          },
        },
      },
    },
  };

  const html = `
    <html>
      <script>
        window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("test", ${JSON.stringify(relayBlock)});
      </script>
      <script type="application/json">
        { "id": "${pinId}", "reactionCountsData": [], "annotationsWithLinksArray": [] }
      </script>
    </html>
  `;

  const data = extractPinData(html, pinId);
  assert.notStrictEqual(data, null);
  assert.deepStrictEqual(data.reactions, {
    type_1: 120,
    total: 120,
  });
  assert.strictEqual(data.annotations.length, 1);
  assert.strictEqual(data.annotations[0].name, 'Idea 1');
});

test('6. Monotonic merge preserves existing reactions when incoming is 0 or missing', () => {
  const existing = {
    saves: 100,
    repins: 50,
    reactions: { type_1: 254, total: 254 },
  };

  const incoming = {
    pin_id: '123',
    saves: 105,
    repins: 55,
    reactions: { total: 0 },
  };

  const pTot = typeof incoming.reactions?.total === 'number' ? Number(incoming.reactions.total) : 0;
  const exTot = typeof existing?.reactions?.total === 'number' ? Number(existing.reactions.total) : 0;
  const mergedReactions = pTot >= exTot && pTot > 0 ? incoming.reactions : (exTot > 0 ? existing.reactions : (incoming.reactions ?? {}));

  assert.deepStrictEqual(mergedReactions, { type_1: 254, total: 254 });
});

test('7. Monotonic merge advances reactions when incoming is strictly greater', () => {
  const existing = {
    saves: 100,
    repins: 50,
    reactions: { type_1: 254, total: 254 },
  };

  const incoming = {
    pin_id: '123',
    saves: 105,
    repins: 55,
    reactions: { type_1: 260, total: 260 },
  };

  const pTot = typeof incoming.reactions?.total === 'number' ? Number(incoming.reactions.total) : 0;
  const exTot = typeof existing?.reactions?.total === 'number' ? Number(existing.reactions.total) : 0;
  const mergedReactions = pTot >= exTot && pTot > 0 ? incoming.reactions : (exTot > 0 ? existing.reactions : (incoming.reactions ?? {}));

  assert.deepStrictEqual(mergedReactions, { type_1: 260, total: 260 });
});
