// ==UserScript==
// @name         Zonos Dispute Researcher
// @namespace    zonos-brokerage
// @version      0.7.1
// @description  Adds a "Research merchant" panel to duty dispute pages, checks the merchant's site, and hands the research to Claude on claude.ai. Never clicks or changes anything on the dashboard, and never sends a message on claude.ai.
// @match        https://brokerage.dashboard.zonos.com/*
// @match        https://claude.ai/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_openInTab
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        window.onurlchange
// @connect      prod-zonos-brokerage.s3.us-east-2.amazonaws.com
// @connect      entry.kars3n.com
// @connect      *
// ==/UserScript==

(() => {
  'use strict';

  // Read at document-start, before claude.ai's router can drop it
  const INITIAL_HASH = location.hash;

  const DASHBOARD_HOST = 'brokerage.dashboard.zonos.com';
  // Any single dispute page; the list page (/duty-disputes) doesn't get the button
  const DISPUTE_PATH = /^\/duty-disputes\/[^/]+\/?$/i;
  const HANDOFF_PREFIX = 'zdr:handoff:';
  const SITE_PREFIX = 'zdr:site:';
  const HANDOFF_TTL_MS = 30 * 60 * 1000;
  const MAX_FILE_BYTES = 15 * 1024 * 1024;

  /* ---------------------------------------------------------------- helpers */

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  async function waitFor(check, { timeout = 15000, interval = 250 } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = check();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  // Builds DOM without innerHTML, so text from the page can never inject markup
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (typeof v === 'boolean' || k === 'value') el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false && kid !== '') el.append(kid);
    return el;
  }

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        timeout: 20000,
        anonymous: true, // never send cookies to merchant sites
        ...opts,
        onload: resolve,
        onerror: () => reject(new Error(`Couldn't reach ${new URL(opts.url).host}`)),
        ontimeout: () => reject(new Error(`${new URL(opts.url).host} took too long to respond`)),
      });
    });
  }

  async function getJson(url) {
    try {
      const r = await gmRequest({ url, headers: { Accept: 'application/json' } });
      if (r.status < 200 || r.status >= 300) return null;
      return JSON.parse(r.responseText);
    } catch {
      return null;
    }
  }

  const htmlToText = html => clean(new DOMParser().parseFromString(html || '', 'text/html').body.textContent);

  function normalizeUrl(value) {
    let v = clean(value);
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
      return new URL(v).href;
    } catch {
      return '';
    }
  }

  const isImage = name => /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/i.test(name);
  const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', pdf: 'application/pdf' };
  const mimeFor = name => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

  const blobToDataUrl = blob => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

  function pageIsDark() {
    for (const el of [document.body, document.documentElement]) {
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (m && (m.length < 4 || +m[3] > 0)) return (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000 < 128;
    }
    return true;
  }

  /* ------------------------------------------------- handoff to claude.ai */

  const listHandoffs = () => GM_listValues()
    .filter(k => k.startsWith(HANDOFF_PREFIX))
    .map(k => GM_getValue(k, null))
    .filter(Boolean);

  function purgeOldHandoffs() {
    for (const x of listHandoffs()) {
      if (Date.now() - x.createdAt > HANDOFF_TTL_MS) GM_deleteValue(HANDOFF_PREFIX + x.id);
    }
  }

  /* ------------------------------------------- dashboard: read the dispute */

  const LINE_RE = /^Line\s+(\d+)\s+[—–-]\s+(.+)$/;
  const ITEM_STOP_RE = /^(order-level documents|audit trail)$/i;

  // A "leaf" is the innermost element that holds text (icons don't count)
  const isLeaf = el => !!clean(el.textContent) && [...el.children].every(c => !clean(c.textContent));
  const leaves = root => [...root.querySelectorAll('*')].filter(isLeaf);
  const findLeaf = (root, re) => leaves(root).find(e => re.test(clean(e.textContent)));
  const lineHeaders = root => [...root.querySelectorAll('span')].filter(s => isLeaf(s) && LINE_RE.test(clean(s.textContent)));

  // Climbs from an item's "Line N — ..." header to the largest block that holds only that item
  function itemBox(header, main) {
    let box = header;
    while (box.parentElement && box.parentElement !== main) {
      const parent = box.parentElement;
      if (lineHeaders(parent).length > 1 || findLeaf(parent, ITEM_STOP_RE)) break;
      box = parent;
    }
    return box;
  }

  // The "Field / Current order / Merchant claims" table; an item card can hold other tables too
  function parseFields(box) {
    const tables = [...box.querySelectorAll('table')];
    const table = tables.find(t => /current order/i.test(t.querySelector('thead')?.textContent || '')) || tables[0];
    if (!table) return [];
    return [...table.querySelectorAll('tbody tr')].map(tr => {
      const cells = [...tr.children].map(td => clean(td.textContent));
      const strip = v => (v || '').replace(/\s*\(unchanged\)$/i, '');
      return { label: cells[0], current: strip(cells[1]), claimed: cells.length > 2 ? strip(cells[2]) : null };
    }).filter(f => f.label);
  }

  // Each claim starts with a span naming a field from the table, then a status, then the merchant's reason.
  // Broker notes and "Decided by" lines are skipped: they're internal and name staff.
  function parseClaims(box, labels) {
    const header = findLeaf(box, /^claims\s*&\s*broker decision$/i);
    if (!header) return [];
    const known = new Set(labels.map(l => l.toLowerCase()));
    const claims = [];
    for (const el of leaves(header.parentElement)) {
      if (el === header || el.closest('button')) continue;
      const text = clean(el.textContent);
      if (el.tagName === 'SPAN' && known.has(text.toLowerCase())) {
        claims.push({ field: text, status: '', reason: '' });
        continue;
      }
      const claim = claims[claims.length - 1];
      if (!claim) continue;
      if (el.tagName === 'P') {
        if (!claim.reason && !/^(decided by|note:)/i.test(text)) claim.reason = text;
      } else if (!claim.status) {
        claim.status = text;
      }
    }
    return claims;
  }

  function extractDispute() {
    const main = document.querySelector('main');
    if (!main) return null;

    const parties = {};
    main.querySelectorAll('dt').forEach(dt => { parties[clean(dt.textContent)] = clean(dt.nextElementSibling?.textContent); });

    const docLinks = [...main.querySelectorAll('a[aria-label^="Download "]')];
    const docOf = a => ({ name: a.getAttribute('aria-label').replace(/^Download\s+/i, ''), url: a.href });

    const boxes = [];
    const items = lineHeaders(main).map(header => {
      const [, line, title] = clean(header.textContent).match(LINE_RE);
      const box = itemBox(header, main);
      boxes.push(box);
      const fields = parseFields(box);
      const trigger = header.closest('button');
      return {
        line: +line,
        title,
        inDispute: fields.length > 0,
        note: trigger ? clean(trigger.textContent).replace(clean(header.textContent), '').trim() : '',
        fields,
        claims: parseClaims(box, fields.map(f => f.label)),
        docs: docLinks.filter(a => box.contains(a)).map(docOf),
      };
    });

    const email = parties.Email || '';
    return {
      disputeId: location.pathname.split('/').filter(Boolean).pop(),
      org: parties.Organization || '',
      emailDomain: (email.split('@')[1] || '').toLowerCase(),
      items,
      orderDocs: docLinks.filter(a => !boxes.some(b => b.contains(a))).map(docOf),
    };
  }

  const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|mail|zoho|yandex|qq|163|126|bigpond|optusnet|comcast|verizon|att|sbcglobal|shaw|rogers|btinternet|orange|web|t-online|libero|naver|hanmail)\./i;
  const guessWebsite = domain => (domain && !FREE_MAIL.test(domain) ? 'https://' + domain : '');

  /* ------------------------------------------ dashboard: merchant site checks */

  const PLATFORMS = [
    ['Shopify', /cdn\.shopify\.com|Shopify\.theme|myshopify\.com|shopify-section/i, hd => hd['x-shopid'] || hd['x-shopify-stage'] || /shopify/i.test(hd['powered-by'] || '')],
    ['WooCommerce', /woocommerce|wc-block-|wc-cart-fragments/i],
    ['WordPress', /\/wp-content\/|\/wp-includes\/|content="WordPress/i],
    ['BigCommerce', /bigcommerce\.com|stencil-utils|BCData/i],
    ['Wix', /wixstatic\.com|wix-bolt|content="Wix\.com/i, hd => hd['x-wix-request-id']],
    ['Squarespace', /squarespace\.com|squarespace-cdn|Squarespace\.Constants/i],
    ['Magento / Adobe Commerce', /Magento_|mage\/cookies|text\/x-magento-init/i],
    ['PrestaShop', /prestashop/i],
    ['Neto / Maropost', /neto\.com\.au|netostatic|maropost/i],
    ['Ecwid', /app\.ecwid\.com|ecwid\.com\/script/i],
    ['Shopware', /shopware/i],
    ['OpenCart', /catalog\/view\/theme|route=product\/product/i],
    ['Webflow', /webflow\.(com|io)|data-wf-site/i],
    ['Square Online / Weebly', /editmysite\.com|weebly\.com|square\.site/i],
    ['GoDaddy Website Builder', /img1\.wsimg\.com/i],
    ['Salesforce Commerce Cloud', /demandware\.(net|static)|dwvar_/i],
    ['Lightspeed eCom', /webshopapp\.com/i],
  ];
  const MARKETPLACES = [['Etsy', /(^|\.)etsy\.com$/i], ['eBay', /(^|\.)ebay\./i], ['Amazon', /(^|\.)amazon\./i]];

  async function inspectSite(url) {
    const r = await gmRequest({ url, headers: { Accept: 'text/html,application/xhtml+xml' } });
    const headers = {};
    for (const line of (r.responseHeaders || '').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const html = r.responseText || '';
    const finalUrl = r.finalUrl || url;
    const { origin, hostname } = new URL(finalUrl);
    const platforms = PLATFORMS.filter(([, re, byHeader]) => re.test(html) || (byHeader && byHeader(headers))).map(([name]) => name);
    for (const [name, re] of MARKETPLACES) if (re.test(hostname)) platforms.push(`${name} (marketplace)`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return {
      origin,
      finalUrl,
      status: r.status,
      platforms,
      generator: doc.querySelector('meta[name="generator"]')?.getAttribute('content') || '',
      title: clean(doc.title),
      blocked: [401, 403, 429, 503].includes(r.status) || /cf-chl|challenge-platform|captcha|attention required/i.test(html.slice(0, 20000)),
    };
  }

  async function shopifySearch(origin, query) {
    const data = await getJson(`${origin}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=4`);
    const found = data?.resources?.results?.products || [];
    return Promise.all(found.slice(0, 3).map(async p => {
      const url = new URL(String(p.url || '').split('?')[0], origin).href;
      const full = (await getJson(url + '.json'))?.product || {};
      const variant = (full.variants || []).find(v => v.sku || v.barcode) || {};
      return {
        title: htmlToText(p.title),
        url,
        vendor: full.vendor || p.vendor || '',
        type: full.product_type || p.type || '',
        sku: variant.sku || '',
        barcode: variant.barcode || '',
        tags: Array.isArray(full.tags) ? full.tags.join(', ') : full.tags || '',
        description: htmlToText(full.body_html || p.body || '').slice(0, 1200),
      };
    }));
  }

  async function wooSearch(origin, query) {
    const found = await getJson(`${origin}/wp-json/wc/store/v1/products?search=${encodeURIComponent(query)}&per_page=3`);
    return (Array.isArray(found) ? found : []).map(p => ({
      title: htmlToText(p.name),
      url: p.permalink,
      sku: p.sku || '',
      type: (p.categories || []).map(c => htmlToText(c.name)).join(', '),
      description: htmlToText(p.short_description || p.description).slice(0, 1200),
    }));
  }

  async function searchMerchant(site, queries) {
    const search = site.platforms.includes('Shopify') ? shopifySearch
      : site.platforms.includes('WooCommerce') ? wooSearch
      : null;
    if (!search) return null; // no product feed to search; Claude will search instead
    for (const q of queries) {
      const found = await search(site.origin, q).catch(() => []);
      if (found.length) return found;
    }
    return [];
  }

  // Turns "DrAlienSmith_SubMic_sku_34219_MPN_1.jpg" into "Alien Smith Sub Mic"
  function fileNameQuery(name, org) {
    const orgWords = new Set(org.toLowerCase().split(/\W+/));
    const words = name
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[\s_\-.()]+/)
      .filter(w => /^[a-z]{3,}$/i.test(w) && /[aeiouy]/i.test(w))
      .filter(w => !/^(screen|shot|screenshot|image|img|temp|photo|pic|scan|receipt|invoice|order|copy|final|edited|file|untitled|sku|mpn|upc|ean|part|model|item)$/i.test(w))
      .filter(w => !orgWords.has(w.toLowerCase()));
    return words.join(' ');
  }

  // Product numbers: labeled ones ("sku 34219", "Part #A-100") and codes that mix letters and digits ("WA-CX24")
  const LABELED_ID = /\b(?:sku|mpn|upc|ean|gtin|asin|model|part|p\/n|pn|item|art|article|ref|style)\s*(?:no\.?|number|#)?\s*[:#.-]?\s*([a-z0-9][a-z0-9\-\/.]*[a-z0-9])/gi;
  const CODE_TOKEN = /\b[a-z0-9]+(?:[-\/.][a-z0-9]+)*\b/gi;
  const NOT_AN_ID = /^(\d+(\.\d+)?(mm|cm|m|kg|g|lb|lbs|oz|v|w|kw|mah|hz|khz|mhz|ml|l|in|ft|pcs|pc|x)|(invoice|receipt|order|screenshot|screen|img|image|photo|scan|temp|file|doc|dsc|pxl|whatsapp)[\w\-\/.]*)$/i;

  function idsIn(text) {
    const t = (text || '').replace(/_/g, ' ');
    const found = [];
    for (const m of t.matchAll(LABELED_ID)) if (m[1].length >= 3 && /\d/.test(m[1])) found.push(m[1]);
    for (const [tok] of t.matchAll(CODE_TOKEN)) {
      if (tok.length >= 4 && tok.length <= 24 && /\d/.test(tok) && /[a-z]/i.test(tok) && !NOT_AN_ID.test(tok)) found.push(tok);
    }
    return [...new Set(found)];
  }

  function productNumbers(d) {
    const found = new Map();
    const add = (id, from) => { if (!found.has(id.toLowerCase())) found.set(id.toLowerCase(), { id, from }); };
    for (const item of d.items.filter(i => i.inDispute)) {
      const desc = item.fields.find(f => /^description$/i.test(f.label));
      [item.title, desc?.current, desc?.claimed].forEach(v => idsIn(v).forEach(id => add(id, 'the item description')));
      item.claims.forEach(c => idsIn(c.reason).forEach(id => add(id, "the merchant's reason")));
    }
    for (const doc of [...d.items.flatMap(i => i.docs), ...d.orderDocs]) {
      idsIn(doc.name.replace(/\.[a-z0-9]{2,5}$/i, '')).forEach(id => add(id, `the file name ${doc.name}`));
    }
    return [...found.values()].slice(0, 8);
  }

  // Product numbers first, then names from photo filenames, then the customs descriptions
  function queriesFor(item, dispute) {
    const desc = item.fields.find(f => /^description$/i.test(f.label));
    const photos = [...item.docs, ...dispute.orderDocs].filter(d => isImage(d.name));
    const fromFiles = photos.map(d => fileNameQuery(d.name, dispute.org));
    const ids = productNumbers(dispute).map(x => x.id);
    const all = [...ids, ...fromFiles, desc?.claimed, desc?.current].map(q => clean(q).slice(0, 80)).filter(q => q.length >= 3);
    return [...new Set(all)].slice(0, 5);
  }

  // Store home page, keeping a locale path like /au/ that some stores need for search to work
  function storeBase(site) {
    const u = new URL(site.finalUrl);
    return u.origin + (/^\/[a-z]{2}(-[a-z]{2})?\/?$/i.test(u.pathname) ? u.pathname.replace(/\/$/, '') : '');
  }

  // Search-page links for the merchant's own site, which web search often doesn't index well
  function siteSearchUrl(site) {
    const p = site.platforms;
    const base = storeBase(site);
    const q = encodeURIComponent;
    if (p.includes('Shopify')) return t => `${base}/search?q=${q(t)}&type=product`;
    if (p.includes('WooCommerce')) return t => `${base}/?s=${q(t)}&post_type=product`;
    if (p.includes('WordPress')) return t => `${base}/?s=${q(t)}`;
    if (p.includes('Magento / Adobe Commerce')) return t => `${base}/catalogsearch/result/?q=${q(t)}`;
    if (p.includes('BigCommerce')) return t => `${base}/search.php?search_query=${q(t)}`;
    if (p.includes('Squarespace')) return t => `${base}/search?q=${q(t)}`;
    return null;
  }

  /* ---------------------------------------------- dashboard: Entry Assistant */

  // Your Entry Assistant API: what a code covers, its rates, extra duties, notes, CBP rulings, and code comparisons.
  // The token is kept in Tampermonkey's storage (set it in the panel's Settings), never in this file.
  const ENTRY_API = 'https://entry.kars3n.com/api/v1';
  const TOKEN_KEY = 'zdr:entryToken';

  async function entryApi(path, timeout = 30000) {
    const token = GM_getValue(TOKEN_KEY, '');
    if (!token) throw apiError('no-token', 'No Entry Assistant token is saved. Add it under Settings at the bottom of this panel.');
    let r;
    try {
      r = await gmRequest({ url: `${ENTRY_API}/${path}`, headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, timeout });
    } catch (e) {
      throw apiError('unreachable', `${e.message}. If Tampermonkey asked whether to allow the connection, allow it.`);
    }
    if (r.status === 401 || r.status === 403) throw apiError('bad-token', 'Entry Assistant rejected the token. Check it under Settings.');
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw apiError('server', `Entry Assistant answered ${r.status}.`);
    try {
      return JSON.parse(r.responseText);
    } catch {
      throw apiError('server', "Entry Assistant sent back something that isn't JSON.");
    }
  }

  const apiError = (kind, message) => Object.assign(new Error(message), { kind });

  // What the prompt tells Claude when the script's lookup didn't work
  const LOOKUP_FAILED = {
    'no-token': 'no Entry Assistant token is saved in the script',
    'bad-token': 'the Entry Assistant API rejected the saved token',
    unreachable: "the script couldn't reach the Entry Assistant API",
    server: 'the Entry Assistant API returned an error',
  };

  // People paste the token in several forms: bare, "Bearer …", or the whole "export ENTRY_API_TOKEN=…" line
  const cleanToken = v => clean(v).replace(/^.*ENTRY_API_TOKEN\s*=\s*/i, '').replace(/^(authorization:\s*)?bearer\s+/i, '').replace(/^["']+|["']+$/g, '').trim();

  const digitsOf = v => (v || '').replace(/\D/g, '');
  const hsCodeIn = v => (v || '').split(/[^\d.]+/).find(t => /^\d{4}\.?\d{2}/.test(t)) || '';
  const isChapter99 = code => digitsOf(code).startsWith('99');
  const isoCountry = v => (/^[A-Z]{2}$/.test(v || '') ? v : '');

  // The dashboard sometimes shows a code with an extra digit (4202.91.80900), so fall back to shorter valid lengths
  function codeCandidates(raw) {
    const d = digitsOf(raw);
    const fmt = x => [x.slice(0, 4), x.slice(4, 6), x.slice(6, 8), x.slice(8, 10)].filter(Boolean).join('.');
    return [...new Set([10, 8, 6].filter(n => d.length >= n).map(n => fmt(d.slice(0, n))))];
  }

  const extraText = list => (list || []).map(e => `${e.value} ${e.what}${e.detail ? ` (${e.detail})` : ''}`).join('; ');

  // Rulings are fetched separately (fetchRulings), so a slow rulings search can't hold up the code lookup
  async function lookupCode(raw, from) {
    const params = ['rulings=0', from && `from=${encodeURIComponent(from)}`].filter(Boolean).join('&');
    for (const code of codeCandidates(raw)) {
      const res = await entryApi(`code/${code}?${params}`);
      if (!res) continue;
      return {
        asked: raw,
        code: res.code,
        release: res.release || '',
        meaning: clean(res.meaning),
        general: res.rates?.general || '',
        originName: res.origin?.name || '',
        originRate: res.origin?.rate || '',
        extraDuties: res.extraDuties || [],
        extra: extraText(res.extraDuties),
        payLess: (res.payLess || []).map(p => `${p.value} ${p.what}${p.detail ? `: ${p.detail}` : ''}`),
        rulings: [],
      };
    }
    return { asked: raw, notFound: true };
  }

  async function fetchRulings(code) {
    const res = await entryApi(`code/${code}`, 20000);
    return (res?.rulings?.newest || []).filter(x => !x.revoked).slice(0, 3);
  }

  // Text of a Chapter 99 heading, cached because the same Section 232 headings come up again and again
  const headingCache = new Map();
  function headingText(code) {
    if (!headingCache.has(code)) {
      headingCache.set(code, entryApi(`code/${code}?rulings=0`).then(res => {
        if (!res) return '';
        const rate = res.rates?.general && !/^no change$/i.test(res.rates.general) ? ` (${res.rates.general})` : '';
        return clean(res.meaning) + rate;
      }).catch(() => ''));
    }
    return headingCache.get(code);
  }

  // The Chapter 99 headings a code's extra duties point to, so Claude can pick the one that fits the metal, use and origin
  async function addChapter99(c) {
    if (c.notFound) return;
    const codes = [...new Set(c.extraDuties.flatMap(e => e.headings || []))].slice(0, 16);
    const texts = await Promise.all(codes.map(headingText));
    c.chapter99 = codes.map((code, i) => ({ code, text: texts[i] }));
  }

  // Every disputed item gets its code(s) looked up for the declared origin, with their Chapter 99 headings.
  // Rulings and the code comparison only when the HS code is disputed; the second origin only when origin is.
  // One failed call doesn't sink the rest: it's noted in `problems`, unless the token itself is the problem.
  async function gatherFacts(item) {
    const hs = item.fields.find(f => /^hs code$/i.test(f.label));
    const origin = item.fields.find(f => /^country of origin$/i.test(f.label));
    const current = hsCodeIn(hs?.current);
    const claimed = hsCodeIn(hs?.claimed);
    const from = isoCountry(origin?.current);
    const claimedFrom = isoCountry(origin?.claimed);
    const facts = { codes: [], compare: null, origins: [], problems: [] };
    let firstError = null;
    const attempt = async (label, run, fallback) => {
      try {
        return await run();
      } catch (e) {
        if (e.kind === 'no-token' || e.kind === 'bad-token') throw e;
        firstError = firstError || e;
        facts.problems.push(`${label}: ${e.message}`);
        console.warn('[Dispute Researcher]', label, e);
        return fallback;
      }
    };

    const wanted = [['Current code', current], ["Merchant's code", claimed]].filter(([, raw]) => raw);
    facts.codes = await Promise.all(wanted.map(([role, raw]) => attempt(`${role} ${raw}`,
      () => lookupCode(raw, isChapter99(raw) ? '' : from).then(r => ({ ...r, role })),
      { asked: raw, role, failed: true })));
    if (facts.codes.length && facts.codes.every(c => c.failed)) throw firstError;

    const found = facts.codes.filter(c => c.code);
    const [a, b] = facts.codes.map(c => c.code);
    await Promise.all([
      claimed && a && b && !isChapter99(a) && !isChapter99(b) && attempt('Code comparison',
        async () => { facts.compare = await entryApi(`compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`); }),
      claimed && attempt('CBP rulings', () => Promise.all(found.filter(c => !isChapter99(c.code)).map(async c => { c.rulings = await fetchRulings(c.code); }))),
      current && from && claimedFrom && facts.codes[0].code && attempt(`Duty if made in ${claimedFrom}`,
        async () => { facts.origins = [{ ...facts.codes[0], from }, { ...(await lookupCode(current, claimedFrom)), from: claimedFrom, role: 'Current code' }]; }),
    ]);
    await Promise.all([...found, ...facts.origins.slice(1)].map(addChapter99));
    return facts;
  }

  function factLines(f) {
    const L = [];
    if (f.codes.length) {
      const release = f.codes.find(c => c.release)?.release;
      L.push('', `HTS facts from the Entry Assistant API${release ? ` (${release})` : ''}:`);
      for (const c of f.codes) {
        if (c.failed || c.notFound) {
          L.push(`- ${c.role} ${c.asked}: ${c.failed ? 'the lookup failed, so check it yourself' : 'not found in the current HTS'}.`);
          continue;
        }
        const shown = digitsOf(c.code) === digitsOf(c.asked) ? c.code : `${c.asked} (closest valid code: ${c.code})`;
        const duty = c.originName ? `Duty if made in ${c.originName}: ${c.originRate || c.general || 'none listed'}` : `General duty: ${c.general || 'none listed'}`;
        L.push(`- ${c.role} ${shown}: ${c.meaning}. ${duty}.${c.extra ? ` Extra duties: ${c.extra}.` : ''}`);
        if (c.payLess.length) L.push(`  Ways it may pay less: ${c.payLess.join('; ')}`);
      }
      const cmp = f.compare;
      if (cmp) {
        if (cmp.summary) L.push(`- Where they split: ${clean(cmp.summary)}`);
        if (cmp.decide?.length) L.push(`- What decides it: ${cmp.decide.map(x => x.rule).join(', then ')}. ${clean(cmp.decide[0].says)}`);
        for (const n of (cmp.notes || []).slice(0, 6)) {
          const out = [n.leavesOut?.a && 'leaves out the current code', n.leavesOut?.b && "leaves out the merchant's code"].filter(Boolean).join(', ');
          L.push(`- ${n.name}${out ? ` (${out})` : ''}: "${clean(n.quote)}"`);
        }
      }
      const rulings = f.codes.flatMap(c => (c.rulings || []).map(r => ({ ...r, code: c.code })));
      if (rulings.length) L.push('- CBP rulings:', ...rulings.map(r => `  - ${r.number} (${r.date}, ${r.code}): ${clean(r.subject)} ${r.url}`));
    }
    if (f.origins.length) {
      L.push('', 'Duty on the current code by country of origin (Entry Assistant API):');
      for (const o of f.origins) {
        L.push(`- Made in ${o.originName || o.from}: ${o.notFound ? 'no answer' : `${o.originRate || o.general || 'no rate listed'}${o.extra ? `; extra: ${o.extra}` : ''}`}`);
      }
    }
    // One list per code and origin; a list identical to one already shown is skipped
    const shownLists = [];
    for (const c of [...f.codes, ...f.origins.slice(1)]) {
      if (!c.chapter99?.length) continue;
      const key = c.chapter99.map(x => x.code).join(',');
      if (shownLists.includes(key)) continue;
      shownLists.push(key);
      const metalRule = c.extraDuties.some(e => /232/.test(e.what || ''))
        ? "Which one applies depends on the metal, how much of the weight is metal, what the item is used for, and where it's made:"
        : 'Check which of these applies to the goods:';
      L.push('', `Chapter 99 headings that may apply to the ${c.role.toLowerCase()} ${c.code}${c.originName ? ` if made in ${c.originName}` : ''} (Entry Assistant API). ${metalRule}`);
      L.push(...c.chapter99.map(x => `- ${x.code}: ${x.text || 'no text returned'}`));
    }
    return L;
  }

  /* ------------------------------------------------- dashboard: the prompt */

  // What counts as evidence for each kind of claim
  const CLAIM_CHECKS = [
    [/hs code/i, "Does the product, as the evidence shows it, fit the merchant's code better than the current one? Use the HTS facts, notes and rulings here plus your own HTS knowledge (GRI, section and chapter notes)."],
    [/description/i, 'Does the claimed description match what the product actually is and how it is marketed (listing titles, categories, what it fits)?'],
    [/origin/i, 'Is there proof of where it was made: "Made in" marks in the images, where the manufacturer makes it, listings? The merchant saying so is not proof.'],
    [/value/i, 'Does the claimed value match the price actually paid, per the invoice, receipt or listing? Complaints about duties or fees are not a reason to change the declared value.'],
    [/qty|quantity|weight/i, 'Does it match the invoice, listing or shipping documents?'],
  ];
  const CHAPTER_99_CHECK = "The merchant's code is a Chapter 99 provision, which adds a duty on top of a regular code rather than replacing it. Work out what the merchant actually means (for example, steel rather than aluminum) and whether the evidence supports that.";

  function checkFor(field, item) {
    const hs = item.fields.find(f => /^hs code$/i.test(f.label));
    if (/hs code/i.test(field) && isChapter99(hsCodeIn(hs?.claimed))) return CHAPTER_99_CHECK;
    return (CLAIM_CHECKS.find(([re]) => re.test(field)) || [null, 'What evidence supports or contradicts it?'])[1];
  }

  // Claims as the merchant filed them, or the changed fields when the page shows no claim text
  const claimsOf = item => (item.claims.length ? item.claims : item.fields.filter(f => f.claimed).map(f => ({ field: f.label, reason: '' })));

  const CHAPTER_GUIDES = [
    [1, 5, 'animal products', ['Species', 'Fresh, chilled, frozen, dried or otherwise processed']],
    [6, 14, 'plant products', ['Species', 'How it is processed']],
    [15, 15, 'fats and oils', ['Source of the fat or oil', 'Crude or refined']],
    [16, 23, 'prepared foods and drinks', ['Ingredients and their percentages', 'How it is prepared and packaged']],
    [24, 24, 'tobacco and nicotine', ['Tobacco or nicotine content', 'Device, liquid or leaf product']],
    [25, 27, 'minerals and fuels', ['Mineral or fuel type', 'Purity or grade']],
    [28, 38, 'chemicals and cosmetics', ['Chemical composition and CAS numbers', 'Intended use, for example cosmetic or medicinal']],
    [39, 39, 'plastics', ['Type of plastic', 'Form (sheet, film or finished article) and use']],
    [40, 40, 'rubber', ['Type of rubber and whether it is vulcanized', 'Use']],
    [41, 43, 'leather goods, bags and fur', ['Outer surface material (leather type, plastic or textile)', 'Animal source of any leather or fur']],
    [44, 46, 'wood', ['Wood species', 'Treatment or processing']],
    [47, 49, 'paper and printed matter', ['Paper type or printed content', 'Use']],
    [50, 63, 'textiles and apparel', ['Fiber content by percentage', 'Knit or woven', "Garment type and who it's for (men, women, children)"]],
    [64, 64, 'footwear', ['Upper material', 'Outsole material', 'Whether it covers the ankle']],
    [65, 67, 'headgear, umbrellas and similar', ['Material', 'Construction']],
    [68, 70, 'stone, ceramic and glass', ['Material', 'Use']],
    [71, 71, 'jewelry and precious metals', ['Precious metal content or karat', 'Plating', 'Natural or synthetic stones']],
    [72, 73, 'iron and steel', ['Metal composition (steel, aluminum or other)', 'Country where the steel was melted and poured']],
    [74, 75, 'copper and nickel', ['Metal composition']],
    [76, 76, 'aluminum', ['Aluminum content or alloy', 'Country where the aluminum was smelted and where it was last cast']],
    [78, 81, 'other base metals', ['Metal composition']],
    [82, 83, 'tools and base-metal articles', ['Material of the working part or blade', 'Metal composition']],
    [84, 84, 'machinery', ['What it does and how it is powered', 'Complete machine or a part, and what it is a part of', 'Main material, if it is a metal part']],
    [85, 85, 'electrical equipment', ['What it does and how it is powered', 'Complete device, part or accessory, and of what', 'Wired or wireless']],
    [86, 89, 'vehicles and vehicle parts', ['Which vehicles it fits', 'What the part does', 'Whether it is made only for vehicles']],
    [90, 92, 'instruments', ['What it measures or does', 'Medical or non-medical use']],
    [93, 93, 'arms and ammunition', ['Type and function']],
    [94, 94, 'furniture and lighting', ['Frame or main material', 'Use, and light source if it is a lamp']],
    [95, 95, 'toys, games and sports equipment', ['Age grading', 'Toy, game or sports equipment']],
    [96, 96, 'miscellaneous manufactured articles', ['Material', 'Use']],
    [97, 97, 'art and antiques', ['Original or reproduction', 'Age']],
  ];
  const CHAPTER_99_POINTS = [
    'Metal composition (steel, aluminum, copper or other) and rough percentages, since Chapter 99 codes often add duties based on metal content (Section 232) or Chinese origin (Section 301)',
    'Where any steel was melted and poured, or any aluminum smelted and cast',
    'Any sign it was made in China',
  ];

  function checklistFor(item) {
    const hs = item.fields.find(f => /^hs code$/i.test(f.label));
    const codes = [hs?.current, hs?.claimed].filter(Boolean).flatMap(v => v.split(/[^\d.]+/)).filter(t => /^\d{4}/.test(t));
    const chapters = [...new Set(codes.map(c => +c.slice(0, 2)))];
    const points = ['What exactly the product is (brand, model or SKU) and what it does', 'What it is made of', 'Where it was made'];
    const basis = [];
    for (const ch of chapters) {
      if (ch === 99) {
        basis.push('a Chapter 99 code');
        points.push(...CHAPTER_99_POINTS);
        continue;
      }
      const guide = CHAPTER_GUIDES.find(([from, to]) => ch >= from && ch <= to);
      if (guide) {
        basis.push(`chapter ${ch} (${guide[2]})`);
        points.push(...guide[3]);
      }
    }
    return { basis: basis.length ? `HS ${basis.join(' and ')}` : 'the item description', points: [...new Set(points)] };
  }

  // Rows that rarely help; included only when the merchant changed them. Declared value always shows, for the price comparison.
  const MINOR_FIELDS = /^(qty|quantity)/i;

  // Claude on claude.ai can only reach the API through the entry-assistant skill (it holds its own token)
  const SKILL_STEP = "Use the entry-assistant skill (it calls the Entry Assistant API) to check anything else relevant: look up any other code the evidence points to, such as the right code for how the item is actually marketed, and compare it with the current code; search CBP rulings for this kind of product; read the section, chapter and Chapter 99 notes named above; and check the duties and Chapter 99 headings for the origin you actually find. If you don't have the skill or it can't reach the API, say so in one line and carry on.";

  const IMAGE_STEP ='Start with the attached images, before any searching. Look at each one closely and zoom in on small print. Write down every piece of text or marking you can read: brand names and logos; model, part, SKU and serial numbers; barcodes (UPC/EAN); "Made in" or "Product of" marks; material, fiber and care tags; stamped, cast or engraved marks on metal or plastic; certification marks and IDs (CE, UL, FCC ID, RoHS); and anything printed on packaging or shipping labels. Say what each image shows. If something is too blurry to read with confidence, say so instead of guessing.';

  function buildPrompt(d, s, attachedNames) {
    const L = [];
    const items = d.items.filter(i => i.inDispute);
    const allDocs = [...d.items.flatMap(i => i.docs), ...d.orderDocs].map(x => x.name);
    const notAttached = allDocs.filter(n => !attachedNames.includes(n));
    const hasImages = attachedNames.some(isImage);
    const claims = items.flatMap(item => claimsOf(item).map(c => ({ ...c, line: item.line })));
    const about = re => claims.some(c => re.test(c.field));
    const productClaim = about(/hs code|description|origin/i);

    L.push("I'm a customs broker reviewing a duty dispute. For each claim below, find out whether there's real evidence for it. Research thoroughly, then reply briefly.");

    L.push('', '## Merchant', `- Name: ${d.org || 'unknown'}`);
    const website = normalizeUrl(s.website);
    if (!website) L.push('- Website: not provided. Find it from the name if you can.');
    else if (s.site?.platforms.length) L.push(`- Website: ${s.site.finalUrl} (${s.site.platforms.join(', ')})`);
    else L.push(`- Website: ${s.site?.finalUrl || website}`);

    for (const item of items) {
      L.push('', items.length > 1 ? `## Line ${item.line}: ${item.title}` : `## Item: ${item.title}`);
      L.push('| Field | Current entry | Merchant says |', '|---|---|---|');
      for (const f of item.fields.filter(x => x.claimed || !MINOR_FIELDS.test(x.label))) {
        L.push(`| ${f.label} | ${f.current} | ${f.claimed || 'no change'} |`);
      }
      // Decision statuses stay out of the prompt so the research isn't steered by them
      const itemClaims = claimsOf(item);
      if (itemClaims.length) {
        L.push('', 'Claims to check:');
        itemClaims.forEach((c, i) => {
          const same = itemClaims.slice(0, i).find(p => p.reason && p.reason === c.reason);
          const reason = same ? `same reason as ${same.field}` : c.reason ? `"${c.reason}"` : 'none given';
          L.push(`- ${c.field}. Merchant's reason: ${reason}. Check: ${checkFor(c.field, item)}`);
        });
      }
      const facts = s.facts?.[item.line];
      if (facts?.data) L.push(...factLines(facts.data));
      else if (facts?.error) L.push('', `HTS facts: the script's lookup didn't run (${LOOKUP_FAILED[facts.kind] || 'the lookup failed'}). Look the codes up with the entry-assistant skill if you have it, otherwise use your own HTS knowledge, and say which in the reply.`);
      const matches = s.matches[item.line];
      if (matches?.length) {
        L.push('', "Possible matches on the merchant's site (found by searching it; not verified):");
        for (const p of matches) {
          const meta = [p.vendor && `vendor: ${p.vendor}`, p.type && `type: ${p.type}`, p.sku && `SKU: ${p.sku}`, p.barcode && `barcode: ${p.barcode}`, p.tags && `tags: ${p.tags}`].filter(Boolean).join(' | ');
          L.push(`- ${p.title}: ${p.url}${meta ? ` | ${meta}` : ''}`);
          if (p.description) L.push(`  Description: ${p.description}`);
        }
      }
      const terms = queriesFor(item, d);
      const searchUrl = s.site && siteSearchUrl(s.site);
      if (terms.length && searchUrl) {
        L.push('', "Search the merchant's site for it (open each link):", ...terms.map(t => `- ${searchUrl(t)}`));
      } else if (terms.length && website) {
        const host = new URL(s.site?.finalUrl || website).hostname;
        L.push('', "Search the merchant's site for it, for example with these web searches:", ...terms.map(t => `- site:${host} ${t}`));
      }
      if (productClaim) {
        const guide = checklistFor(item);
        L.push('', `What to find (based on ${guide.basis}):`, ...guide.points.map(p => `- ${p}`));
      }
    }

    const ids = productNumbers(d);
    if (ids.length) {
      L.push('', '## Product numbers found so far', ...ids.map(x => `- ${x.id} (from ${x.from})`));
    }
    if (attachedNames.length) L.push('', '## Attached files', `${attachedNames.join(', ')}. File names sometimes include the product name or a part number.`);
    if (notAttached.length) L.push('', `Other files on the dispute, not attached (the names may still hint at the product): ${notAttached.join(', ')}`);

    const sitemap = website && `${new URL(s.site?.finalUrl || website).origin}/sitemap.xml`;
    const siteStep = website
      ? `Search the merchant's website for the item. Open the search links above, then search the site again for any new numbers or names you found in the images. Open the matching product page and read all of it: description, specs, materials, price, any "Made in" text and reviews. Then look around the site: the item's category, other products from the same brand, and the About, FAQ and Shipping pages, which often say where products are made or shipped from. If the site's search doesn't work, use its sitemap (${sitemap}) or a web search limited to the site.`
      : "Find the merchant's website from their name, then search it for the item: product numbers first, then the product name. Open the matching product page and read all of it, then look around the site: the item's category, other products from the same brand, and the About, FAQ and Shipping pages.";

    const allFacts = Object.values(s.facts || {}).filter(f => f.data).map(f => f.data);
    const hasChapter99 = allFacts.some(f => [...f.codes, ...f.origins].some(c => c.chapter99?.length));
    // Metal matters when Section 232 can apply, or when the merchant's code is itself a Chapter 99 metal provision
    const metalMatters = allFacts.some(f => f.codes.some(c => /232|steel|aluminum|copper/i.test(c.extra || '')))
      || items.some(i => isChapter99(hsCodeIn(i.fields.find(f => /^hs code$/i.test(f.label))?.claimed)));
    const declared = items.map(i => i.fields.find(f => /^declared value$/i.test(f.label))?.current).filter(Boolean);
    const platformUnknown = !!website && !s.site?.platforms.length;
    const valueStep = about(/value/i) && "For the value claim, find the price actually paid: the invoice or receipt if one is attached, otherwise the listing price around the order date.";
    const judgeStep = "Judge each claim. First: does the merchant's reason actually address the field they want changed? If it doesn't (for example, asking to lower the declared value while only complaining about duties), the claim has no substance unless the documents show otherwise. Then weigh the evidence against that claim's \"Check\"." +
      (allFacts.length ? ' The HTS facts above come from the current HTS release, so trust them over memory.' : '');

    const steps = [
      hasImages && IMAGE_STEP,
      siteStep,
      'Search the web for each product number in quotes, one at a time, including any you found in the images. Then search the brand and model, then a plain description of the item. Try variations: with and without dashes or spaces, and partial numbers. Don\'t stop at the first result.',
      "Find how the item is marketed: listing titles, categories, and what it fits or is compatible with, on the merchant's site and on marketplaces. Compare that with the declared description and the merchant's description. For example, a lever sold for ATVs or motorcycles is a vehicle part, not a farm machinery part.",
      `Find prices for the same item: the merchant's site, eBay (including sold listings), AliExpress, Amazon and anywhere else it's sold. Compare them with the declared value${declared.length === 1 ? ` (${declared[0]})` : ''}.`,
      valueStep,
      productClaim && "Find the manufacturer's own page for the item, plus spec sheets or datasheets.",
      productClaim && 'Answer every "What to find" point.',
      (productClaim || metalMatters) && "Find what it's made of. If it's metal, say which metal (steel, stainless steel, aluminum, copper or brass, zinc alloy) and roughly how much of its weight is metal, using the images, listings and spec sheets.",
      productClaim && 'Look for country-of-origin evidence: "Made in" marks in the images or on listings; where the manufacturer is based and where it has factories; the same product sold by overseas sellers on AliExpress, Alibaba, 1688, DHgate, Temu or Amazon. A barcode prefix only shows where the barcode was registered, not where the item was made.',
      hasChapter99 && "Using the Chapter 99 headings above, work out which ones apply. For Section 232 headings that comes down to the metal, the share of the weight that is metal, what the item is used for (for example motorcycle or other vehicle parts), and where it's made.",
      about(/qty|quantity|weight/i) && 'For a quantity or weight claim, compare it with the invoice, the listing or the shipping documents.',
      platformUnknown && "Name the e-commerce platform the merchant's site runs on (Shopify, WooCommerce and so on).",
      "Compare what you found with what the merchant says: their description, their reasons, and the exact wording of any code they want (size limits, materials, use). Note every mismatch for the Discrepancies line.",
      SKILL_STEP,
      judgeStep,
    ].filter(Boolean);
    L.push('', '## How to research', ...steps.map((step, i) => `${i + 1}. ${step}`));
    L.push('', "If a page won't open, say which one and try another route: the site's search, its sitemap, or a web search limited to the site (site: plus the domain and the product number).");
    L.push('Use as many searches as it takes. A thorough answer matters more than a fast one.');

    // Short scannable lines first, the supporting detail after, and a one-sentence verdict last
    const lineNote = c => (items.length > 1 ? ` (line ${c.line})` : '');
    L.push(
      '', '## Reply',
      'Be brief: short bullet lines, no paragraphs, no greeting, no recap of the dispute. Use exactly this layout:',
      '',
      about(/hs code/i) && '- **Code it should be:** the HTS code the evidence supports, and why in a few words',
      '- **Description it should be:** a plain, accurate customs description of the item',
      `- **Prices found:** the lowest and highest price for this item, each with its source and link, against the declared value${declared.length === 1 ? ` (${declared[0]})` : ''}${about(/value/i) ? ' and what the invoice or receipt shows' : ''}`,
      '- **Marketed use:** what listings say it is for and what it fits',
      "- **Discrepancies:** one short sub-bullet for each place the search results contradict the merchant. For example: the merchant's code covers microphones no more than 10 mm across, but this one is 60 mm. Write \"None found\" if there are none.",
      (productClaim || metalMatters) && '- **Made of:** the materials; for metal, which metal and roughly its share of the weight',
      hasChapter99 && '- **Chapter 99:** which headings apply and why, in a few words',
      (about(/origin/i) || hasChapter99) && "- **Origin:** where it's made, and the evidence",
      "- **Missing info:** what you couldn't find that would settle it, such as internal components, metal content or dimensions. Write \"Nothing important\" if you found it all.",
      '',
      '**More details**',
      ...claims.map(c => `- ${c.field} claim${lineNote(c)}: supported, not supported or unclear, and why, with a link`),
      "- Item found: name, brand, model or part number, and the merchant's listing link",
      hasImages && '- Read from images: only the text or numbers that matter',
      platformUnknown && "- Platform: what the merchant's site runs on",
      "- API checks: what you looked up with the entry-assistant skill, or why you couldn't",
      '',
      'Finish with exactly one sentence on its own line, choosing one of the three: "The merchant\'s claim is substantiated / somewhat substantiated / not substantiated because …"',
      '',
      "Link a source for every fact. If you can't find something, put it under Missing info instead of guessing.",
    );
    return L.filter(line => line !== false).join('\n');
  }

  /* ------------------------------------------------- dashboard: the panel */

  const PANEL_CSS = `
    :host { all: initial; --bg:#ffffff; --fg:#18181b; --muted:#71717a; --line:#e4e4e7; --soft:#f4f4f5; --accent:#b45309; --accent-fg:#ffffff; --ok:#15803d; --warn:#b45309; --err:#b91c1c; }
    :host([data-theme="dark"]) { --bg:#0c0c0d; --fg:#f4f4f5; --muted:#a1a1aa; --line:#27272a; --soft:#18181b; --accent:#f59e0b; --accent-fg:#111111; --ok:#4ade80; --warn:#fbbf24; --err:#f87171; }
    * { box-sizing: border-box; }
    .wrap { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); }
    button { font: inherit; cursor: pointer; }
    button:disabled { opacity: .55; cursor: default; }
    button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .launch { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 999px; padding: 10px 16px; font-weight: 600; box-shadow: 0 6px 20px rgba(0,0,0,.35); }
    .panel { position: fixed; top: 0; right: 0; height: 100vh; width: min(460px, 100vw); z-index: 2147483001; display: flex; flex-direction: column; background: var(--bg); color: var(--fg); border-left: 1px solid var(--line); box-shadow: -10px 0 30px rgba(0,0,0,.3); }
    [hidden] { display: none !important; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    header .sub { display: block; color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; margin-top: 2px; }
    .icon { background: none; border: 0; color: var(--muted); font-size: 20px; line-height: 1; padding: 2px 6px; border-radius: 6px; }
    .icon:hover { color: var(--fg); background: var(--soft); }
    .body { flex: 1; overflow-y: auto; padding: 14px 16px; }
    footer { border-top: 1px solid var(--line); padding: 12px 16px; }
    .section { margin-bottom: 18px; }
    .label { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
    .row { display: flex; gap: 6px; }
    input[type="text"], input[type="password"] { flex: 1; min-width: 0; font: inherit; background: var(--soft); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
    .primary { background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 6px; padding: 8px 12px; font-weight: 600; }
    .secondary { background: transparent; color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 7px 12px; }
    .secondary:hover { background: var(--soft); }
    .muted { color: var(--muted); }
    .hint { color: var(--muted); font-size: 12px; margin: 4px 0 0; }
    .ok { color: var(--ok); } .warn { color: var(--warn); } .err { color: var(--err); }
    .kv { display: grid; grid-template-columns: 96px 1fr; gap: 2px 8px; margin-top: 8px; font-size: 12px; }
    .kv dt { color: var(--muted); } .kv dd { margin: 0; overflow-wrap: anywhere; }
    .item { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
    .item.quiet { color: var(--muted); font-size: 12px; padding: 8px 12px; }
    .item-title { font-weight: 600; margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
    th { color: var(--muted); font-weight: 500; }
    td.claimed { color: var(--accent); font-weight: 600; }
    ul { margin: 0; padding-left: 18px; }
    li { margin: 4px 0; }
    .reason { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }
    .reason.open { display: block; }
    .chip { display: inline-block; margin-left: 6px; padding: 0 6px; border: 1px solid var(--line); border-radius: 999px; font-size: 11px; color: var(--muted); }
    .ids { display: flex; flex-wrap: wrap; gap: 6px; } .ids .chip { margin-left: 0; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--fg); }
    .sub-block { margin-top: 10px; }
    .doc { display: flex; align-items: baseline; gap: 6px; margin: 3px 0; font-size: 12px; overflow-wrap: anywhere; }
    a { color: var(--accent); }
    .actions { display: flex; gap: 8px; }
    .status { min-height: 18px; margin-top: 8px; font-size: 12px; color: var(--muted); }
    .fine { margin: 6px 0 0; font-size: 11px; color: var(--muted); }
    .fact { font-size: 12px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .settings { margin-top: 8px; font-size: 12px; }
    .settings summary { cursor: pointer; color: var(--muted); }
  `;

  function createPanel() {
    const host = h('div', { id: 'zdr-host' });
    const root = host.attachShadow({ mode: 'open' });
    // Keep the dashboard's keyboard shortcuts from firing while typing in the panel
    for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, e => e.stopPropagation());

    const subtitle = h('span', { class: 'sub' });
    const body = h('div', { class: 'body' });
    const status = h('div', { class: 'status', role: 'status' });
    const openBtn = h('button', { class: 'primary', type: 'button', text: 'Open in Claude', onclick: () => run(handoff) });
    const copyBtn = h('button', { class: 'secondary', type: 'button', text: 'Copy prompt', onclick: () => run(copyPrompt) });
    const launch = h('button', { class: 'launch', type: 'button', text: 'Research merchant', hidden: true, onclick: () => open() });
    const tokenInput = h('input', { type: 'password', placeholder: 'Paste your Entry Assistant token', 'aria-label': 'Entry Assistant token', autocomplete: 'off' });
    const tokenNote = h('p', { class: 'hint' });
    const settings = h('details', { class: 'settings' },
      h('summary', { text: 'Settings' }),
      h('div', { class: 'row', style: 'margin-top:6px' },
        tokenInput,
        h('button', { class: 'secondary', type: 'button', text: 'Save', onclick: () => saveToken() }),
        h('button', { class: 'secondary', type: 'button', text: 'Test', onclick: () => testConnection() })),
      tokenNote);
    const panel = h('aside', { class: 'panel', hidden: true, 'aria-label': 'Merchant research' },
      h('header', {},
        h('div', {}, h('strong', { text: 'Merchant research' }), subtitle),
        h('button', { class: 'icon', type: 'button', 'aria-label': 'Close panel', text: '×', onclick: () => close() })),
      body,
      h('footer', {},
        h('div', { class: 'actions' }, openBtn, copyBtn),
        status,
        h('p', { class: 'fine', text: "Only reads this page; it never clicks or changes anything on the dashboard. Claude won't send anything until you press Enter there." }),
        settings));
    root.append(h('style', { text: PANEL_CSS }), h('div', { class: 'wrap' }, launch, panel));

    let state = null;
    let siteInput = null;

    const setStatus = (text, kind = '') => { status.textContent = text; status.className = `status ${kind}`; };

    const setTokenNote = (text, kind = '') => { tokenNote.textContent = text; tokenNote.className = `hint ${kind}`; };

    // Settings stays open until a token is saved, so it's hard to miss
    function refreshTokenNote() {
      const saved = !!GM_getValue(TOKEN_KEY, '');
      settings.open = !saved;
      if (saved) setTokenNote('Token saved. Click Test to check the connection.');
      else setTokenNote('No token saved, so the HTS lookups are off. Paste the ENTRY_API_TOKEN value from your entry-assistant skill.', 'warn');
    }
    refreshTokenNote();

    async function testConnection() {
      setTokenNote('Testing…');
      try {
        const st = await entryApi('status', 15000);
        setTokenNote(`Connected to Entry Assistant (HTS ${st?.hts?.release?.name || 'release unknown'}).`, 'ok');
      } catch (e) {
        setTokenNote(e.message, 'err');
      }
    }

    function saveToken() {
      const value = cleanToken(tokenInput.value);
      if (value) GM_setValue(TOKEN_KEY, value);
      else GM_deleteValue(TOKEN_KEY);
      tokenInput.value = '';
      refreshTokenNote();
      if (value) testConnection();
      if (state) state.factsPromise = loadFacts();
    }

    // HTS lookups for every disputed item that shows an HS code
    async function loadFacts() {
      const s = state;
      s.facts = {};
      const items = s.data.items.filter(i => {
        const hs = i.fields.find(f => /^hs code$/i.test(f.label));
        return i.inDispute && (hsCodeIn(hs?.current) || hsCodeIn(hs?.claimed));
      });
      if (!items.length) return;
      items.forEach(i => { s.facts[i.line] = { loading: true }; });
      render();
      await Promise.all(items.map(async item => {
        try {
          s.facts[item.line] = { data: await gatherFacts(item) };
        } catch (e) {
          console.warn('[Dispute Researcher] HTS lookup failed', e);
          s.facts[item.line] = { error: e.message, kind: e.kind || 'server' };
        }
        if (s === state) render();
      }));
    }

    // Shown next to the copy/open result, so a failed lookup is never silent
    function lookupWarning() {
      const results = Object.values(state.facts || {});
      const failed = results.find(f => f.error);
      if (failed) return ` Heads up: the HTS lookup failed (${failed.error}) The prompt tells Claude to look the codes up itself.`;
      const partial = results.find(f => f.data?.problems.length);
      if (partial) return ` Heads up: part of the HTS lookup failed (${partial.data.problems[0]}).`;
      return '';
    }

    function attach() {
      if (!host.isConnected) document.body.append(host);
      host.dataset.theme = pageIsDark() ? 'dark' : 'light';
    }

    async function open() {
      attach();
      launch.hidden = true;
      panel.hidden = false;
      if (state && state.path === location.pathname) return;
      const path = location.pathname;
      setStatus('');
      body.replaceChildren(h('p', { class: 'muted', text: 'Reading the dispute…' }));
      const ready = await waitFor(() => lineHeaders(document.querySelector('main') || document.body).length > 0);
      if (path !== location.pathname) return;
      const data = ready && extractDispute();
      if (!data) {
        body.replaceChildren(h('p', { class: 'err', text: "Couldn't find any items on this page. Wait for it to finish loading, then close and reopen this panel." }));
        return;
      }
      const saved = GM_getValue(SITE_PREFIX + data.org.toLowerCase(), '');
      const guessed = guessWebsite(data.emailDomain);
      state = { path, data, website: saved || guessed, guessed: !saved && !!guessed, site: null, siteError: '', checking: false, matches: {}, checked: {}, facts: {}, factsPromise: null };
      for (const doc of [...data.items.flatMap(i => i.docs), ...data.orderDocs]) state.checked[doc.name] = isImage(doc.name);
      siteInput = h('input', {
        type: 'text', value: state.website, placeholder: 'https://merchant-site.com', 'aria-label': 'Merchant website',
        oninput: e => { state.website = e.target.value; },
        onkeydown: e => { if (e.key === 'Enter') checkSite(); },
      });
      subtitle.textContent = data.disputeId;
      render();
      state.factsPromise = loadFacts();
      if (state.website) checkSite();
    }

    function close() {
      panel.hidden = true;
      launch.hidden = false;
    }

    async function checkSite() {
      const s = state;
      const url = normalizeUrl(s.website);
      if (!url) {
        s.siteError = 'Enter the merchant website first.';
        render();
        return;
      }
      Object.assign(s, { site: null, siteError: '', matches: {}, checking: true });
      render();
      try {
        s.site = await inspectSite(url);
        if (s !== state) return;
        GM_setValue(SITE_PREFIX + s.data.org.toLowerCase(), s.website);
        render();
        for (const item of s.data.items.filter(i => i.inDispute)) {
          const found = await searchMerchant(s.site, queriesFor(item, s.data));
          if (s !== state) return;
          if (found) s.matches[item.line] = found;
          render();
        }
      } catch (e) {
        s.siteError = e.message;
      } finally {
        s.checking = false;
        if (s === state) render();
      }
    }

    function render() {
      const s = state;
      const d = s.data;
      const ids = productNumbers(d);
      const kv = pairs => h('dl', { class: 'kv' }, pairs.filter(([, v]) => v).map(([k, v]) => [h('dt', { text: k }), h('dd', {}, v)]));

      let siteInfo = null;
      if (s.siteError) siteInfo = h('p', { class: 'hint err', text: s.siteError });
      else if (s.checking && !s.site) siteInfo = h('p', { class: 'hint', text: 'Checking the site…' });
      else if (s.site) {
        siteInfo = h('div', {},
          kv([
            ['Platform', s.site.platforms.length ? s.site.platforms.join(', ') : s.site.generator || 'Not recognized'],
            ['Page title', s.site.title],
            ['Went to', s.site.finalUrl !== normalizeUrl(s.website) ? h('a', { href: s.site.finalUrl, target: '_blank', rel: 'noopener noreferrer', text: s.site.finalUrl }) : null],
          ]),
          s.site.blocked && h('p', { class: 'hint warn', text: 'The site may have blocked this check (bot protection). Claude may still be able to read it.' }),
          s.checking && h('p', { class: 'hint', text: "Searching the merchant's products…" }));
      }

      const docList = docs => docs.length > 0 && h('div', { class: 'sub-block' },
        h('p', { class: 'label', text: 'Attach to Claude' }),
        docs.map(doc => h('label', { class: 'doc' },
          h('input', { type: 'checkbox', checked: !!s.checked[doc.name], onchange: e => { s.checked[doc.name] = e.target.checked; render(); } }),
          h('span', { text: doc.name }),
          !isImage(doc.name) && h('span', { class: 'muted', text: '(may contain customer details)' }))));

      const matchList = line => {
        const found = s.matches[line];
        if (!found) return null;
        return h('div', { class: 'sub-block' },
          h('p', { class: 'label', text: 'Possible matches on merchant site' }),
          found.length
            ? h('ul', {}, found.map(p => h('li', {},
                h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', text: p.title }),
                p.vendor && h('span', { class: 'muted', text: ` · ${p.vendor}` }))))
            : h('p', { class: 'hint', text: 'None found. Claude will search more widely.' }));
      };

      const factsBlock = line => {
        const f = s.facts[line];
        if (!f) return null;
        let content;
        if (f.loading) content = h('p', { class: 'hint', text: 'Looking up HTS codes…' });
        else if (f.error) content = h('p', { class: 'hint warn', text: f.error });
        else {
          const rows = [
            ...f.data.codes.map(c => (c.notFound
              ? `${c.role} ${c.asked}: not found in the current HTS`
              : `${c.role} ${c.code}: ${c.meaning} · ${c.general || 'no rate listed'}${c.extra ? ` · extra: ${c.extra}` : ''}`)),
            f.data.compare?.summary && `Split: ${clean(f.data.compare.summary)}`,
            ...f.data.origins.map(o => `Made in ${o.originName || o.from}: ${o.notFound ? 'no answer' : `${o.originRate || o.general || 'no rate listed'}${o.extra ? ` + ${o.extra}` : ''}`}`),
            ...[...f.data.codes, ...f.data.origins.slice(1)].filter(c => c.chapter99?.length)
              .map(c => `Chapter 99 headings to check (${c.code}${c.originName ? `, made in ${c.originName}` : ''}): ${c.chapter99.map(x => x.code).join(', ')}`),
          ].filter(Boolean);
          content = h('div', {},
            rows.length > 0 && h('ul', {}, rows.map(t => h('li', { class: 'fact', title: t, text: t }))),
            f.data.problems.length > 0 && h('p', { class: 'hint warn', text: `Some lookups failed: ${f.data.problems.join('; ')}` }));
        }
        return content && h('div', { class: 'sub-block' }, h('p', { class: 'label', text: 'HTS facts' }), content);
      };

      // A value claim can only be checked against the price paid, which is usually on the invoice or receipt
      const allDocs = [...d.items.flatMap(i => i.docs), ...d.orderDocs];
      const valueHint = d.items.some(i => i.inDispute && claimsOf(i).some(c => /value/i.test(c.field)))
        && allDocs.some(doc => !isImage(doc.name) && !s.checked[doc.name])
        && h('p', { class: 'hint warn', text: 'Value claim: tick the invoice or receipt so Claude can check the price paid.' });

      const items = d.items.map(item => (item.inDispute
        ? h('div', { class: 'item' },
            h('div', { class: 'item-title', text: `Line ${item.line}: ${item.title}` }),
            h('table', {},
              h('thead', {}, h('tr', {}, ['Field', 'Current', 'Claimed'].map(t => h('th', { text: t })))),
              h('tbody', {}, item.fields.map(f => h('tr', {},
                h('td', { text: f.label }),
                h('td', { text: f.current }),
                h('td', { class: f.claimed ? 'claimed' : 'muted', text: f.claimed || 'unchanged' }))))),
            item.claims.length > 0 && h('div', { class: 'sub-block' },
              h('p', { class: 'label', text: "Merchant's reasons" }),
              h('ul', {}, item.claims.map(c => h('li', {},
                h('strong', { text: c.field }),
                c.status && h('span', { class: 'chip', text: c.status }),
                h('div', { class: 'reason', title: 'Click to show all', text: c.reason || 'No reason given', onclick: e => e.currentTarget.classList.toggle('open') }))))),
            factsBlock(item.line),
            docList(item.docs),
            matchList(item.line))
        : h('div', { class: 'item quiet', text: `Line ${item.line}: ${item.title}${item.note ? ` · ${item.note}` : ''}` })));

      body.replaceChildren(...[
        h('div', { class: 'section' },
          h('p', { class: 'label', text: 'Merchant' }),
          h('div', { text: d.org || 'Unknown merchant' }),
          h('div', { class: 'row', style: 'margin-top:8px' },
            siteInput,
            h('button', { class: 'secondary', type: 'button', text: 'Check site', disabled: s.checking, onclick: () => checkSite() })),
          s.guessed && h('p', { class: 'hint', text: "Guessed from the merchant's email domain. Change it if it's wrong." }),
          siteInfo),
        h('div', { class: 'section' }, h('p', { class: 'label', text: 'Items' }), valueHint, items),
        ids.length > 0 && h('div', { class: 'section' },
          h('p', { class: 'label', text: 'Product numbers found' }),
          h('div', { class: 'ids' }, ids.map(x => h('span', { class: 'chip', title: `From ${x.from}`, text: x.id })))),
        d.orderDocs.length > 0 && h('div', { class: 'section' }, h('p', { class: 'label', text: 'Order documents' }), docList(d.orderDocs)),
      ].filter(Boolean));
    }

    // Re-read the page right before building the prompt, so claims and download links are current
    function freshData() {
      const d = extractDispute();
      return d && d.disputeId === state.data.disputeId && d.items.length ? d : state.data;
    }
    const selectedDocs = d => [...d.items.flatMap(i => i.docs), ...d.orderDocs].filter(doc => state.checked[doc.name]);

    async function run(action) {
      if (!state) return;
      openBtn.disabled = copyBtn.disabled = true;
      try {
        await action();
      } catch (e) {
        setStatus(e.message, 'err');
      } finally {
        openBtn.disabled = copyBtn.disabled = false;
      }
    }

    // The prompt treats the ticked files as attached, since you'll attach them by hand
    async function waitForFacts() {
      if (!state.factsPromise) return;
      setStatus('Waiting for the HTS lookups…');
      await state.factsPromise;
    }

    async function copyPrompt() {
      await waitForFacts();
      const d = freshData();
      const names = selectedDocs(d).map(doc => doc.name);
      GM_setClipboard(buildPrompt(d, state, names), 'text');
      const warning = lookupWarning();
      setStatus((names.length ? `Prompt copied. Paste it into Claude and attach ${names.join(', ')}.` : 'Prompt copied. Paste it into Claude.') + warning, warning ? 'warn' : 'ok');
    }

    async function downloadDoc(doc) {
      const r = await gmRequest({ url: doc.url, responseType: 'blob', timeout: 60000, anonymous: true });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const blob = r.response;
      if (blob.size > MAX_FILE_BYTES) throw new Error('over 15 MB');
      const type = !blob.type || /octet-stream/i.test(blob.type) ? mimeFor(doc.name) : blob.type;
      return { name: doc.name, type, dataUrl: await blobToDataUrl(blob) };
    }

    async function handoff() {
      purgeOldHandoffs();
      await waitForFacts();
      const d = freshData();
      const docs = selectedDocs(d);
      const files = [];
      const skipped = [];
      for (const [i, doc] of docs.entries()) {
        setStatus(`Downloading ${doc.name} (${i + 1} of ${docs.length})…`);
        try {
          files.push(await downloadDoc(doc));
        } catch (e) {
          skipped.push(`${doc.name} (${e.message})`);
        }
      }
      const prompt = buildPrompt(d, state, files.map(f => f.name));
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      GM_setValue(HANDOFF_PREFIX + id, { id, createdAt: Date.now(), disputeId: d.disputeId, prompt, files });
      GM_openInTab(`https://claude.ai/new#zdr=${id}`, { active: true, insert: true, setParent: true });
      const warning = lookupWarning();
      if (skipped.length) setStatus(`Opened Claude, but couldn't attach: ${skipped.join('; ')}.${warning}`, 'warn');
      else setStatus(`Opened Claude in a new tab. Check the message there, then press Enter to send.${warning}`, warning ? 'warn' : 'ok');
    }

    return {
      show() { attach(); if (panel.hidden) launch.hidden = false; },
      hide() { launch.hidden = true; panel.hidden = true; },
      reset() { state = null; panel.hidden = true; setStatus(''); },
      keepAttached() { if (!host.isConnected && (!launch.hidden || !panel.hidden)) attach(); },
      open,
    };
  }

  function initDashboard() {
    // Shows in DevTools (F12 > Console), so it's easy to confirm the script is running at all
    console.info(`[Dispute Researcher] v${typeof GM_info !== 'undefined' ? GM_info.script.version : '?'} running on ${location.pathname}`);
    purgeOldHandoffs();
    let ui = null;
    let lastPath = null;
    // A way in from the Tampermonkey toolbar menu, in case the button doesn't show
    GM_registerMenuCommand('Open research panel', () => {
      ui = ui || createPanel();
      ui.open();
    });
    const onRoute = () => {
      ui?.keepAttached();
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      if (DISPUTE_PATH.test(location.pathname)) {
        ui = ui || createPanel();
        ui.reset();
        ui.show();
      } else {
        ui?.hide();
      }
    };
    if (window.onurlchange === null) window.addEventListener('urlchange', onRoute);
    setInterval(onRoute, 1000); // fallback for client-side navigation, and re-attaches if the app re-renders <body>
    onRoute();
  }

  /* -------------------------------------------------- claude.ai: fill the box */

  const BANNER_CSS = `
    :host { all: initial; }
    .banner { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2147483000; width: min(640px, calc(100vw - 32px)); display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; padding: 12px 14px; border-radius: 10px; background: #1c1917; color: #f5f5f4; border: 1px solid #44403c; box-shadow: 0 10px 30px rgba(0,0,0,.35); font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .msg { grid-column: 1; } .msg.ok { color: #bbf7d0; } .msg.warn { color: #fde68a; }
    .actions { grid-column: 1; display: flex; gap: 8px; } .actions:empty { display: none; }
    button { font: inherit; cursor: pointer; border-radius: 6px; padding: 5px 10px; border: 1px solid #57534e; background: transparent; color: inherit; }
    button.primary { background: #f59e0b; border-color: #f59e0b; color: #111; font-weight: 600; }
    .close { grid-column: 2; grid-row: 1 / span 2; align-self: start; border: 0; font-size: 18px; line-height: 1; padding: 2px 6px; color: #a8a29e; }
    button:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; }
  `;

  function createBanner() {
    const host = h('div', { id: 'zdr-banner' });
    const root = host.attachShadow({ mode: 'open' });
    const msg = h('div', { class: 'msg' });
    const actions = h('div', { class: 'actions' });
    root.append(h('style', { text: BANNER_CSS }), h('div', { class: 'banner', role: 'status' },
      msg, actions, h('button', { class: 'close', type: 'button', 'aria-label': 'Dismiss', text: '×', onclick: () => host.remove() })));
    document.documentElement.append(host);
    return {
      set(text, kind = '', buttons = []) { msg.textContent = text; msg.className = `msg ${kind}`; actions.replaceChildren(...buttons); },
      remove() { host.remove(); },
    };
  }

  const bannerButton = (text, onclick, primary) => h('button', { type: 'button', class: primary ? 'primary' : '', text, onclick });

  const COMPOSER_SELECTORS = ['div.ProseMirror[contenteditable="true"]', '[contenteditable="true"][aria-label]', '[contenteditable="true"]', 'textarea'];
  function findComposer() {
    for (const sel of COMPOSER_SELECTORS) {
      const el = [...document.querySelectorAll(sel)].find(e => e.getClientRects().length);
      if (el) return el;
    }
    return null;
  }

  async function insertText(el, text) {
    const probe = text.slice(0, 40);
    const has = () => (el.value ?? el.innerText ?? '').includes(probe);
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return has();
    }
    // Cursor to the end so an existing draft is kept
    const sel = getSelection();
    sel.selectAllChildren(el);
    sel.collapseToEnd();
    document.execCommand('insertText', false, text);
    await sleep(400);
    if (has()) return true;
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(800);
    return has();
  }

  function dataUrlToFile({ name, type, dataUrl }) {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type });
  }

  function attachFiles(files, composer) {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    const input = document.querySelector('input[type="file"][data-testid="file-upload"]') || document.querySelector('input[type="file"]');
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (composer) {
      composer.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    }
    return false;
  }

  async function fillFromHandoff(handoff, banner) {
    const copyAgain = bannerButton('Copy prompt again', () => GM_setClipboard(handoff.prompt, 'text'));
    if (/^\/login/.test(location.pathname)) {
      banner.set('Sign in to Claude, then start a new chat. The research prompt will be offered again.', 'warn');
      return;
    }
    banner.set(`Filling in the research prompt for ${handoff.disputeId}…`);
    const composer = await waitFor(findComposer, { timeout: 20000 });
    if (!composer) {
      GM_setClipboard(handoff.prompt, 'text');
      banner.set("Couldn't find the message box. The prompt is on your clipboard: click the message box and press Ctrl+V.", 'warn', [copyAgain]);
      return;
    }
    await sleep(600); // let the editor finish mounting
    const box = findComposer() || composer;
    const typed = await insertText(box, handoff.prompt);
    if (!typed) GM_setClipboard(handoff.prompt, 'text');

    let filesNote = '';
    if (handoff.files.length) {
      const names = handoff.files.map(f => f.name).join(', ');
      let attached = false;
      try {
        attached = attachFiles(handoff.files.map(dataUrlToFile), findComposer() || box);
      } catch { /* reported below */ }
      filesNote = attached
        ? ` Added ${handoff.files.length} file(s) (${names}); check they show up by the message box.`
        : ` Couldn't attach the files. Attach these from the dispute page: ${names}.`;
    }
    GM_deleteValue(HANDOFF_PREFIX + handoff.id);

    const lead = typed
      ? 'The research prompt is in the message box.'
      : "Couldn't type into the message box, so the prompt is on your clipboard. Click the box and press Ctrl+V (skip this if it already shows as pasted text).";
    banner.set(`${lead}${filesNote} Nothing has been sent: review it, then press Enter.`, typed ? 'ok' : 'warn', [copyAgain]);
  }

  function initClaude() {
    purgeOldHandoffs();
    const id = (INITIAL_HASH.match(/zdr=([a-z0-9]+)/i) || [])[1];
    if (id) history.replaceState(history.state, '', location.pathname + location.search);
    let handoff = id ? GM_getValue(HANDOFF_PREFIX + id, null) : null;
    const auto = !!handoff;
    // Signing in drops the #zdr marker, so offer the newest waiting prompt instead of filling it unasked
    if (!handoff) handoff = listHandoffs().sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    if (!handoff) return;

    const banner = createBanner();
    const fill = () => fillFromHandoff(handoff, banner);
    if (auto) {
      fill();
      return;
    }
    banner.set(`A research prompt for ${handoff.disputeId} is waiting.`, '', [
      bannerButton('Fill message box', fill, true),
      bannerButton('Discard', () => { GM_deleteValue(HANDOFF_PREFIX + handoff.id); banner.remove(); }),
    ]);
  }

  onReady(() => {
    if (location.host === DASHBOARD_HOST) initDashboard();
    else if (location.host === 'claude.ai') initClaude();
  });
})();
