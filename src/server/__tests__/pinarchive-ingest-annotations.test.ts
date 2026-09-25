import { describe, it, expect } from 'vitest';
import {
  normalizeAnnotation,
  mergeAnnotationsLatest,
} from '../../pages/api/internal/pinarchive/ingest';

describe('PinArchive Ingest Annotations Logic', () => {
  describe('normalizeAnnotation', () => {
    it('normalizes a valid string annotation', () => {
      expect(normalizeAnnotation('Creative Appetizer Recipes')).toEqual({
        name: 'Creative Appetizer Recipes',
        idea_id: null,
        url: null,
      });
    });

    it('trims whitespace on string annotations', () => {
      expect(normalizeAnnotation('   Quick Picnic   ')).toEqual({
        name: 'Quick Picnic',
        idea_id: null,
        url: null,
      });
    });

    it('returns null for empty or whitespace-only string', () => {
      expect(normalizeAnnotation('')).toBeNull();
      expect(normalizeAnnotation('   ')).toBeNull();
    });

    it('normalizes an object annotation with url and idea_id', () => {
      expect(
        normalizeAnnotation({
          name: 'Hot Wrap Recipes',
          idea_id: '942822660938',
          url: '/ideas/hot-wrap-recipes/942822660938/',
        })
      ).toEqual({
        name: 'Hot Wrap Recipes',
        idea_id: '942822660938',
        url: '/ideas/hot-wrap-recipes/942822660938/',
      });
    });

    it('converts numeric idea_id to string and trims strings', () => {
      expect(
        normalizeAnnotation({
          name: '  Party Food Potluck  ',
          idea_id: 929867150699,
          url: ' /ideas/party-food-potluck/929867150699/ ',
        })
      ).toEqual({
        name: 'Party Food Potluck',
        idea_id: '929867150699',
        url: '/ideas/party-food-potluck/929867150699/',
      });
    });

    it('returns null for null, undefined, or invalid object', () => {
      expect(normalizeAnnotation(null)).toBeNull();
      expect(normalizeAnnotation(undefined)).toBeNull();
      expect(normalizeAnnotation({})).toBeNull();
      expect(normalizeAnnotation({ name: '   ' })).toBeNull();
      expect(normalizeAnnotation(12345)).toBeNull();
    });
  });

  describe('mergeAnnotationsLatest', () => {
    it('adopts incoming annotations as authoritative and prunes retired tags', () => {
      const existing = [
        { name: 'Creative Appetizer Recipes', idea_id: '1', url: '/ideas/creative/1/' },
        { name: 'Retired Tag One', idea_id: '2', url: '/ideas/retired-1/2/' },
        { name: 'Retired Tag Two', idea_id: null, url: null },
      ];

      const incoming = [
        { name: 'Creative Appetizer Recipes' },
        { name: 'New Brand Tag' },
      ];

      const result = mergeAnnotationsLatest(incoming, existing);

      expect(result).toHaveLength(2);
      expect(result).toEqual([
        {
          name: 'Creative Appetizer Recipes',
          idea_id: '1',
          url: '/ideas/creative/1/',
        },
        {
          name: 'New Brand Tag',
          idea_id: null,
          url: null,
        },
      ]);
      // Retired tags are pruned
      expect(result?.some((a) => a.name === 'Retired Tag One')).toBe(false);
      expect(result?.some((a) => a.name === 'Retired Tag Two')).toBe(false);
    });

    it('inherits idea_id and url case-insensitively while preserving incoming casing', () => {
      const existing = [
        {
          name: 'quick picnic',
          idea_id: '935765775504',
          url: '/ideas/quick-picnic/935765775504/',
        },
      ];

      const incoming = [{ name: 'Quick Picnic' }];

      const result = mergeAnnotationsLatest(incoming, existing);
      expect(result).toEqual([
        {
          name: 'Quick Picnic', // Incoming casing preserved
          idea_id: '935765775504',
          url: '/ideas/quick-picnic/935765775504/',
        },
      ]);
    });

    it('deduplicates duplicate tags within incoming array case-insensitively', () => {
      const incoming = [
        { name: 'Hot Wrap Recipes' },
        { name: 'hot wrap recipes' },
        'HOT WRAP RECIPES',
      ];

      const result = mergeAnnotationsLatest(incoming, []);
      expect(result).toHaveLength(1);
      expect(result![0].name).toBe('Hot Wrap Recipes');
    });

    it('handles raw strings in incoming array', () => {
      const existing = [
        {
          name: 'Ideas For Starters',
          idea_id: '908001169128',
          url: '/ideas/ideas-for-starters/908001169128/',
        },
      ];

      const incoming = ['Ideas For Starters', 'New Raw Tag'];

      const result = mergeAnnotationsLatest(incoming, existing);
      expect(result).toEqual([
        {
          name: 'Ideas For Starters',
          idea_id: '908001169128',
          url: '/ideas/ideas-for-starters/908001169128/',
        },
        {
          name: 'New Raw Tag',
          idea_id: null,
          url: null,
        },
      ]);
    });

    it('preserves existing annotations when incoming is empty array (Two-Writer GAS protection)', () => {
      const existing = [
        { name: 'Old Tag', idea_id: '123', url: '/ideas/old/123/' },
      ];

      // GAS emits annotations: [] on every sync; it must never wipe out existing annotations
      const result = mergeAnnotationsLatest([], existing);
      expect(result).toEqual([
        { name: 'Old Tag', idea_id: '123', url: '/ideas/old/123/' },
      ]);
    });

    it('returns empty array when incoming is empty array and existing has no annotations', () => {
      expect(mergeAnnotationsLatest([], [])).toEqual([]);
      expect(mergeAnnotationsLatest([], undefined)).toEqual([]);
    });

    it('preserves existing annotations when incoming is undefined', () => {
      const existing = [
        { name: 'Better Me Recipes', idea_id: '947051376276', url: '/ideas/better-me/947051376276/' },
        { name: 'Food For Summer Dinner', idea_id: null, url: null },
      ];

      const result = mergeAnnotationsLatest(undefined, existing);
      expect(result).toEqual(existing);
    });

    it('returns undefined when both incoming and existing are undefined', () => {
      const result = mergeAnnotationsLatest(undefined, undefined);
      expect(result).toBeUndefined();
    });

    it('in-batch: preserves earlier annotations when subsequent occurrence has empty array', () => {
      const firstAnn = [{ name: 'Keto Breakfast', idea_id: '123', url: '/ideas/keto/123/' }];
      // Later entry in batch has no tags (e.g. basic metrics update)
      const result = mergeAnnotationsLatest([], firstAnn);
      expect(result).toEqual(firstAnn);
    });

    it('sanitizes empty string idea_id and url to null', () => {
      const normalized = normalizeAnnotation({
        name: 'Quick Salad',
        idea_id: '   ',
        url: '',
      });
      expect(normalized).toEqual({
        name: 'Quick Salad',
        idea_id: null,
        url: null,
      });
    });
  });
});
