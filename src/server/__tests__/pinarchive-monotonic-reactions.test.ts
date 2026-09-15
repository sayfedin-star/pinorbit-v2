import { describe, it, expect, vi } from 'vitest';
import { formatPin, extractPinData } from '../../../scripts/lib/pinterest.mjs';

describe('PinArchive Monotonic Reactions & 0-Drop Protection', () => {
  describe('1. formatPin() reaction handling', () => {
    it('returns empty object {} when Pinterest HTML contains no reaction data', () => {
      const pinRaw = {
        saves: 100,
        repin_count: 50,
        title: 'Test Pin',
      };
      const formatted = formatPin(pinRaw);
      expect(formatted.reactions).toEqual({});
      expect(formatted.reactions.total).toBeUndefined();
    });

    it('extracts reactions correctly when reactionCountsData is provided', () => {
      const pinRaw = {
        saves: 100,
        reactionCountsData: [
          { reactionType: 1, reactionCount: 200 },
          { reactionType: 2, reactionCount: 60 },
        ],
        totalReactionCount: 260,
      };
      const formatted = formatPin(pinRaw);
      expect(formatted.reactions).toEqual({
        type_1: 200,
        type_2: 60,
        total: 260,
      });
    });

    it('computes total as sum of types if totalReactionCount is omitted but array has items', () => {
      const pinRaw = {
        saves: 100,
        reactionCountsData: [
          { reactionType: 1, reactionCount: 150 },
          { reactionType: 7, reactionCount: 25 },
        ],
      };
      const formatted = formatPin(pinRaw);
      expect(formatted.reactions).toEqual({
        type_1: 150,
        type_7: 25,
        total: 175,
      });
    });

    it('does not invent { total: 0 } when reactionCountsData is empty array', () => {
      const pinRaw = {
        saves: 100,
        reactionCountsData: [],
      };
      const formatted = formatPin(pinRaw);
      expect(formatted.reactions).toEqual({});
    });
  });

  describe('2. extractPinData() block merge protection', () => {
    it('does not allow an empty array in secondary blocks to overwrite a populated array from Relay block', () => {
      const pinId = '123456789';
      // HTML containing Relay block with reactions and secondary block with empty reactions
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
      expect(data).not.toBeNull();
      expect(data?.reactions).toEqual({
        type_1: 120,
        total: 120,
      });
      expect(data?.annotations.length).toBe(1);
      expect(data?.annotations[0].name).toBe('Idea 1');
    });
  });

  describe('3. Ingest API monotonic reactions preservation', () => {
    it('preserves existing reactions when incoming reactions is 0 or missing in manual fallback', () => {
      const existing = {
        saves: 100,
        repins: 50,
        reactions: { type_1: 254, total: 254 },
      };

      const incomingPins = [
        {
          pin_id: '123',
          saves: 105,
          repins: 55,
          reactions: { total: 0 },
        },
      ];

      // Simulate manual fallback merge
      const p = incomingPins[0];
      const pTot = typeof (p.reactions as any)?.total === 'number' ? Number((p.reactions as any).total) : 0;
      const exTot = typeof (existing?.reactions as any)?.total === 'number' ? Number((existing?.reactions as any).total) : 0;
      const mergedReactions = pTot >= exTot && pTot > 0 ? p.reactions : (exTot > 0 ? existing.reactions : (p.reactions ?? {}));

      expect(mergedReactions).toEqual({ type_1: 254, total: 254 });
    });

    it('advances reactions when incoming reactions is strictly greater', () => {
      const existing = {
        saves: 100,
        repins: 50,
        reactions: { type_1: 254, total: 254 },
      };

      const incomingPins = [
        {
          pin_id: '123',
          saves: 105,
          repins: 55,
          reactions: { type_1: 260, total: 260 },
        },
      ];

      const p = incomingPins[0];
      const pTot = typeof (p.reactions as any)?.total === 'number' ? Number((p.reactions as any).total) : 0;
      const exTot = typeof (existing?.reactions as any)?.total === 'number' ? Number((existing?.reactions as any).total) : 0;
      const mergedReactions = pTot >= exTot && pTot > 0 ? p.reactions : (exTot > 0 ? existing.reactions : (p.reactions ?? {}));

      expect(mergedReactions).toEqual({ type_1: 260, total: 260 });
    });
  });
});
