/**
 * scripts/lib/pinterest.mjs
 *
 * Pure shared Pinterest Scraping & Parsing library.
 * Contains browser scraping headers (both HTML Page and XHR API variants),
 * recursive pin object locators, normalization formatters, and the 8-stage HTML parser.
 *
 * Rule: Pure utility module only — no top-level side effects or script execution.
 */

/**
 * Standard browser headers for full HTML page fetching (refresh & single pin probe).
 */
export const PINTEREST_PAGE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'upgrade-insecure-requests': '1',
  'Cache-Control': 'no-cache',
};

/**
 * Standard headers for Pinterest internal XHR / resource API endpoints (discovery & competitors).
 */
export function getPinterestXhrHeaders(username, activeCookie = '', options = {}) {
  const src = options.sourceUrl || `/${username}/_created/`;
  const handler = options.handler || `www/${username}/_created.js`;

  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'X-Requested-With': 'XMLHttpRequest',
    'X-App-Version': '9302641',
    'X-Pinterest-AppState': 'active',
    'X-Pinterest-PWS-Handler': handler,
    'X-Pinterest-Source-Url': src,
    'Referer': `https://www.pinterest.com${src}`,
    'Cookie': activeCookie || '',
    ...(options.extraHeaders || {}),
  };
}

/**
 * Recursively search a Pinterest JSON/Redux/Relay object tree for a pin matching pinId.
 */
