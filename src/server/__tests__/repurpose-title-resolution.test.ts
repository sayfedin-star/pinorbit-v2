import { describe, it, expect } from 'vitest';
import { resolvePinTitle } from '../services/repurpose-service';

describe('Repurpose Title Resolution Suite (Condition 3 Fallback Chain)', () => {
  it('uses clean trimmed title when title is non-empty', () => {
    expect(resolvePinTitle('  Modern Boho Home Decor  ', 'Some description')).toBe('Modern Boho Home Decor');
  });

  it('falls back to LEFT(description, 60) when title is null', () => {
    const desc = 'Discover the top 10 minimalist living room ideas with warm textures and Scandinavian aesthetics.';
    const result = resolvePinTitle(null, desc);
    expect(result).toBe(desc.slice(0, 60));
    expect(result.length).toBe(60);
  });

  it('falls back to LEFT(description, 60) when title is empty string or only whitespace', () => {
    const desc = 'Casual summer fashion lookbook for outdoor picnics.';
    expect(resolvePinTitle('', desc)).toBe(desc);
    expect(resolvePinTitle('     ', desc)).toBe(desc);
  });

  it('falls back to "Archived Pin" when both title and description are null or empty', () => {
    expect(resolvePinTitle(null, null)).toBe('Archived Pin');
    expect(resolvePinTitle('', '')).toBe('Archived Pin');
    expect(resolvePinTitle('   ', '   ')).toBe('Archived Pin');
    expect(resolvePinTitle(undefined, undefined)).toBe('Archived Pin');
  });

  it('handles short description properly', () => {
    expect(resolvePinTitle(null, 'Cozy Vibes')).toBe('Cozy Vibes');
  });
});
