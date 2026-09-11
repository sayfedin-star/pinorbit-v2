import { describe, it, expect } from 'vitest';
import {
  renderPinCardHtml,
  renderRankBadge,
  renderStrategyBadge,
  renderStageBadge,
  renderAnomalyBadge,
  renderDeltaBadge,
  fmtDate,
} from '../pin-card-render';

describe('PinCard Renderer Suite', () => {
  const samplePin = {
    id: 'pin-123',
    pin_id: '123456789',
    title: 'Minimalist Scandinavian Living Room',
    image_url: 'https://i.pinimg.com/736x/test.jpg',
    link: 'https://example.com/scandinavian-living-room',
    saves: 1540,
    repins: 320,
    velocity: 4.5,
    share_count: 55,
    account_username: 'designinspo',
    board_name: 'Living Rooms',
    annotations: ['home decor', 'interior design', 'minimalism'],
    created_at_pinterest: '2026-03-01T12:00:00Z',
    stage: 'EVERGREEN',
    anomaly: 'SPIKE',
  };

  describe('Badge Renderers', () => {
    it('renders rank badges for top 3 and general ranks', () => {
      expect(renderRankBadge(0)).toContain('🥇 #1');
      expect(renderRankBadge(1)).toContain('🥈 #2');
      expect(renderRankBadge(2)).toContain('🥉 #3');
      expect(renderRankBadge(3)).toContain('#4');
    });

    it('renders strategy badges correctly', () => {
      expect(renderStrategyBadge('EVERGREEN')).toContain('🌲 Evergreen');
      expect(renderStrategyBadge('ROCKET')).toContain('🚀 Rocket');
      expect(renderStrategyBadge('VIRALITY')).toContain('🔁 Virality');
      expect(renderStrategyBadge('MATURE')).toContain('🏛️ Mature');
      expect(renderStrategyBadge('OTHER')).toContain('⚖️ Steady');
    });

    it('renders stage badges correctly', () => {
      expect(renderStageBadge('EVERGREEN')).toContain('🟢 EVERGREEN');
      expect(renderStageBadge('ROCKET')).toContain('🚀 ROCKET');
      expect(renderStageBadge('MATURE')).toContain('🏛️ MATURE');
      expect(renderStageBadge('DORMANT')).toContain('⚪ DORMANT');
    });

    it('renders anomaly badges correctly', () => {
      expect(renderAnomalyBadge('SPIKE')).toContain('🔥 SPIKE');
      expect(renderAnomalyBadge('COOLING')).toContain('❄️ COOLING');
      expect(renderAnomalyBadge(null)).toBe('');
    });

    it('renders delta badges with correct sign and metric', () => {
      expect(renderDeltaBadge(10, 'saves')).toContain('+10');
      expect(renderDeltaBadge(-5, 'repins')).toContain('-5');
      expect(renderDeltaBadge(0, 'saves')).toBe('');
    });

    it('formats dates cleanly', () => {
      expect(fmtDate(null)).toBe('—');
      expect(fmtDate('2026-03-01T12:00:00Z')).toContain('2026');
    });
  });

  describe('winning-pins view mode', () => {
    it('renders winning-pins card with rank, compare checkbox, and quick peek trigger', () => {
      const html = renderPinCardHtml(samplePin, {
        viewMode: 'winning-pins',
        index: 0,
        activeTimeframe: '24h',
        isSelected: true,
        strategy: 'EVERGREEN',
        deltaVal: 45,
      });

      expect(html).toContain('🥇 #1');
      expect(html).toContain('+45');
      expect(html).toContain('24h');
      expect(html).toContain('data-pin-compare="pin-123"');
      expect(html).toContain('checked');
      expect(html).toContain('data-peek-trigger="pin-123"');
      expect(html).toContain('Quick Peek');
      expect(html).toContain('@designinspo');
      expect(html).toContain('1,540');
      expect(html).toContain('320');
      expect(html).toContain('4.5/d');
      expect(html).toContain('#home decor');
      expect(html).toContain('Site ↗');
      expect(html).toContain('Pinterest');
    });
  });

  describe('topics view mode', () => {
    it('renders topics card with details links, stage badge, and anomaly badge', () => {
      const html = renderPinCardHtml(
        { ...samplePin, stage: 'GROWING' },
        {
          viewMode: 'topics',
        }
      );

      expect(html).toContain('/pinarchive/details?id=pin-123');
      expect(html).toContain('🚀 GROWING');
      expect(html).toContain('🔥 SPIKE');
      expect(html).toContain('1,540');
      expect(html).toContain('55 shares');
      expect(html).toContain('Pinterest Idea');
      expect(html).toContain('Visit Site ↗');
      expect(html).toContain('View');
    });

    it('supports custom detailsUrlMaker', () => {
      const html = renderPinCardHtml(samplePin, {
        viewMode: 'topics',
        detailsUrlMaker: (p) => `/custom/pin/${p.id}`,
      });
      expect(html).toContain('/custom/pin/pin-123');
    });
  });

  describe('account view mode', () => {
    it('renders account card with delta badges and account-scoped details URL', () => {
      const html = renderPinCardHtml(samplePin, {
        viewMode: 'account',
        activePace: '3d',
        isChanged: true,
        isSelected: true,
        username: 'designinspo',
        deltaBadgeHtml: '<span class="test-delta">+15</span>',
        deltaRepinsBadgeHtml: '<span class="test-repins">+5</span>',
      });

      expect(html).toContain('border-emerald-500/30');
      expect(html).toContain('class="pin-checkbox');
      expect(html).toContain('checked');
      expect(html).toContain('from_account=designinspo');
      expect(html).toContain('<span class="test-delta">+15</span>');
      expect(html).toContain('<span class="test-repins">+5</span>');
      expect(html).toContain('View on Pinterest');
    });
  });
});