export function findPinInTree(obj, pinId, depth = 0) {
  if (depth > 20 || !obj || typeof obj !== 'object') return null;
  if (
    String(obj.id) === pinId &&
    (obj.aggregated_pin_data || obj.aggregatedStats || obj.repin_count !== undefined || obj.repinCount !== undefined)
  ) {
    return obj;
  }
  if (String(obj.entityId) === pinId) return obj;
  if (obj[pinId] && typeof obj[pinId] === 'object') return obj[pinId];
  for (const key of Object.keys(obj)) {
    const found = findPinInTree(obj[key], pinId, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Normalize and format raw Pinterest pin data across diverse payload shapes into a consistent object.
 */
export function formatPin(pin) {
  const st =
    pin?.aggregated_pin_data?.aggregated_stats ||
    pin?.aggregatedPinData?.aggregatedStats ||
    pin?.aggregatedStats ||
    {};

  // --- annotations: annotationsWithLinksArray (rich) + visualAnnotation fallback ---
  const withLinks =
    pin?.pin_join?.annotationsWithLinksArray ||
    pin?.pinJoin?.annotationsWithLinksArray ||
    pin?.annotationsWithLinksArray ||
    [];
  const visual =
    pin?.pin_join?.visual_annotation ||
    pin?.visual_annotation ||
    pin?.pinJoin?.visualAnnotation ||
    pin?.visualAnnotation ||
    [];

  const annotationsMap = new Map();
  for (const item of Array.isArray(withLinks) ? withLinks : []) {
    if (item?.name && !annotationsMap.has(item.name)) {
      annotationsMap.set(item.name, {
        name: item.name,
        idea_id: String(item.url || '').match(/\/ideas\/[^/]+\/(\d+)/)?.[1] || null,
        url: item.url || null,
      });
    }
  }
  for (const name of Array.isArray(visual) ? visual : []) {
    if (typeof name === 'string' && name.trim() && !annotationsMap.has(name)) {
      annotationsMap.set(name, { name, idea_id: null, url: null });
    }
  }
  const annotations = Array.from(annotationsMap.values());

  // --- reactions ---
  const reactionsPayload = pin?.reactionCountsData || pin?.reactions || [];
  const reactionsMap = {};
  if (Array.isArray(reactionsPayload)) {
    for (const r of reactionsPayload) {
      if (r?.reactionType !== undefined) {
        reactionsMap[`type_${r.reactionType}`] = r.reactionCount;
      }
    }
  }
  reactionsMap.total = Number(pin?.totalReactionCount || pin?.reactions_total || 0);

  // --- canonical_pin_id ---
  const canonicalPinId =
    pin?.pinJoin?.canonicalPin?.entityId ??
    pin?.pin_join?.canonical_pin?.id ??
    (pin?.canonical_pin_id ? String(pin.canonical_pin_id) : null) ??
    (typeof pin.seoCanonicalUrl === 'string' ? pin.seoCanonicalUrl.match(/(\d+)\/?$/)?.[1] : null) ??
    (typeof pin.seo_canonical_url === 'string' ? pin.seo_canonical_url.match(/(\d+)\/?$/)?.[1] : null) ??
    null;

  return {
    saves: Number(st.saves || pin.saves || 0),
    repins: Number(pin.repinCount || pin.repin_count || pin.repins || 0),
    comments: Number(
      pin?.aggregated_pin_data?.commentCount ||
        pin?.aggregatedPinData?.commentCount ||
        pin?.commentCount ||
        pin?.comment_count ||
        pin.comments ||
        0
    ),
    title: pin.title || pin.gridTitle || pin.grid_title || '',
    description: pin.description || pin.gridDescription || pin.grid_description || '',
    link: pin.link || '',
    utm_link: pin.utmLink ?? pin.utm_link ?? null,
    domain: pin.domain || '',
    board_name: pin.board?.name || pin.pinner?.username || '',
    board_id: pin.board?.entityId ?? pin.board?.id ?? null,
    image_url: pin.images_orig?.url || pin.images?.orig?.url || pin.image_large_url || '',
    dominant_color: pin.dominantColor || pin.dominant_color || null,
    image_signature: pin.imageSignature || pin.image_signature || null,
    node_id: pin.id || pin.node_id || null,
    created_at_pinterest: pin.createdAt || pin.created_at || null,
    is_video: Boolean(pin.isVideo || pin.is_video),
    reactions: reactionsMap,

    // Enriched fields
    annotations,
    seo_category:
      pin?.pinJoin?.seoBreadcrumbs?.[0]?.name ||
      pin?.pin_join?.seo_breadcrumbs?.[0]?.name ||
      pin?.seo_category ||
      pin?.category ||
      null,
    canonical_pin_id: canonicalPinId,
    seo_alt_text: pin.seoAltText || pin.seo_alt_text || pin?.alt_text || null,
    share_count: Number(pin.shareCount ?? pin.share_count ?? pin?.pin_join?.share_count ?? 0),
    board_pin_count:
      typeof pin.board?.pinCount === 'number'
        ? pin.board.pinCount
        : typeof pin.board?.pin_count === 'number'
        ? pin.board.pin_count
        : typeof pin?.board?.pin_count === 'number'
        ? pin.board.pin_count
        : null,
    board_last_modified_at:
      pin.board?.boardOrderModifiedAt ||
      pin.board?.last_modified_at ||
      pin?.board?.board_order_updated_at ||
      null,
    follower_count:
      typeof pin?.pinner?.followerCount === 'number'
        ? pin.pinner.followerCount
        : typeof pin?.pinner?.follower_count === 'number'
        ? pin.pinner.follower_count
        : typeof pin?.origin_pinner?.follower_count === 'number'
        ? pin.origin_pinner.follower_count
        : null,
  };
}

/**
 * 8-stage robust pin parser extracting enriched pin metadata from Pinterest public HTML.
 */
export function extractPinData(html, pinId) {
  const blocks = [];

  // 1. Relay completed request blocks
  for (const [, content] of html.matchAll(
    /window\.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__\("[^"]+",\s*([\s\S]*?)\}\s*\);/g
  )) {
    try {
      const parsed = JSON.parse(content + '}');
      const pinObj = parsed?.data?.v3GetPinQueryv2?.data;
      if (pinObj) {
        const pinB64 = `UGluOj${Buffer.from(pinId).toString('base64').replace(/=+$/, '')}`;
        if (
          String(pinObj.entityId) === pinId ||
          String(pinObj.id) === pinId ||
          pinObj.id === pinB64 ||
          pinObj.pinJoin ||
          pinObj.reactionCountsData
        ) {
          blocks.push(pinObj);
        }
      }
    } catch (_) {}
  }

  // 2. Application json scripts
  const jsonBlobs = [...html.matchAll(/<script[^>]*type\s*=\s*"application\/json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, content] of jsonBlobs) {
    if (!content.includes(pinId)) continue;
    try {
      const data = JSON.parse(content);
      const pin = findPinInTree(data, pinId);
      if (pin) blocks.push(pin);
    } catch (_) {}
  }

  // 3. __PWS_DATA__
  const pwsMatch =
    html.match(/<script[^>]+id\s*=\s*"__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/i) ||
    html.match(/id="__PWS_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (pwsMatch) {
    try {
      const pws = JSON.parse(pwsMatch[1]);
      const pin =
        pws?.props?.initialReduxState?.pins?.[pinId] ||
        pws?.props?.relayContext?.relayData?.[pinId] ||
        pws?.props?.relayContext?.rootFeed ||
        findPinInTree(pws, pinId);
      if (pin) {
        const direct = pin.aggregated_pin_data || pin.saves !== undefined ? pin : findPinInTree(pin, pinId);
        if (direct) blocks.push(direct);
      }
    } catch (_) {}
  }

  // 4. relay-preloaded-queries
  const relayMatch = html.match(/id="relay-preloaded-queries"[^>]*>([\s\S]*?)<\/script>/);
  if (relayMatch) {
    try {
      const queries = JSON.parse(relayMatch[1]);
      for (const key of Object.keys(queries)) {
        const found = findPinInTree(queries[key], pinId);
        if (found) blocks.push(found);
      }
    } catch (_) {}
  }

  // 5. initial-data-feed
  const feedMatch = html.match(/id="initial-data-feed"[^>]*>([\s\S]*?)<\/script>/);
  if (feedMatch) {
    try {
      const feed = JSON.parse(feedMatch[1]);
      const found = findPinInTree(feed, pinId);
      if (found) blocks.push(found);
    } catch (_) {}
  }

  // 6. window.__INITIAL_DATA__
  const initMatch = html.match(/window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]*?\});<\/script>/);
  if (initMatch) {
    try {
      const init = JSON.parse(initMatch[1]);
      const found = findPinInTree(init, pinId);
      if (found) blocks.push(found);
    } catch (_) {}
  }

  if (blocks.length > 0) {
    const merged = {};
    for (const b of blocks) {
      for (const [k, v] of Object.entries(b)) {
        if (v !== null && v !== undefined) {
          if (
            typeof v === 'object' &&
            !Array.isArray(v) &&
            merged[k] &&
            typeof merged[k] === 'object' &&
            !Array.isArray(merged[k])
          ) {
            merged[k] = { ...merged[k], ...v };
          } else {
            merged[k] = v;
          }
        }
      }
    }
    const savesM = html.match(/"saves"\s*:\s*(\d+)/);
    if (savesM && !merged.saves && !merged.aggregated_pin_data?.aggregated_stats?.saves && !merged.aggregatedStats?.saves) {
      merged.saves = parseInt(savesM[1], 10);
    }
    const commentsM = html.match(/"comment_count"\s*:\s*(\d+)/) || html.match(/"commentCount"\s*:\s*(\d+)/);
    if (
      commentsM &&
      !merged.comments &&
      !merged.commentCount &&
      !merged.comment_count &&
      !merged.aggregated_pin_data?.commentCount
    ) {
      merged.commentCount = parseInt(commentsM[1], 10);
    }
    return formatPin(merged);
  }

  // 7. JSON-LD fallback
  const jsonLdMatch = html.match(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld && (ld['@type'] === 'SocialMediaPosting' || ld['@type'] === 'ImageObject' || ld.interactionStatistic)) {
        let saves = 0;
        let comments = 0;
        const stats = Array.isArray(ld.interactionStatistic)
          ? ld.interactionStatistic
          : ld.interactionStatistic
          ? [ld.interactionStatistic]
          : [];
        for (const s of stats) {
          if (s.interactionType && s.interactionType.includes('LikeAction')) saves = Number(s.userInteractionCount || 0);
          if (s.interactionType && s.interactionType.includes('CommentAction')) comments = Number(s.userInteractionCount || 0);
        }
        return {
          saves,
          repins: saves,
          comments,
          title: ld.headline || ld.name || '',
          description: ld.articleBody || ld.description || '',
          link: ld.url || '',
          utm_link: null,
          domain: '',
          board_name: '',
          board_id: null,
          created_at_pinterest: ld.datePublished || null,
          image_url: Array.isArray(ld.image)
            ? ld.image[0]
            : typeof ld.image === 'string'
            ? ld.image
            : ld.image?.url || '',
          dominant_color: null,
          image_signature: null,
          node_id: null,
          is_video: ld['@type'] === 'VideoObject',
          reactions: {},
          annotations: [],
          seo_category: ld.articleSection || null,
          canonical_pin_id: null,
          seo_alt_text: null,
          share_count: 0,
          board_pin_count: null,
          board_last_modified_at: null,
          follower_count: null,
          _source: 'jsonld',
        };
      }
    } catch (_) {}
  }

  // 8. Meta tags regex fallback
  const saveMeta =
    html.match(/name="pinterest:saves"\s+content="(\d+)"/i) ||
    html.match(/property="pinterest:saves"\s+content="(\d+)"/i);
  const repinMeta =
    html.match(/name="pinterest:repins"\s+content="(\d+)"/i) ||
    html.match(/property="pinterest:repins"\s+content="(\d+)"/i);
  const titleMeta = html.match(/property="og:title"\s+content="([^"]*)"/i);
  const descMeta = html.match(/property="og:description"\s+content="([^"]*)"/i);
  const imgMeta = html.match(/property="og:image"\s+content="([^"]*)"/i);

  if (saveMeta || repinMeta || titleMeta) {
    return formatPin({
      saves: saveMeta ? parseInt(saveMeta[1], 10) : 0,
      repins: repinMeta ? parseInt(repinMeta[1], 10) : 0,
      title: titleMeta ? titleMeta[1] : '',
      description: descMeta ? descMeta[1] : '',
      image_large_url: imgMeta ? imgMeta[1] : '',
    });
  }

  return null;
}
