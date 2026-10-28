// ==UserScript==
// @name         Zonos Dispute Researcher
// @namespace    zonos-brokerage
// @version      7.6.0
// @description  Tools for the Zonos broker portal: a Tools panel on every page (Classify, Quote, Analytics, research prompts, Entry Assistant, Prev / Next through your queue), an optional rebuilt work queue (search everything, sorting, filters, summaries, saved views, bulk actions), and easier-to-read order pages. Optional, per person under Settings (the cog in Tools): Entry Assistant token, Notion case tracking, Claude Code cloud research, shared answers. No keys are built in. Changes the dashboard only through bulk actions you confirm.
// @homepageURL  https://github.com/kars3n-zonos/zonos-dispute-researcher
// @supportURL   https://github.com/kars3n-zonos/zonos-dispute-researcher/issues
// @updateURL    https://raw.githubusercontent.com/kars3n-zonos/zonos-dispute-researcher/main/zonos-dispute-researcher.user.js
// @downloadURL  https://raw.githubusercontent.com/kars3n-zonos/zonos-dispute-researcher/main/zonos-dispute-researcher.user.js
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
// @grant        unsafeWindow
// @connect      prod-zonos-brokerage.s3.us-east-2.amazonaws.com
// @connect      entry.kars3n.com
// @connect      api.notion.com
// @connect      api.anthropic.com
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
  const PANEL_WIDTH_KEY = 'zdr:panelWidth';
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

  /* ------------------------------------------------------------------ setup */

  // Nothing personal is built into this file, so it can be shared as is. Each person enters their own keys
  // and ids under Settings (the cog in Tools); they're kept in Tampermonkey storage on that computer. Every part is
  // optional: what isn't set up is left out of the panel instead of failing.
  const CONFIG_KEY = 'zt:config';
  const CONFIG_DEFAULTS = {
    entryUrl: 'https://entry.kars3n.com',   // the Entry Assistant site (each person uses their own token)
    projectsDs: '', tasksDs: '', notionUser: '',   // Notion case tracking
    routineId: '', routineToken: '',        // Claude Code cloud research
    notesUrl: '',                           // shared answers server
  };
  const cfg = () => ({ ...CONFIG_DEFAULTS, ...GM_getValue(CONFIG_KEY, {}) });
  const setCfg = patch => GM_setValue(CONFIG_KEY, { ...GM_getValue(CONFIG_KEY, {}), ...patch });
  const baseUrl = u => clean(u).replace(/\/+$/, '').replace(/\/api\/v1$/, '');

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

  /* ------------------------------------------- memory: what's been researched */

  // One record per dispute on this computer: when each line went to Claude. (Claude's answers are kept
  // with the shared answers.) Used by the dashboard and claude.ai, since Tampermonkey storage is the same on both.
  const DISPUTE_PREFIX = 'zdr:dispute:';
  const DISPUTE_TTL_MS = 120 * 24 * 60 * 60 * 1000;

  const loadRecord = id => GM_getValue(DISPUTE_PREFIX + id, null) || { id, lines: {}, answers: [], updatedAt: 0 };

  function saveRecord(rec) {
    rec.updatedAt = Date.now();
    GM_setValue(DISPUTE_PREFIX + rec.id, rec);
  }

  // Research records and notes both go after 120 days without changes
  function purgeOldRecords() {
    for (const key of GM_listValues()) {
      if (!key.startsWith(DISPUTE_PREFIX) && !key.startsWith('zdr:notes:')) continue;
      const rec = GM_getValue(key, null);
      if (!rec || Date.now() - (rec.updatedAt || 0) > DISPUTE_TTL_MS) GM_deleteValue(key);
    }
  }

  function markSent(id, items) {
    const rec = loadRecord(id);
    for (const item of items) {
      rec.lines[item.line] = { ...rec.lines[item.line], title: item.title, claims: claimsOf(item).map(c => c.field), sentAt: Date.now() };
    }
    saveRecord(rec);
  }

  // The lookahead skips the prompt's own template sentence ("substantiated / somewhat substantiated / …");
  // Markdown emphasis around the verdict ("is **not substantiated**") is allowed
  const VERDICT_RE = /the merchant['’]s claim is[\s*_]*(not substantiated|somewhat substantiated|substantiated)\b(?![*_]*\s*\/)[^\n]*/i;

  // Splits Claude's answer at its "Line N" headings and pulls out each line's verdict sentence.
  // An answer without headings covers every line it was asked about.
  function parseVerdicts(text, lines) {
    const found = {};
    const marks = [...text.matchAll(/^[ \t]*#{0,4}[ \t]*\**[ \t]*Line\s+(\d+)\b/gim)];
    marks.forEach((m, i) => {
      const part = text.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : undefined);
      const v = part.match(VERDICT_RE);
      if (v) found[+m[1]] = { verdict: v[1].toLowerCase(), sentence: plainText(v[0]) };
    });
    if (!Object.keys(found).length) {
      const v = text.match(VERDICT_RE);
      if (v) for (const line of lines) found[line] = { verdict: v[1].toLowerCase(), sentence: plainText(v[0]) };
    }
    return found;
  }

  // A Markdown sentence as plain text: links become their text, emphasis and code marks go
  const plainText = md => clean(md.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|~~|`/g, '').replace(/(^|[^\w*])\*(?=\S)([^*]+?)\*(?!\w)/g, '$1$2').replace(/\*+$/, ''));

  // Claude's answer goes in with the dispute's notes (as Markdown), so it's shared with everyone
  function recordAnswer(id, lines, text) {
    addAnswer(id, lines, text);
    return parseVerdicts(text, lines);
  }

  const shortDate = ts => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const capitalized = s => s[0].toUpperCase() + s.slice(1);

  // `l` is this computer's record of the line (when it went to Claude), `la` the newest shared answer for it
  function lineStatus(l, la) {
    const by = la && la.answer.mine === false ? ` · ${la.answer.author}` : '';
    if (la?.verdict) {
      const kind = la.verdict === 'substantiated' ? 'v-yes' : la.verdict === 'somewhat substantiated' ? 'v-some' : 'v-no';
      return { text: `${capitalized(la.verdict)} · ${shortDate(la.answer.createdAt)}${by}`, kind };
    }
    if (la) return { text: `Answer saved ${shortDate(la.answer.createdAt)}${by}, no verdict found`, kind: '' };
    if (l?.sentAt) return { text: `Sent to Claude ${shortDate(l.sentAt)}`, kind: '' };
    return { text: 'Not researched yet', kind: '' };
  }

  /* --------------------------------------------- shared answers: the notes server */

  // Claude's saved answers, per dispute, kept in Tampermonkey storage on this computer and shared through
  // the notes server, where each is a note with kind 'answer'. (The panel used to have its own notes too;
  // the dashboard has a notes section now, so those are no longer shown or written.)
  const NOTES_PREFIX = 'zdr:notes:';
  const AUTHOR_KEY = 'zdr:author';
  // Anyone signed in to this dashboard joins the notes server on their own: the script shows the server
  // the dashboard's sign-in token (Clerk keeps a 60-second one in the __session cookie), the server checks
  // it and the zonos.com email, and hands back a notes key for 30 days, which is renewed while you keep
  // using the dashboard. A key pasted under Settings is used instead.
  const notesBase = () => { const u = baseUrl(cfg().notesUrl); return u ? `${u}/api/v1` : ''; };   // set under Setup
  const NOTES_KEY = 'zdr:notesKey'; // pasted by hand
  const NOTES_JOIN = 'zdr:notesJoin'; // { key, name, expiresAt } from joining, plus { failedAt, error } after a failed try
  const SESSION_ISSUER = 'https://clerk.zonos.com';
  const JOIN_RETRY_MS = 2 * 60 * 1000;
  const JOIN_RENEW_MS = 3 * 24 * 60 * 60 * 1000;
  const manualNotesKey = () => GM_getValue(NOTES_KEY, '');
  const joinRecord = () => GM_getValue(NOTES_JOIN, null) || {};
  const sharedNotesOn = () => !!notesBase() && (!!(manualNotesKey() || joinRecord().key) || location.host === DASHBOARD_HOST);

  // An answer is shown unless it's waiting to be deleted on the server. Answers without `mine: false`
  // are your own. Old plain notes still sync with the rest but aren't shown.
  const isAnswer = n => n.kind === 'answer';
  const visibleAnswers = pad => pad.notes.filter(n => n.pending !== 'delete' && isAnswer(n)).sort((a, b) => b.createdAt - a.createdAt);
  const loadNotes = id => GM_getValue(NOTES_PREFIX + id, null) || { id, notes: [], updatedAt: 0 };
  const newNoteId = () => `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // The newest answer covering a line, from anyone, with its verdict for that line if it has one
  function lineAnswer(pad, line) {
    for (const answer of visibleAnswers(pad)) {
      const v = parseVerdicts(answer.text, answer.lines || [])[line];
      if (v || (answer.lines || []).includes(line)) return { answer, verdict: v?.verdict, sentence: v?.sentence };
    }
    return null;
  }

  // Only the latest answer is kept on this computer, so Tampermonkey storage stays small: older answers are
  // dropped here (your own already-shared ones are removed from the notes server too), and old plain notes go.
  function pruneAnswers(pad) {
    const [latest] = pad.notes.filter(n => isAnswer(n) && n.pending !== 'delete').sort((a, b) => b.createdAt - a.createdAt);
    pad.notes = pad.notes.flatMap(n => {
      if (n === latest || n.pending === 'delete') return [n];
      if (isAnswer(n) && n.synced && n.mine !== false) return [{ id: n.id, kind: n.kind, createdAt: n.createdAt, synced: true, pending: 'delete' }];
      return [];
    });
  }

  function changeNotes(id, change) {
    const pad = loadNotes(id);
    change(pad);
    pruneAnswers(pad);
    pad.updatedAt = Date.now();
    GM_setValue(NOTES_PREFIX + id, pad);
  }
  // Answers saved before this rule are trimmed the same way, once
  function trimStoredAnswers() {
    if (GM_getValue('zt:answersTrimmed', false)) return;
    for (const k of GM_listValues()) if (k.startsWith(NOTES_PREFIX)) changeNotes(k.slice(NOTES_PREFIX.length), () => {});
    GM_setValue('zt:answersTrimmed', true);
  }

  // Each change is saved here first and marked `pending` until the server confirms it. An answer is cut to
  // what the server takes: 30,000 characters in a request under 64 KB. Saving the same answer twice (a
  // second click on Save) keeps one copy.
  const addAnswer = (id, lines, text, createdAt = Date.now()) => changeNotes(id, pad => {
    let md = text.trim().slice(0, 30000);
    while (new TextEncoder().encode(JSON.stringify(md)).length > 60000) md = md.slice(0, Math.floor(md.length * 0.9));
    if (visibleAnswers(pad).some(a => a.text === md && String(a.lines) === String(lines))) return;
    pad.notes.push({ id: newNoteId(), kind: 'answer', lines: [...lines], author: GM_getValue(AUTHOR_KEY, '') || 'Me', text: md, createdAt, updatedAt: Date.now(), pending: 'add' });
  });
  // Answers saved before they were shared sat in this computer's record of the dispute; share them now
  function shareOldAnswers(id) {
    const rec = loadRecord(id);
    if (!rec.answers?.length) return;
    for (const a of rec.answers) addAnswer(id, a.lines || [], a.text, a.savedAt);
    rec.answers = [];
    saveRecord(rec);
  }
  const deleteNote = (id, noteId) => changeNotes(id, pad => {
    const note = pad.notes.find(n => n.id === noteId);
    if (note?.synced) note.pending = 'delete';
    else pad.notes = pad.notes.filter(n => n.id !== noteId);
  });

  const jwtClaims = token => {
    try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
  };

  // The dashboard's current sign-in token. Clerk renews the cookie about every 50 seconds while the page
  // is open, so if the one there is about to run out, wait a little for the next.
  async function dashboardSignIn() {
    if (location.host !== DASHBOARD_HOST) return null;
    const end = Date.now() + 15000;
    for (;;) {
      const best = document.cookie.split(';').map(c => c.trim())
        .filter(c => /^__session(_[^=]*)?=/.test(c))
        .map(c => ({ token: c.slice(c.indexOf('=') + 1), claims: jwtClaims(c.slice(c.indexOf('=') + 1)) }))
        .filter(t => t.claims?.iss === SESSION_ISSUER)
        .sort((a, b) => b.claims.exp - a.claims.exp)[0];
      if (best && best.claims.exp * 1000 > Date.now() + 5000) return best.token;
      if (Date.now() > end) return null;
      await sleep(500);
    }
  }

  // Trades the dashboard sign-in for a notes key. A failure is remembered for two minutes, in every tab,
  // so a problem doesn't turn into a request every 15 seconds.
  let joining = null;
  function joinNotes() {
    if (!joining) joining = runJoin().finally(() => { joining = null; });
    return joining;
  }
  async function runJoin() {
    const fail = (kind, message) => {
      GM_setValue(NOTES_JOIN, { ...joinRecord(), failedAt: Date.now(), error: message });
      return apiError(kind, message);
    };
    const token = await dashboardSignIn();
    if (!token) throw fail('join', "Couldn't join shared answers: no current dashboard sign-in found. Reload the page.");
    let r;
    try {
      r = await gmRequest({
        method: 'POST', url: `${notesBase()}/register`, timeout: 15000,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        data: JSON.stringify({ token, name: GM_getValue(AUTHOR_KEY, '') || undefined }),
      });
    } catch (e) {
      throw fail('unreachable', /too long/.test(e.message) ? 'The notes server took too long to respond.' : "Couldn't reach the notes server.");
    }
    let json = null;
    try { json = JSON.parse(r.responseText); } catch { /* handled below */ }
    if (r.status !== 200 || !json?.key) throw fail('join', `Couldn't join shared answers: ${json?.error || `the notes server answered ${r.status}.`}`);
    GM_setValue(NOTES_JOIN, { key: json.key, name: json.name, expiresAt: json.expiresAt });
    if (!GM_getValue(AUTHOR_KEY, '')) GM_setValue(AUTHOR_KEY, json.name);
    return json.key;
  }

  // A pasted key wins. Otherwise use the joined key, joining first if there's none and renewing it a few
  // days before it runs out (keeping the old one if renewing fails).
  async function notesKey() {
    const manual = manualNotesKey();
    if (manual) return manual;
    const rec = joinRecord();
    const usable = rec.key && !(rec.expiresAt < Date.now());
    const due = !rec.key || rec.expiresAt - Date.now() < JOIN_RENEW_MS;
    const waiting = rec.failedAt && Date.now() - rec.failedAt < JOIN_RETRY_MS;
    if (due && !waiting && location.host === DASHBOARD_HOST) {
      try { return await joinNotes(); } catch (e) { if (!usable) throw e; }
    }
    if (usable) return rec.key;
    if (rec.error) throw apiError('join', rec.error);
    throw apiError('no-token', 'Open a dispute on the dashboard to join shared answers.');
  }

  async function notesApi(method, path, body, retried = false) {
    const key = await notesKey();
    let r;
    try {
      r = await gmRequest({
        method, url: `${notesBase()}${path}`, timeout: 15000,
        headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        data: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw apiError('unreachable', /too long/.test(e.message) ? 'The notes server took too long to respond.' : "Couldn't reach the notes server.");
    }
    let json = null;
    try { json = JSON.parse(r.responseText); } catch { /* handled by status below */ }
    if (r.status === 401) {
      if (manualNotesKey()) throw apiError('bad-token', 'The notes server rejected your key. Check it under Settings (the cog in Tools).');
      // A joined key that ran out or was dropped: join again once (unless another tab already has)
      if (joinRecord().key === key) GM_setValue(NOTES_JOIN, {});
      if (!retried && location.host === DASHBOARD_HOST) return notesApi(method, path, body, true);
      throw apiError('bad-token', 'The notes server no longer accepts this sign-in. Reload the dashboard.');
    }
    if (r.status < 200 || r.status >= 300) throw Object.assign(apiError('server', json?.error || `The notes server answered ${r.status}.`), { status: r.status });
    return json;
  }

  // Sends this computer's pending changes, then takes the server's list as the truth, keeping
  // anything still pending on top. Stops at the first network or key problem and tries again later.
  const syncing = new Map();
  function syncNotes(id) {
    if (!sharedNotesOn()) return Promise.resolve({ shared: false });
    if (!syncing.has(id)) syncing.set(id, runSync(id).finally(() => syncing.delete(id)));
    return syncing.get(id);
  }

  async function runSync(id) {
    const base = `/disputes/${encodeURIComponent(id)}/notes`;
    try {
      const toSend = loadNotes(id).notes.filter(n => n.pending || (!n.synced && n.mine !== false && !n.rejected));
      for (const note of toSend) {
        try {
          if (note.pending === 'delete') await notesApi('DELETE', `${base}/${note.id}`);
          else if (note.pending === 'edit') await notesApi('PATCH', `${base}/${note.id}`, { text: note.text });
          else await notesApi('POST', base, { id: note.id, text: note.text, ...(isAnswer(note) ? { kind: 'answer', lines: note.lines, createdAt: note.createdAt } : {}) });
          changeNotes(id, pad => {
            if (note.pending === 'delete') {
              pad.notes = pad.notes.filter(n => n.id !== note.id);
              return;
            }
            // If it was edited again while this request was out, the newer text still has to go up
            const n = pad.notes.find(x => x.id === note.id);
            if (n) Object.assign(n, { synced: true, pending: n.text === note.text ? null : 'edit' });
          });
        } catch (e) {
          if (e.kind !== 'server' || e.status >= 500 || e.status === 429) throw e; // temporary: try again later
          changeNotes(id, pad => {
            const n = pad.notes.find(x => x.id === note.id);
            if (!n) return;
            if (e.status === 409) n.id = newNoteId(); // id taken: retry under a new one
            else if (e.status === 404) pad.notes = pad.notes.filter(x => x.id !== note.id); // already gone on the server
            else Object.assign(n, { pending: null, rejected: e.message }); // refused for good, e.g. too long
          });
        }
      }
      const { notes: server } = await notesApi('GET', base);
      changeNotes(id, pad => {
        const waiting = pad.notes.filter(n => n.pending);
        const onServer = new Set(server.map(n => n.id));
        pad.notes = [
          ...server.map(n => {
            const local = waiting.find(w => w.id === n.id);
            return local ? { ...n, text: local.text, pending: local.pending, synced: true } : { ...n, synced: true };
          }),
          ...waiting.filter(w => !onServer.has(w.id) && w.pending !== 'delete'),
          ...pad.notes.filter(n => n.rejected && !onServer.has(n.id)),
        ].sort((a, b) => a.createdAt - b.createdAt);
        pad.syncedAt = Date.now();
        pad.syncError = '';
      });
      return { shared: true, ok: true };
    } catch (e) {
      changeNotes(id, pad => { pad.syncError = e.message; });
      return { shared: true, ok: false, error: e.message };
    }
  }

  /* ------------------------------------------------ Markdown: saving and showing */

  // Claude's answers are saved as Markdown. On claude.ai the rendered reply is turned back into Markdown;
  // in the panel Markdown is drawn with h(), so nothing in an answer can inject markup.
  const SKIP_TAGS = /^(BUTTON|SVG|SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|SELECT|IMG|PICTURE|VIDEO|AUDIO|CANVAS|IFRAME)$/;
  const BLOCK_TAGS = /^(P|DIV|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|FIGURE|DETAILS|SUMMARY|H[1-6]|UL|OL|LI|PRE|BLOCKQUOTE|TABLE|THEAD|TBODY|TFOOT|TR|HR|DL|DT|DD)$/;

  function htmlToMarkdown(root) {
    const wrap = (mark, s) => {
      const t = s.trim();
      return t ? `${s.match(/^\s*/)[0]}${mark}${t}${mark}${s.match(/\s*$/)[0]}` : s;
    };
    const inline = n => {
      if (n.nodeType === Node.TEXT_NODE) return n.nodeValue.replace(/\s+/g, ' ');
      if (n.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.test(n.tagName.toUpperCase())) return '';
      const kids = () => [...n.childNodes].map(inline).join('');
      switch (n.tagName) {
        case 'STRONG': case 'B': return wrap('**', kids());
        case 'EM': case 'I': return wrap('*', kids());
        case 'DEL': case 'S': return wrap('~~', kids());
        case 'CODE': return n.textContent ? `\`${n.textContent}\`` : '';
        case 'BR': return '\n';
        case 'A': {
          const text = kids().trim();
          const href = n.getAttribute('href') || '';
          if (!/^https?:\/\//i.test(href) || !text) return text;
          return text === href ? href : `[${text}](${href})`;
        }
        default: return kids();
      }
    };
    // A node's children as Markdown blocks; runs of inline content between blocks become paragraphs
    const blocks = node => {
      const out = [];
      let run = '';
      const end = () => {
        const t = run.replace(/[ \t]*\n[ \t]*/g, '\n').trim();
        if (t) out.push(t);
        run = '';
      };
      for (const n of node.childNodes) {
        if (n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.test(n.tagName)) {
          end();
          const b = block(n);
          if (b) out.push(b);
        } else run += inline(n);
      }
      end();
      return out;
    };
    const block = n => {
      const tag = n.tagName;
      if (/^H[1-6]$/.test(tag)) return `${'#'.repeat(+tag[1])} ${inline(n).trim()}`;
      if (tag === 'HR') return '---';
      if (tag === 'PRE') {
        // claude.ai puts a language label and a copy button inside the block; only the code counts
        const code = n.querySelector('code');
        const lang = (code?.className.match(/language-([\w-]+)/) || [])[1] || '';
        return `\`\`\`${lang}\n${(code || n).textContent.replace(/\n+$/, '')}\n\`\`\``;
      }
      if (tag === 'BLOCKQUOTE') return blocks(n).join('\n\n').split('\n').map(l => `> ${l}`.trimEnd()).join('\n');
      if (tag === 'UL' || tag === 'OL') {
        let i = Number(n.getAttribute('start')) || 1;
        return [...n.children].filter(li => li.tagName === 'LI').map(li => {
          const marker = tag === 'OL' ? `${i++}. ` : '- ';
          return marker + blocks(li).join('\n').split('\n').map((l, k) => (k ? ' '.repeat(marker.length) + l : l)).join('\n');
        }).join('\n');
      }
      if (tag === 'TABLE') {
        const rows = [...n.querySelectorAll('tr')].map(tr => [...tr.children].map(c => inline(c).trim().replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')));
        if (!rows.length) return '';
        const width = Math.max(...rows.map(r => r.length));
        const row = r => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
        return [row(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(row)].join('\n');
      }
      return blocks(n).join('\n\n');
    };
    return blocks(root).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Pasting a selection copied from claude.ai brings its formatting as HTML; keep that as Markdown.
  // Text from Claude's own copy button is Markdown already and goes in as it is.
  function pasteAsMarkdown(e) {
    const html = e.clipboardData?.getData('text/html');
    const plain = e.clipboardData?.getData('text/plain') || '';
    if (!html || /^\s*(#{1,6}\s|[-*]\s|\d+\.\s)|\*\*|\]\(https?:/m.test(plain)) return;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (!doc.body.querySelector('h1,h2,h3,h4,h5,h6,strong,b,em,li,table,a,pre,blockquote')) return;
    const md = htmlToMarkdown(doc.body);
    if (!md) return;
    e.preventDefault();
    const box = e.currentTarget;
    box.setRangeText(md, box.selectionStart, box.selectionEnd, 'end');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const MD_INLINE = /`([^`\n]+)`|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"]+)/g;
  function mdInline(text) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(MD_INLINE)) {
      const [all, code, bold, bold2, strike, em, em2, linkText, linkUrl, bare] = m;
      out.push(text.slice(last, m.index));
      if (code != null) out.push(h('code', { text: code }));
      else if (bold != null || bold2 != null) out.push(h('strong', {}, mdInline(bold ?? bold2)));
      else if (strike != null) out.push(h('s', {}, mdInline(strike)));
      else if (em != null || em2 != null) out.push(h('em', {}, mdInline(em ?? em2)));
      else if (linkUrl) out.push(h('a', { href: linkUrl, target: '_blank', rel: 'noopener noreferrer' }, mdInline(linkText)));
      else {
        const url = bare.replace(/[).,;:!?\]'}*_]+$/, '');
        out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: url }), bare.slice(url.length));
      }
      last = m.index + all.length;
    }
    out.push(text.slice(last));
    return out;
  }
  const mdLines = text => text.split('\n').flatMap((l, k) => (k ? [h('br'), ...mdInline(l)] : mdInline(l)));

  // Nested lists from list items with their indentation. A switch between bullets and numbers starts a
  // new list, so a bulleted list followed by a numbered one stays two lists.
  function mdList(items) {
    const root = { children: [] };
    const stack = [{ depth: -1, node: root }];
    for (const it of items) {
      while (it.depth <= stack[stack.length - 1].depth) stack.pop();
      const node = { it, children: [] };
      stack[stack.length - 1].node.children.push(node);
      stack.push({ depth: it.depth, node });
    }
    const draw = nodes => {
      const runs = [];
      for (const n of nodes) {
        if (!runs.length || runs[runs.length - 1][0].it.ordered !== n.it.ordered) runs.push([]);
        runs[runs.length - 1].push(n);
      }
      return runs.map(run => h(run[0].it.ordered ? 'ol' : 'ul', run[0].it.ordered && run[0].it.start !== 1 ? { start: String(run[0].it.start) } : {},
        run.map(n => h('li', {}, mdLines(n.it.text), n.children.length > 0 && draw(n.children)))));
    };
    return draw(root.children);
  }

  // Headings, paragraphs, lists, quotes, code blocks, tables and rules; single line breaks are kept
  function renderMarkdown(md) {
    const lines = md.replace(/\r\n?/g, '\n').split('\n');
    const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
    const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
    const isTableRule = l => l != null && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
    const cells = l => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
    const startsBlock = (l, next) => /^\s*(#{1,6}\s|```|>)/.test(l) || RULE.test(l) || LIST.test(l) || (l.includes('|') && isTableRule(next));
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (!line.trim()) {
        i++;
      } else if (/^\s*```/.test(line)) {
        const code = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
        i++;
        out.push(h('pre', {}, h('code', { text: code.join('\n') })));
      } else if ((m = line.match(/^\s*(#{1,6})\s+(.*?)[\s#]*$/))) {
        out.push(h(`h${Math.min(m[1].length + 2, 6)}`, {}, mdInline(m[2])));
        i++;
      } else if (RULE.test(line)) {
        out.push(h('hr'));
        i++;
      } else if (/^\s*>/.test(line)) {
        const quote = [];
        for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
        out.push(h('blockquote', {}, renderMarkdown(quote.join('\n'))));
      } else if (line.includes('|') && isTableRule(lines[i + 1])) {
        const head = cells(line);
        const rows = [];
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
        out.push(h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, head.map(c => h('th', {}, mdInline(c))))),
          h('tbody', {}, rows.map(r => h('tr', {}, head.map((_, k) => h('td', {}, mdInline(r[k] || '')))))))));
      } else if (LIST.test(line)) {
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          if ((m = l.match(LIST))) {
            items.push({ depth: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, text: m[3] });
            i++;
          } else if (l.trim() && /^\s/.test(l) && items.length) {
            items[items.length - 1].text += `\n${l.trim()}`; // the item's text goes on
            i++;
          } else if (!l.trim() && LIST.test(lines[i + 1] || '')) {
            i++; // a blank line between items
          } else break;
        }
        out.push(...mdList(items));
      } else {
        const para = [];
        for (; i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i], lines[i + 1])); i++) para.push(lines[i].trim());
        out.push(h('p', {}, mdLines(para.join('\n'))));
      }
    }
    return out;
  }

  // The part of a saved answer about one line (the whole answer if it has no "Line N" headings)
  function answerPart(text, line) {
    const marks = [...text.matchAll(/^[ \t]*#{0,4}[ \t]*\**[ \t]*Line\s+(\d+)\b/gim)];
    const i = marks.findIndex(m => +m[1] === line);
    if (i < 0) return marks.length ? '' : text;
    return text.slice(marks[i].index, i + 1 < marks.length ? marks[i + 1].index : undefined).trim();
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

  // Labels beside the line title that are statuses, not claim names
  const STATUS_CHIP = /^(\d+\s+decisions?\s+pending|no changes claimed|all decided)$/i;
  const STATUS_TEXT = /\b(denied|accepted|pending|needs review|under review|changes requested)\b/i;

  // Each claim card is a label (HS code, Weight, Tariff line…), then a status, then the merchant's reason.
  // Labels come from the table rows plus the claim labels beside the line title, since some claims
  // (Weight, Quantity, Tariff line) have no row of their own. Broker notes and "Decided by" lines are
  // skipped: they're internal and name staff.
  function parseClaims(box, labels) {
    const header = findLeaf(box, /^claims\s*&\s*broker decision$/i);
    if (!header) return [];
    const known = new Set(labels.map(l => l.toLowerCase()));
    const claims = [];
    const cardLeaves = leaves(header.parentElement).filter(el => el !== header && !el.closest('button'));
    cardLeaves.forEach((el, i) => {
      const text = clean(el.textContent);
      const next = cardLeaves[i + 1];
      const startsCard = el.tagName === 'SPAN'
        && (known.has(text.toLowerCase()) || (next && next.tagName !== 'P' && STATUS_TEXT.test(clean(next.textContent))));
      if (startsCard) {
        claims.push({ field: text, status: '', reason: '' });
        return;
      }
      const claim = claims[claims.length - 1];
      if (!claim) return;
      if (el.tagName === 'P') {
        if (!claim.reason && !/^(decided by|note:)/i.test(text)) claim.reason = text;
      } else if (!claim.status) {
        claim.status = text;
      }
    });
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
      const chips = trigger ? leaves(trigger).filter(e => e !== header).map(e => clean(e.textContent)).filter(t => !STATUS_CHIP.test(t)) : [];
      return {
        line: +line,
        title,
        inDispute: fields.length > 0,
        note: trigger ? clean(trigger.textContent).replace(clean(header.textContent), '').trim() : '',
        fields,
        claims: parseClaims(box, [...fields.map(f => f.label), ...chips]),
        docs: docLinks.filter(a => box.contains(a)).map(docOf),
      };
    });

    const email = parties.Email || '';
    // An international postal tracking number ends in the posting country's code (UPU S10: "LK286208102AU");
    // only that country goes into the prompt, never the number
    const postedCode = (/^[A-Z]{2}\d{9}([A-Z]{2})$/.exec((parties['Tracking #'] || '').toUpperCase()) || [])[1];
    return {
      disputeId: location.pathname.split('/').filter(Boolean).pop(),
      org: parties.Organization || '',
      emailDomain: (email.split('@')[1] || '').toLowerCase(),
      website: /^(https?:\/\/)?[\w-]+(\.[\w-]+)+/i.test(parties.Website || '') ? parties.Website : '',
      ordered: /\d/.test(parties.Ordered || '') ? parties.Ordered : '',
      order: /^order_/i.test(parties['Original order'] || '') ? parties['Original order'] : '',
      postedIn: postedCode ? regionName(postedCode) : '',
      items,
      orderDocs: docLinks.filter(a => !boxes.some(b => b.contains(a))).map(docOf),
    };
  }

  const regionName = code => {
    try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code; } catch { return code; }
  };

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

  // Response headers as { name: value }, with repeated headers joined by ", "
  function headerMap(raw) {
    const headers = {};
    for (const line of (raw || '').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const name = line.slice(0, i).trim().toLowerCase();
      const value = line.slice(i + 1).trim();
      headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
    }
    return headers;
  }

  async function inspectSite(url) {
    const r = await gmRequest({ url, headers: { Accept: 'text/html,application/xhtml+xml' } });
    const headers = headerMap(r.responseHeaders);
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
      .filter(w => !/^(screen|shot|screenshot|image|img|temp|photo|pic|scan|receipt|invoice|order|purchase|proforma|commercial|packing|list|bill|lading|certificate|declaration|statement|quote|quotation|copy|final|edited|file|untitled|sku|mpn|upc|ean|part|model|item)$/i.test(w))
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
      // System identifiers quoted in a claim ("232_RU_ALUM_DERIV_JUL24_CERTIFICATION", "item_AU_2053") aren't product numbers
      item.claims.forEach(c => idsIn((c.reason || '').replace(/\b\w*_\w+\b/g, ' ')).forEach(id => add(id, "the merchant's reason")));
    }
    for (const doc of [...d.items.flatMap(i => i.docs), ...d.orderDocs]) {
      idsIn(doc.name.replace(/\.[a-z0-9]{2,5}$/i, '')).forEach(id => add(id, `the file name ${doc.name}`));
    }
    return [...found.values()].slice(0, 8);
  }

  // The searches Claude must run for a line, every time, and log in its reply: each product number in
  // quotes, the product name (which also covers all-digit model numbers the number finder skips), its price,
  // its datasheet, the merchant's description if it differs, and the merchant's own site
  function requiredSearches(item, website) {
    const desc = item.fields.find(f => /^description$/i.test(f.label));
    const ids = productNumbers({ items: [item], orderDocs: [] }).map(x => x.id).slice(0, 4);
    // A listing title is often a marketing sentence, which searches badly: cut it at the first comma or
    // period, and if it's still long, use the shortest description that still names the item
    const wordCount = t => clean(t).split(' ').filter(Boolean).length;
    const cut = t => clean(t).split(/[,.;:!?(]| [-–] /)[0].trim();
    const titleName = cut(item.title);
    const name = (titleName && wordCount(titleName) <= 8 ? titleName : null)
      || [desc?.current, desc?.claimed].map(cut).filter(t => wordCount(t) >= 2 && wordCount(t) <= 8).sort((a, b) => a.length - b.length)[0]
      || titleName.split(' ').slice(0, 8).join(' ');
    const key = ids[0] ? `"${ids[0]}"` : name;
    const host = website && new URL(website).hostname.replace(/^www\./, '');
    const queries = [
      ...ids.map(id => `"${id}"`),
      name,
      ids[0] && !name.toLowerCase().includes(ids[0].toLowerCase()) && `${name} ${ids[0]}`,
      `${key} price`,
      `${key} datasheet OR specifications`,
      cut(desc?.claimed) && cut(desc.claimed).toLowerCase() !== name.toLowerCase() && cut(desc.claimed).slice(0, 80),
      host && `site:${host} ${ids[0] || name}`,
    ].filter(q => q && q.replace(/"/g, '').trim().length >= 3);
    return [...new Map(queries.map(q => [q.toLowerCase(), q])).values()].slice(0, 8);
  }

  // Product numbers first, then names from photo filenames, then the customs descriptions
  function queriesFor(item, dispute) {
    const desc = item.fields.find(f => /^description$/i.test(f.label));
    const photos = [...item.docs, ...dispute.orderDocs].filter(d => isImage(d.name));
    const fromFiles = photos.map(d => fileNameQuery(d.name, dispute.org));
    // This line's own numbers only, so another line's part number doesn't end up in its searches
    const ids = productNumbers({ items: [item], orderDocs: dispute.orderDocs }).map(x => x.id);
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
  // Each person's own token, saved under Setup.

  const entryBase = () => baseUrl(cfg().entryUrl) || CONFIG_DEFAULTS.entryUrl;
  const TOKEN_KEY = 'zdr:entryToken';

  const entryToken = () => GM_getValue(TOKEN_KEY, '');

  async function entryApi(path, timeout = 30000) {
    const token = entryToken();
    if (!token) throw apiError('no-token', 'No Entry Assistant token is saved. Add it under Settings (the cog in Tools).');
    let r;
    try {
      r = await gmRequest({ url: `${entryBase()}/api/v1/${path}`, headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, timeout });
    } catch (e) {
      throw apiError('unreachable', `${e.message}. If Tampermonkey asked whether to allow the connection, allow it.`);
    }
    if (r.status === 401 || r.status === 403) throw apiError('bad-token', 'Entry Assistant rejected the token. Check it under Settings (the cog in Tools).');
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
    'no-token': 'no Entry Assistant token is saved (Settings (the cog in Tools))',
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
        // What to report on the entry line, and partner agencies: used for queue orders (rejections, holds)
        report: res.report || null,
        agencies: res.agencies || [],
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
  // Options for queue orders: `roles` names the two codes, `rulings` fetches them even for one code, and
  // `extended` adds what to report on the entry line and the partner agencies to the prompt.
  async function gatherFacts(item, { roles = ['Current code', "Merchant's code"], rulings = false, extended = false } = {}) {
    const hs = item.fields.find(f => /^hs code$/i.test(f.label));
    const origin = item.fields.find(f => /^country of origin$/i.test(f.label));
    const current = hsCodeIn(hs?.current);
    const claimed = hsCodeIn(hs?.claimed);
    const from = isoCountry(origin?.current);
    const claimedFrom = isoCountry(origin?.claimed);
    const facts = { codes: [], compare: null, origins: [], problems: [], extended };
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

    const wanted = [[roles[0], current], [roles[1], claimed]].filter(([, raw]) => raw);
    facts.codes = await Promise.all(wanted.map(([role, raw]) => attempt(`${role} ${raw}`,
      () => lookupCode(raw, isChapter99(raw) ? '' : from).then(r => ({ ...r, role })),
      { asked: raw, role, failed: true })));
    if (facts.codes.length && facts.codes.every(c => c.failed)) throw firstError;

    const found = facts.codes.filter(c => c.code);
    const [a, b] = facts.codes.map(c => c.code);
    await Promise.all([
      claimed && a && b && !isChapter99(a) && !isChapter99(b) && attempt('Code comparison',
        async () => { facts.compare = await entryApi(`compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`); }),
      (claimed || rulings) && attempt('CBP rulings', () => Promise.all(found.filter(c => !isChapter99(c.code)).map(async c => { c.rulings = await fetchRulings(c.code); }))),
      current && from && claimedFrom && facts.codes[0].code && attempt(`Duty if made in ${claimedFrom}`,
        async () => { facts.origins = [{ ...facts.codes[0], from }, { ...(await lookupCode(current, claimedFrom)), from: claimedFrom, role: 'Current code' }]; }),
    ]);
    await Promise.all([...found, ...facts.origins.slice(1)].map(addChapter99));
    return facts;
  }

  // For queue orders: the codes to report on the entry line for this origin, in order, what the rules
  // couldn't settle, and the partner agencies (PGA) that review these goods
  function reportLines(c) {
    const L = [];
    const lines = c.report?.lines || [];
    if (lines.length) {
      L.push(`  What to report on the entry line${c.originName ? ` if made in ${c.originName}` : ''}:`);
      for (const r of lines.slice(0, 8)) {
        const extra = [r.program, r.rate, r.hold && 'CBP says not to report it yet', r.check && `check first: ${clean(r.check)}`].filter(Boolean).join(', ');
        L.push(`  - ${r.where}: ${r.code}${extra ? ` (${extra})` : ''}${r.why ? `. ${clean(r.why)}` : ''}`);
        for (const alt of (r.instead || []).slice(0, 4)) L.push(`    - or ${alt.code} when ${clean(alt.when)}`);
      }
    }
    for (const u of (c.report?.unsure || []).slice(0, 4)) L.push(`  Not settled by the code alone: ${clean(u)}`);
    for (const a of c.agencies.slice(0, 6)) {
      const flags = Array.isArray(a.flags) ? a.flags.join(', ') : a.flags || '';
      L.push(`  Partner agency: ${a.agency}${a.program ? ` ${a.program}` : ''}${flags ? `, flags ${flags}` : ''} (${a.basis === 'list' ? "on the agency's list" : 'likely reviews these goods'})${a.what ? `: ${clean(a.what)}` : ''}`);
    }
    return L;
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
        if (f.extended) L.push(...reportLines(c));
      }
      const cmp = f.compare;
      if (cmp) {
        if (cmp.summary) L.push(`- Where they split: ${clean(cmp.summary)}`);
        if (cmp.decide?.length) L.push(`- What decides it: ${cmp.decide.map(x => x.rule).join(', then ')}. ${clean(cmp.decide[0].says)}`);
        for (const n of (cmp.notes || []).slice(0, 6)) {
          const out = [n.leavesOut?.a && `leaves out the ${(f.codes[0]?.role || 'current code').toLowerCase()}`, n.leavesOut?.b && `leaves out the ${(f.codes[1]?.role || "merchant's code").toLowerCase()}`].filter(Boolean).join(', ');
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

  /* ------------------------------------------ dashboard: Entry Assistant site */

  // The Entry Assistant website, shown in the panel's second tab. Its address picks the page: one code
  // (?code=) or two compared (?compare=current,claimed), for goods made in `from`; embed=1 asks for its
  // compact layout. The site itself needs no token.
  const entrySite = () => `${entryBase()}/`;

  function entryLink({ codes = [], from = '' } = {}, embed = false) {
    const url = new URL(entrySite());
    const [a, b] = codes;
    if (a && b) url.searchParams.set('compare', `${a},${b}`);
    else if (a) url.searchParams.set('code', a);
    if (from) url.searchParams.set('from', from);
    if (embed) url.searchParams.set('embed', '1');
    return url.href;
  }

  // A site shows inside another only if its headers allow it: a frame-ancestors rule that lets this
  // dashboard in, or, with no such rule, no X-Frame-Options
  function framingAllowed(headers) {
    const rules = (headers['content-security-policy'] || '').split(',')
      .map(policy => /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(policy))
      .filter(Boolean);
    if (!rules.length) return !/deny|sameorigin/i.test(headers['x-frame-options'] || '');
    return rules.every(([, sources]) => sources.trim().split(/\s+/).some(src => {
      if (src === '*' || src === 'https:') return true;
      const m = /^(?:https:\/\/)?(\*\.)?([a-z0-9.-]+)(?::\d+)?\/?$/i.exec(src);
      if (!m) return false;
      const host = location.hostname;
      return m[1] ? host.endsWith(`.${m[2].toLowerCase()}`) : host === m[2].toLowerCase();
    }));
  }

  // Asked once per page load. A "no" is asked again after a minute, so a change on the site shows up
  // without reloading; if the site can't be reached, the frame is tried anyway.
  let entryFrameCheck = null;
  function entryFrameable() {
    const c = entryFrameCheck;
    if (!c || (c.result === false && Date.now() - c.at > 60000)) {
      const check = { at: Date.now(), result: null };
      check.promise = gmRequest({ url: entrySite(), headers: { Accept: 'text/html' }, timeout: 15000 })
        .then(r => framingAllowed(headerMap(r.responseHeaders)), () => true)
        .then(ok => (check.result = ok));
      entryFrameCheck = check;
    }
    return entryFrameCheck.promise;
  }

  const sameCode = (a, b) => {
    const x = digitsOf(a);
    const y = digitsOf(b);
    return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
  };
  // "8504.40.9580" as "8504.40.95.80". An extra digit (4202.91.80900) is dropped, and so is the "00" the
  // dashboard adds to a Chapter 99 heading (9903.82.0200), since those stop at 8 digits.
  const tidyCode = raw => {
    const d = digitsOf(raw);
    return codeCandidates(isChapter99(d) ? d.slice(0, 8) : d)[0] || '';
  };

  // A line's current code, the merchant's code if they claim another, and the declared origin
  function lineCodes(item) {
    const hs = item.fields.find(f => /^hs code$/i.test(f.label));
    const codes = [...new Set([hsCodeIn(hs?.current), hsCodeIn(hs?.claimed)].map(tidyCode).filter(Boolean))];
    return { codes, from: isoCountry(item.fields.find(f => /^country of origin$/i.test(f.label))?.current) };
  }

  // What to show for a code clicked on the dashboard: both of the line's codes when the merchant claims
  // a different one and the clicked code is either of them, otherwise just the clicked code
  function clickedCodeTarget(button) {
    const code = codeOfButton(button);
    if (!code) return null;
    // A queue order: an HS code review's flagged code opens next to GreenLight's suggestion or the
    // correction typed in; any other code opens alone, for the origin on its row
    if (WORK_ORDER_PATH.test(location.pathname)) {
      const wo = readWorkOrder();
      if (wo?.pair.length && wo.pair.some(c => sameCode(c, code))) return { codes: wo.pair, from: wo.pairFrom };
      const found = wo?.codes.find(c => sameCode(c.code, code));
      return { codes: [code], from: isChapter99(code) ? '' : found?.from || '' };
    }
    const main = document.querySelector('main');
    const d = main && extractDispute();
    const items = d?.items || [];
    const header = main && lineHeaders(main).find(hd => itemBox(hd, main).contains(button));
    const line = header ? +LINE_RE.exec(clean(header.textContent))[1] : 0;
    const item = items.find(i => i.line === line) || items.find(i => lineCodes(i).codes.some(c => sameCode(c, code)));
    const { codes = [], from = '' } = item ? lineCodes(item) : {};
    const pair = codes.length === 2 && codes.some(c => sameCode(c, code));
    return { codes: pair ? codes : [code], from: isChapter99(code) ? '' : from };
  }

  /* ------------------------------------------------- dashboard: the prompt */

  // Claims about what the product is, which call for the full product hunt
  const PRODUCT_CLAIM = /hs code|description|origin|country|tariff|exempt|exclusion|chapter 99|232|301/i;

  // A questionnaire claim is the merchant answering the dashboard's questions to prove what the item is (origin,
  // materials, maker…). The answers are claims; the proof is the real listing the attached images lead to.
  const QUESTIONNAIRE_CHECK = "The merchant filled in Zonos's questionnaire to prove their item: their answers are claims, not proof. Open every attached image (screenshots, product photos, receipts) and identify the item from them: brand, shop or seller name, listing title, listing or order number, labels, \"Made in\" marks, distinctive design. Use that to find the real listing it came from (search the marketplace or the merchant's site by title, shop name and listing number; for an Etsy screenshot, find that shop and listing on Etsy). Read the listing in full: title, description, materials, where it's made and ships from, the shop's location and the price. Then check each questionnaire answer against the listing and the photos, one by one. Accept the claim only for what the listing and documents actually confirm; an answer the listing contradicts, or that nothing supports, means the claim is denied on that point. In the reply, list each answer as matched, contradicted or unsupported, with the listing link.";

  // What counts as evidence for each kind of claim
  const CLAIM_CHECKS = [
    [/questionnaire/i, QUESTIONNAIRE_CHECK],
    [/hs code/i, "Which code does the product, as the evidence shows it, actually fit: the current one, the merchant's, or another in the heading? Check every spec they give that the code wording turns on. Use the HTS facts, notes and rulings here plus your own HTS knowledge (GRI, section and chapter notes)."],
    [/description/i, 'Does the claimed description match what the product actually is and how it is marketed (listing titles, categories, what it fits)?'],
    [/origin|country/i, 'Is there proof of where it was made: "Made in" marks in the images, where the manufacturer makes it, listings, and the documents (commercial invoice, certificate of origin)? Origin is where the item was made or last substantially transformed, not where it shipped from or where the seller is based. The merchant saying so is not proof.'],
    [/value/i, 'Does the claimed value match the price actually paid, per the invoice, receipt or listing? Complaints about duties or fees are not a reason to change the declared value.'],
    [/tariff|exempt|exclusion|chapter 99|301|232/i, 'Does the item really qualify for the exemption or tariff provision the merchant names? Check it against the Chapter 99 headings and the "ways it may pay less" exclusions above, the HS code, the origin, and what the item actually is. The merchant saying so is not proof.'],
    [/weight/i, 'Does the claimed weight match the invoice, listing or shipping documents? If only the unit changed (for example kilograms to ounces), say which unit fits the real item.'],
    [/qty|quantity/i, 'Does the claimed quantity match the invoice, order or listing, for example a pack size?'],
  ];
  const CHAPTER_99_CHECK = "The merchant's code is a Chapter 99 provision, which adds a duty on top of a regular code rather than replacing it. Work out what the merchant actually means (for example, steel rather than aluminum) and whether the evidence supports that.";
  const SECTION_232_CHECK = "Does Section 232 really not apply, or apply only the way the merchant says? That turns on whether the item is a steel, aluminum or copper article or derivative covered for its HTS code, how much of it is that metal, and where the metal was melted and poured (steel) or smelted and cast (aluminum). Look for documents that prove it: a mill certificate, a manufacturer's statement, or an invoice that breaks out the metal's value. The merchant saying so is not proof.";

  function checkFor(claim, item) {
    const { field } = claim;
    const hs = item.fields.find(f => /^hs code$/i.test(f.label));
    if (/hs code/i.test(field) && isChapter99(hsCodeIn(hs?.claimed))) return CHAPTER_99_CHECK;
    if (disputeKinds(item).s232 && (/tariff|exempt|exclusion|chapter 99|232/i.test(field) || /232|alumin|steel|copper/i.test(claim.reason || ''))) return SECTION_232_CHECK;
    return (CLAIM_CHECKS.find(([re]) => re.test(field)) || [null, 'What evidence supports or contradicts it?'])[1];
  }

  // Claims as the merchant filed them, or the changed fields when the page shows no claim text
  const claimsOf = item => (item.claims.length ? item.claims : item.fields.filter(f => f.claimed).map(f => ({ field: f.label, reason: '' })));
  // The dashboard's own automated note ("Zonos classified this code from the description…") isn't the merchant's reason
  const merchantReason = c => (/^zonos (classified|reviewed|accepted)/i.test(c.reason || '') ? '' : c.reason || '');

  // What a line's dispute is about, so the reply template asks for the right things. A tariff claim is
  // treated as Section 232 when it or its reason mentions 232 or a metal, or the lookups show 232 duties.
  function disputeKinds(item, facts) {
    const claims = claimsOf(item);
    const has = re => claims.some(c => re.test(c.field));
    const says = re => claims.some(c => re.test(`${c.field} ${c.reason || ''}`));
    const claimed99 = isChapter99(hsCodeIn(item.fields.find(f => /^hs code$/i.test(f.label))?.claimed));
    const tariff = claimed99 || has(/tariff|exempt|exclusion|chapter 99|232|301/i);
    const metalDuty = !!facts && facts.codes.some(c => /232|steel|alumin|copper/i.test(c.extra || ''));
    // A merchant can file a Section 232 complaint under any field (often the HS code), so the reason counts too
    const s232 = (tariff && (has(/232/i) || says(/232|steel|alumin|copper|metal/i) || metalDuty))
      || says(/section 232|\b232\b|russia\w*\s+alumin|alumin\w*\s+(tariff|from russia)/i);
    const kinds = {
      hs: has(/hs code/i) && !claimed99,
      description: has(/description/i),
      origin: has(/origin|country/i),
      s232,
      tariff: tariff && !s232,
      value: has(/value/i),
      weight: has(/weight/i),
      quantity: has(/qty|quantity/i),
      questionnaire: has(/questionnaire/i),
    };
    // Claims about what the item is, where it's from or which duties apply (and questionnaires, which prove
    // those things) get the full product research
    kinds.product = kinds.hs || kinds.description || kinds.origin || kinds.s232 || kinds.tariff || kinds.questionnaire;
    return kinds;
  }

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
  const SKILL_STEP = "Use the entry-assistant skill (it calls the Entry Assistant API) to look up the current code, the merchant's code and any other code in the heading the evidence points to; read the section, chapter and Chapter 99 notes named above; and check the duties and Chapter 99 headings for the origin you actually find. If you can't use the skill, use your own HTS knowledge and carry on.";

  // Documents first, read like an investigator: in practice the red flags are usually in them
  const DOCS_STEP = 'Start with the attached documents and images, before searching, and read each one like an investigator. For each, note what it is; its date (compare it with the order date); who it\'s from and to; where the goods ship from; any supplier, manufacturer or factory named, with its address; product names and numbers; quantities, prices and currency; HS codes; and whether it actually covers this shipment. Note anything that contradicts the entry or the claim. In photos, zoom in on small print: brands and logos, model, part and serial numbers, barcodes, "Made in" or "Product of" marks, material and fiber tags, stamped or cast marks, certification IDs (CE, UL, FCC ID), and labels. If something is too blurry to read, say so instead of guessing.';

  const CLAIM_TEXT_STEP = "Read the merchant's claim critically. Is it template or AI-written text with blanks left in (\"[supplier name]\", \"[e.g. …]\"), generic wording, or a promise of documents they didn't attach? Does the reason actually address the field they want changed? Each of these is a red flag.";

  const SELLER_STEP = "Research the seller: who they are and where they're based, whether they make the item or resell it, and where they ship from. Look at the website's About and Contact pages and the business registry for its country, and check whether the contact email's domain points to a different company. Then look up every supplier, manufacturer or factory named in the documents or on the product: what it makes and where it is.";

  function buildPrompt(d, s, attachedNames) {
    const L = [];
    const items = d.items.filter(i => i.inDispute);
    const allDocs = [...d.items.flatMap(i => i.docs), ...d.orderDocs].map(x => x.name);
    const notAttached = allDocs.filter(n => !attachedNames.includes(n));
    const claims = items.flatMap(item => claimsOf(item).map(c => ({ ...c, line: item.line })));
    const about = re => claims.some(c => re.test(c.field));
    const kinds = items.map(i => disputeKinds(i, s.facts?.[i.line]?.data));
    const any232 = kinds.some(k => k.s232);
    const productClaim = about(PRODUCT_CLAIM) || any232;

    L.push("I'm a customs broker at Zonos handling a duty dispute. Do the fact-finding I'd otherwise do by hand: find out everything that matters about the item and the seller, catch anything that doesn't add up, and work out what proof is still missing. The merchant's claim is context, not the outline: check every fact in it, but research whatever matters for the duty, even if they didn't mention it.");
    L.push('', 'How I handle disputes:',
      '- The merchant has to prove their claim. Every red flag is a reason to ask them for more.',
      '- When proof is missing, the higher-duty option stands, especially for tariffs (Section 232, Section 301, the Russia aluminum rate). A tariff stays until documents show it doesn\'t apply.',
      '- Every specific thing the merchant says (numbers, materials, use, origin) gets checked against their own website, images and documents.');
    L.push('', "**Research before you reply, every time.** Search the web and open the pages you find: run every search under \"Required searches\" and do every step under \"How to research\", then check you didn't skip one. None of that goes in the reply. Don't fill in the template from this prompt or from memory: everything here is the merchant's side or the entry as filed, and it's what you're checking. If you can't search the web in this chat, don't answer; reply only: \"I can't search the web in this chat. Turn on web search and send this again.\"");

    L.push('', '## Merchant', `- Name: ${d.org || 'unknown'}`);
    const website = normalizeUrl(s.website);
    if (!website) L.push('- Website: not provided. Find it from the name if you can.');
    else if (s.site?.platforms.length) L.push(`- Website: ${s.site.finalUrl} (${s.site.platforms.join(', ')})`);
    else L.push(`- Website: ${s.site?.finalUrl || website}`);
    if (d.emailDomain) L.push(`- Contact email domain: ${d.emailDomain}`);
    if (d.ordered) L.push(`- Order placed: ${d.ordered} (compare document dates with this)`);
    if (d.postedIn) L.push(`- Posted in: ${d.postedIn} (from the tracking number's country code). Where it was posted doesn't decide where it was made.`);
    if (d.order) L.push(`- Order number: ${d.order}`);

    for (const item of items) {
      L.push('', items.length > 1 ? `## Line ${item.line}: ${item.title}` : `## Item: ${item.title}`);
      L.push('| Field | Current entry | Merchant says |', '|---|---|---|');
      for (const f of item.fields.filter(x => x.claimed || !MINOR_FIELDS.test(x.label))) {
        L.push(`| ${f.label} | ${f.current} | ${f.claimed || 'no change'} |`);
      }
      // Decision statuses stay out of the prompt so the research isn't steered by them
      const itemClaims = claimsOf(item).map(c => ({ ...c, reason: merchantReason(c) }));
      if (itemClaims.length) {
        L.push('', 'What the merchant says:');
        itemClaims.forEach((c, i) => {
          const same = itemClaims.slice(0, i).find(p => p.reason && p.reason === c.reason);
          const reason = same ? `same reason as ${same.field}` : c.reason ? `"${c.reason}"` : 'none given';
          L.push(`- ${c.field}. Their reason: ${reason}. Check: ${checkFor(c, item)}`);
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
      L.push('', "Required searches (run every one; the reply doesn't list them):", ...requiredSearches(item, website).map(q => `- ${q}`));
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
      ? `Search the merchant's site: open the search links above, then search again for any numbers or names from the images. Read all of the matching product page (description, specs, materials, price, "Made in" text, reviews), then the item's category, the brand's other products, and the About, FAQ and Shipping pages, which often say where products are made or shipped from. If the site's search doesn't work, use its sitemap (${sitemap}) or a web search limited to the site.`
      : "Find the merchant's website from their name, then search it for the item: product numbers first, then the product name. Open the matching product page and read all of it, then look around the site: the item's category, other products from the same brand, and the About, FAQ and Shipping pages.";

    const allFacts = Object.values(s.facts || {}).filter(f => f.data).map(f => f.data);
    const hasChapter99 = allFacts.some(f => [...f.codes, ...f.origins].some(c => c.chapter99?.length));
    // Metal matters when Section 232 can apply, or when the merchant's code is itself a Chapter 99 metal provision
    const metalMatters = allFacts.some(f => f.codes.some(c => /232|steel|aluminum|copper/i.test(c.extra || '')))
      || items.some(i => isChapter99(hsCodeIn(i.fields.find(f => /^hs code$/i.test(f.label))?.claimed)));
    const declared = items.map(i => i.fields.find(f => /^declared value$/i.test(f.label))?.current).filter(Boolean);
    const platformUnknown = !!website && !s.site?.platforms.length;
    const valueStep = about(/value/i) && "For the value claim, find the price actually paid: the invoice or receipt if one is attached, otherwise the listing price around the order date.";
    const judgeStep = "Then decide where this stands: what's proven, what isn't, and what to ask the merchant for. Without proof, the higher-duty option stands, especially for tariffs." +
      (allFacts.length ? ' The HTS facts above come from the current HTS release, so trust them over memory.' : '');

    const steps = [
      items.length > 1 && `There are ${items.length} lines. Research each one on its own, since they may be different products, and keep each line's findings to its own block in the reply.`,
      attachedNames.length > 0 && DOCS_STEP,
      claims.some(c => merchantReason(c)) && CLAIM_TEXT_STEP,
      siteStep,
      "Run every Required search for each line, then follow up: open the best results (the manufacturer's page, the merchant's listing, marketplace listings), and search again for any new model, part or brand names you found there or in the images. Try variations: with and without dashes or spaces, and partial numbers. Don't stop at the first result.",
      "Fact-check every specific statement in the claim and in any new description against the merchant's own product page, images, manuals and spec sheets: numbers (output, size, weight, capacity), materials, what it's for, and where it's made. For example, a charger described as 25 W whose power adapter is rated 54 W, or a product page whose photos say \"Made in China\" while the entry says Australia.",
      SELLER_STEP,
      "Find how the item is marketed: listing titles, categories, and what it fits or is compatible with, on the merchant's site and on marketplaces. For example, a lever sold for ATVs or motorcycles is a vehicle part, not a farm machinery part.",
      `Find prices for the same item: the merchant's site, eBay (including sold listings), AliExpress, Amazon and anywhere else it's sold. Compare them with the declared value${declared.length === 1 ? ` (${declared[0]})` : ''}.`,
      valueStep,
      productClaim && "Find the manufacturer's own page for the item, plus spec sheets, manuals or datasheets.",
      productClaim && 'Answer every "What to find" point.',
      about(/hs code/i) && "For the HS code claim, work out the right code within the heading. Decide what the item is in its main identity, and for kits and sets what gives it its essential character (GRI 3(b)). Then read the subheading and statistical suffix wording in the current HTS, including the residual \"other\" lines, and check every spec the wording turns on. Compare with the closest CBP rulings (CROSS, with the entry-assistant skill or at rulings.cbp.gov), and say why any ruling that points elsewhere doesn't fit (a different input, a different build, outdated wording). The answer can be neither the current code nor the merchant's.",
      (productClaim || metalMatters) && "Find what it's made of. If it's metal, say which metal (steel, stainless steel, aluminum, copper or brass, zinc alloy) and roughly how much of its weight is metal, using the images, listings and spec sheets.",
      productClaim && 'Look for country-of-origin evidence: "Made in" marks in the images, documents or listings; where the manufacturer and its suppliers are and where they have factories; the same product sold by overseas sellers on AliExpress, Alibaba, 1688, DHgate, Temu or Amazon. Where it was posted or shipped from doesn\'t decide origin, and a barcode prefix only shows where the barcode was registered.',
      hasChapter99 && "Using the Chapter 99 headings above, work out which ones apply. For Section 232 headings that comes down to the metal, the share of the weight that is metal, what the item is used for (for example motorcycle or other vehicle parts), and where it's made.",
      any232 && "For the Section 232 claim: is the item a steel, aluminum or copper article or derivative covered for its HTS code (the Chapter 99 headings above, or what the entry-assistant skill finds)? Estimate its metal content by weight, and by value if the documents show it, and find where the metal was melted and poured (steel) or smelted and cast (aluminum), from mill certificates, the manufacturer or the attached documents. The merchant's word that it isn't steel, isn't Russian, or that the metal content is small, isn't proof without such a document.",
      productClaim && !about(/hs code/i) && 'Find CBP rulings (CROSS) on this kind of product, with the entry-assistant skill or at rulings.cbp.gov, and note the closest one: its number, what it covers, and how this item compares.',
      about(/qty|quantity|weight/i) && 'For a quantity or weight claim, compare it with the invoice, the listing or the shipping documents.',
      platformUnknown && "Name the e-commerce platform the merchant's site runs on (Shopify, WooCommerce and so on).",
      "Collect every red flag: anything in the documents, the claim, the website or your research that contradicts the entry, the claim or itself, or that's missing when it should be there.",
      SKILL_STEP,
      judgeStep,
    ].filter(Boolean);
    L.push(...programLines());
    L.push('', '## How to research', ...steps.map((step, i) => `${i + 1}. ${step}`));
    L.push('', "If a page won't open, say which one and try another route: the site's search, its sitemap, or a web search limited to the site (site: plus the domain and the product number).");
    L.push('Use as many searches as it takes. A thorough answer matters more than a fast one.');

    // The reply is a fill-in template, built per line from what that line's dispute is about, so every answer
    // has the same sections in the same order. The "### Line N" headings let the script save each line's
    // verdict, and the verdict line has to carry its own proof.
    L.push('', '## Reply',
      `Fill in this template${items.length > 1 ? ', one block per line, in this order' : ''}:`,
      '- Copy the headings and labels, in this order. Replace each <…> with what you found and drop the angle brackets. Write "Not found" where you looked and found nothing.',
      "- Keep it short: one line per bullet, no paragraphs, no greeting, no recap of the dispute. Write only the final reply: no progress notes, no list of the steps or searches, and no mention of the Entry Assistant API or the skill.",
      '- Put HTS and Chapter 99 codes in backticks, and link a source for every fact.',
      "- Red flags come first: anything that doesn't add up, from the documents, the claim text, the website or your research, each with its source. Nothing is too small: a document dated years before the order, goods shipping from a different country than the stated origin, a template with blanks left in, an email domain that doesn't match the website, a spec that contradicts the claim, a promised document that isn't attached.",
      "- Under Ask the merchant for, list the specific documents or facts that would settle what's still unproven, each with what it would prove. For example: a mill certificate or supplier declaration naming the countries where the aluminum was smelted and cast; a bill of materials with each component's origin and cost; the latest supplier invoice; a spec sheet showing the output. Only what the merchant can actually provide. Settle classification questions yourself.",
      "- The verdict must carry its proof. Don't just say what the item \"clearly\" is: say what shows it (which photo, document or listing, with its link) and which rule it meets or fails (the HTS heading or subheading text, the origin rule, the Section 232 heading). One or two sentences on one line.",
      `  An example of the level of proof wanted (not of the content): "The merchant's claim is somewhat substantiated because the item is a finished microphone, not a part: the merchant's own listing ([link]) sells it as a complete USB condenser mic and photo 2 shows it assembled with its cable, so heading 8518 is right but their subheading (parts of microphones) is not; it belongs with complete microphones in 8518.10."`,
      '- End the whole reply (once, after the last block) with this line on its own: "Would you like me to draft an email?"',
      '- If I say yes, write a short, friendly email to the merchant contact: what the charge or code depends on, the requests as a numbered list, what happens once you have them, and the order number at the end. For example: "Hey Matt, I\'m looking at your dispute for the Section 232 duties. This charge depends on where the aluminum was smelted and cast, so we can remedy it once we have evidence that neither happened in Russia. Please send: 1. … Once we have these, we\'ll review the charge and recalculate the landed cost."');
    L.push(`- Start the whole reply with ${FINAL_LABEL} (once, before the first block): ${finalStyle('DUTY_DISPUTE')}`, '', `${FINAL_LABEL} <one sentence>`);
    items.forEach((item, i) => L.push('', ...replyBlock(item, s, { platformUnknown: platformUnknown && i === 0 })));
    return L.filter(line => line !== false).join('\n');
  }

  // The one-sentence answer at the top of every reply: what the panel shows first, and what the cloud
  // research writes to the case's "Claude Final Answer" in Notion. Plain words, the decision and why.
  const FINAL_LABEL = '**Final answer:**';
  function finalStyle(type) {
    const how = {
      ADCVD_REVIEW: '"It is in scope because …" or "It is out of scope because …"',
      DENIED_PARTY_REVIEW: '"It is a false positive because …" or "It is a true match because …"',
      HS_CODE_REVIEW: '"The current code is right because …" or "The code should be `<code>` because …"',
      VALUE_REVIEW: '"The declared value is believable because …" or "The value should be <amount> because …"',
      DUTY_DISPUTE: '"The claim is substantiated because …", "The claim is somewhat substantiated because …" or "The claim is not substantiated because …" (for several lines, one sentence covering them)',
    }[type] || '"<the decision, as the page words it> because …"';
    return `one plain sentence a coworker understands at a glance, no Markdown, written as ${how}.`;
  }
  // That sentence, from a saved answer: the Final answer line, else the AD/CVD scope line, the decision, or the verdict
  function finalSentence(text) {
    const t = text || '';
    const line = re => (re.exec(t) || [])[1];
    const final = line(/^[ \t>*_-]*final answer[*_]*:[*_ \t]*([^\n]+)/im);
    if (final && !/^</.test(final)) return plainText(final);
    const scope = line(/^[ \t>*_-]*in or out of scope[*_]*:[*_ \t]*([^\n]+)/im);
    if (scope) {
      const p = plainText(scope);
      const why = p.split(/\s+[—–-]\s+/).slice(1).join(' — ');
      return `It is ${/^in scope/i.test(p) ? 'in' : 'out of'} scope${why ? ` because ${why.replace(/^because\s+/i, '').replace(/^./, c => c.toLowerCase())}` : '.'}`;
    }
    const decision = decisionOf(t);
    if (decision) return decision.sentence;
    const claim = line(/(the merchant['’]s claim is [^\n]+)/i);
    return claim ? plainText(claim) : '';
  }

  // "HS code (8714.10.0000 → 8716.90.5060) · Description (Brake lever → Farm equipment lever)"
  function disputeLine(item, k) {
    const short = v => { const t = clean(v); return t.length > 60 ? `${t.slice(0, 57)}…` : t; };
    const asks = [...new Set(claimsOf(item).map(c => c.field))].map(field => {
      const f = item.fields.find(x => x.label.toLowerCase() === field.toLowerCase());
      return f?.claimed ? `${field} (${short(f.current) || 'blank'} → ${short(f.claimed)})` : field;
    });
    const named232 = asks.some(a => /232/.test(a));
    return `**Dispute:** ${asks.join(' · ') || 'see the claims above'}${k.s232 && !named232 ? ' · Section 232' : ''}`;
  }

  // The bottom line first, then the red flags and the facts, what to ask for, and the verdict with its proof.
  // Lines for the code, origin, Section 232, tariffs, value, weight and quantity appear only for those disputes.
  function replyBlock(item, s, { platformUnknown }) {
    const facts = s.facts?.[item.line]?.data;
    const k = disputeKinds(item, facts);
    const declared = item.fields.find(f => /^declared value$/i.test(f.label))?.current || '<declared value>';
    const theirCode = hsCodeIn(item.fields.find(f => /^hs code$/i.test(f.label))?.claimed);
    return [
      `### Line ${item.line}: ${item.title}`,
      '**Bottom line:** <where this stands and the next step, in one line>',
      disputeLine(item, k),
      '',
      '**Red flags**',
      '1. <each thing that doesn\'t add up, with its source; or "None found">',
      '',
      '**What we found**',
      "- **Product:** <what it is, what it does, the specs that matter, and what it's made of> ([<source>](<link>))",
      k.description && "- **Description it should be:** <brief: what it is, what it does, and what it's made of>",
      '- **Sold as:** <how the seller and other listings market it, and what it fits> ([<source>](<link>))',
      "- **Seller:** <who they are, where they're based, maker or reseller, related companies>",
      '- **Supplier or maker:** <companies named in the documents or found in research, what they make, and where>',
      '- **Origin:** <country> — <the evidence>',
      '- **Shipped from:** <where it was posted or shipped from, and how you know>',
      `- **Prices:** low <price> ([<site>](<link>)) · high <price> ([<site>](<link>)) · declared ${declared}`,
      k.hs && `- **Code:** \`<code>\` — <why: what the item is in its main identity, and the subheading or suffix wording it meets> (merchant wants \`${theirCode || '<their code>'}\`)`,
      (k.hs || k.description) && '- **Closest rulings:** <ruling numbers, what they cover, which match and why any others don\'t>',
      k.s232 && "- **Section 232:** <proven | not proven> — <the metal and its share, the countries where it was smelted and cast, and the heading>",
      k.tariff && "- **Tariff provision:** <applies | does not apply | can't tell> — <whether the item meets the terms of the heading or exclusion they name>",
      k.value && `- **Value:** price paid <amount> per <the invoice | receipt | listing> vs declared ${declared}`,
      k.weight && '- **Weight:** <weight per the invoice, listing or shipping documents> vs the claimed weight',
      k.quantity && '- **Quantity:** <quantity per the invoice, order or listing> vs the claimed quantity',
      k.questionnaire && '- **Real listing:** <the listing the attached images lead to> ([<site>](<link>)) — <how you matched it: shop, title, listing number, photos>',
      k.questionnaire && '- **Questionnaire check:** <each answer: matched | contradicted | unsupported, and what the listing or photos show>',
      platformUnknown && "- **Platform:** <what the merchant's site runs on>",
      '',
      '**Ask the merchant for**',
      '1. <a specific document or fact> — <what it would prove; or "Nothing: the research settles it">',
      '',
      "**Verdict:** The merchant's claim is <substantiated | somewhat substantiated | not substantiated> because <the proof: what the evidence shows, where it comes from, and the rule it meets or fails>.",
    ];
  }

  /* -------------------------------------------- dashboard: Entry Writer Queue orders */

  // An order in the Entry Writer Queue: /entry-writer-queue/<PROBLEM_CLASS>/<subject id>. Each problem class
  // is its own page with its own question and choices, so the page is read generally (what it shows, the
  // codes on it, and the buttons it offers) and the research brief comes from the class's guide below.
  const WORK_ORDER_PATH = /^\/entry-writer-queue\/([A-Z][A-Z_]+)\/([^/]+)\/?$/;
  const isCasePage = () => DISPUTE_PATH.test(location.pathname) || WORK_ORDER_PATH.test(location.pathname);

  // Safe-side rules shared by every class
  const ORDER_RULES = [
    "- Nothing is filed or cleared on a guess. When the evidence doesn't settle it, say exactly what's missing, and pick the safe choice (hold, block or fix) over the one that lets it through.",
    '- Check everything the page says against the goods as they really are and the rules as they are today (the current HTS, CBP messages, the agency rules).',
  ];

  // goal: what the order is for. find: what the research must settle. found: the class's lines in the
  // reply's "What we found". note: the name of the note box on the page.
  const WORK_ORDER_GUIDES = {
    HS_CODE_REVIEW: {
      label: 'HS code review',
      goal: "Our automated check (GreenLight) flagged the HS code on a line before filing. Find out exactly what the goods are, and decide whether the current 10-digit code is right; if it isn't, which code is.",
      find: [
        'The line\'s description is often vague ("Trousers"). Pin the item down from everything on the page: the other lines on the bill (a bill that also has "Womens Jeans" says something about the trousers), the value, the origin, the shipper and the carrier. If the shipper has a website, find the item there.',
        "Work out every fact the code turns on (see What to find below). For clothing that's knit or crocheted versus woven, the fiber that predominates by weight, men's or boys' versus women's or girls', and the garment type; for other goods, what it is, what it's made of and what it does.",
        'Read the heading, subheading and statistical suffix wording in the current HTS, including the residual "other" lines, and the section and chapter notes. Compare the closest CBP rulings (CROSS) and say why any that point elsewhere don\'t fit.',
        "If GreenLight suggested a code, check it the same way: it can be wrong too. If the goods can't be pinned down well enough to choose between codes, say what's missing.",
      ],
      found: [
        "- **What it is:** <the item: garment or product type, who it's for, material, knit or woven, construction> ([<source>](<link>))",
        '- **Code:** `<the right 10-digit code>` — <the heading, subheading and suffix wording it meets> (current `<current code>`)',
        "- **Closest rulings:** <ruling numbers, what they cover, which match and why any others don't>",
        '- **Duty:** <the duty on the current code and on the right one, for the origin>',
      ],
      note: 'Review note',
    },
    VALUE_REVIEW: {
      label: 'Declared value review',
      goal: 'Our automated check (GreenLight) flagged the declared value as unlikely for these goods. Find what the items really sell for, and decide whether the declared value is believable or needs correcting.',
      find: [
        'Identify each item from its description, HS code and origin, as precisely as the page allows.',
        'Find what each sells for: marketplaces in the origin country and in the US (eBay including sold listings, Amazon, AliExpress, local shops), and the shipper\'s own site if there is one. Compare unit by unit with the declared unit values.',
        'Look for signs of undervaluation: values far below any real price, round placeholder values ($1, $5), the same value on every line, or a total that looks set to stay under a threshold.',
        'Check the HS codes make sense for the descriptions while you\'re at it, and say if one doesn\'t.',
      ],
      found: [
        '- **Prices found:** <per line: low and high with links> vs declared <unit value>',
        '- **Value it should be:** <per line, if the declared value isn\'t believable, and how you got it>',
      ],
      note: 'Note',
    },
    DENIED_PARTY_REVIEW: {
      label: 'Denied-party review',
      goal: 'Denied-party screening matched a party on this consignment against a restricted-party list. Decide whether the party on the consignment is the listed entity.',
      // Shown with the shared rules: no outreach, official sources only, and how to read the confidence score
      rules: [
        "- **No outreach, ever.** I can't contact the shipper, the consignee, the merchant or anyone else about a denied-party match. Decide from what the page shows and what official sources say, and make the best determination that evidence supports.",
        '- **Official sources only.** The U.S. government lists and their own records: the Consolidated Screening List (https://www.trade.gov/consolidated-screening-list) and its search tool, OFAC Sanctions List Search (https://sanctionssearch.ofac.treas.gov), the BIS Entity, Denied Persons, Unverified and Military End User lists (bis.gov, eCFR 15 CFR part 744), the State Department\'s DDTC debarred list, and the Federal Register notices that added the entity. To establish who a business party is, also a government business registry or the company\'s own official website. Never third-party screening sites, aggregators, news, forums or social media.',
        '- **The confidence score is a starting point, not the answer.** Screening flags anything that even closely resembles a listed name, so most hits are false positives. A high score on the name alone is not a match; a lower score can still be a true match if the address, city, country or an ID number lines up. Weigh the score together with every field you can compare.',
      ],
      find: [
        "Read the match: the screened party and its role (the page asks, for example, \"Is the shipper / exporter the listed entity?\"), its name, address, city and country, and for each listed match the name, the list (\"Listed on\"), the **overall score** and its parts (name and location), and the screening's own field-by-field comparison in the Screening data section. Say what drove the score: a shared generic word (\"Company\", \"Trading\", \"Ltd\"), a similar spelling or transliteration, or a common surname. A high name score with a 0% location score and no field matching is the classic false positive.",
        "Find the listed entity's full record on the Consolidated Screening List and the source list it names (OFAC SDN, BIS Entity List and so on): its aliases, addresses, ID numbers, nationality and program, and the Federal Register or OFAC notice that listed it. An \"Unnamed listed entity\" match means the list record carries few details; say what that means for the match.",
        'Compare the party with the listed record field by field: name (spelling, transliteration, word order, aliases), entity type (person or organization), address, city or state, country, and any ID, date of birth or nationality.',
        "Work out who the consignment party is from the page and official sources only: a private person or a business, what the shipment is (personal goods, retail order, industrial goods), and what kind of address it is (a home, a hotel, a business). A common name or a single shared word, with nothing else matching, is not a match on its own.",
        'Never clear a party whose address, ID numbers or other identifiers match the listed entity. If the record and the party conflict on a hard identifier (different country, a person versus an organization, a different date of birth), that weighs strongly toward a false positive.',
        "Make the best determination the evidence supports, and give your confidence in it (high, medium or low) with the reason. If it genuinely can't be told apart, say so and take the safe choice on the page.",
      ],
      found: [
        '- **Screening hit:** <confidence score> on <listed name> (<list and program>); what drove the score',
        '- **Party on the consignment:** <who it is, as far as the page and official sources show>',
        '- **Listed entity:** <list and program, name and aliases, addresses, identifiers> ([<official source>](<link>))',
        '- **Field by field:** name <match | partial | no> · type <…> · address <…> · city <…> · country <…> · IDs <…>',
        '- **Determination:** <true match | false positive | can\'t tell> — confidence <high | medium | low> because <the deciding fields>',
      ],
      showParties: true,   // the screened party is the point of the review, so its name and address stay in
      noOutreach: true,
      note: 'Adjudication note',
    },
    ADCVD_REVIEW: {
      label: 'AD/CVD review',
      goal: "An item on this manifest line matched an anti-dumping or countervailing duty case on HS code and origin, so its quote was blocked and it's off the IMDW. Decide whether the matched item falls within the case's written scope: in scope keeps it off the IMDW; out of scope re-quotes it without the AD/CVD check so it files.",
      rules: [
        "- **No outreach, ever.** I can't contact the shipper, the consignee or the merchant for more information about an AD/CVD match. Decide from what the page shows and what official sources say, and make the best determination that evidence supports.",
        "- **A photo is unlikely.** There may occasionally be a product photo or document on the page; if there is, look at it closely and use it. Usually there's only the description, HS code, origin, quantity and value, so don't plan on one.",
        "- **The written scope decides, not the HS code.** The HTS numbers in an order are for convenience; the scope text in the Federal Register order (and later scope rulings) controls. Read it, including every exclusion.",
      ],
      find: [
        'Identify the matched item: which line(s) on the page share the case\'s HS code and origin, and what each one is from its description, code, value, quantity and the other lines on the bill.',
        "Find the case: its number (A- for anti-dumping, C- for countervailing), product and country, and the order's written scope from the Federal Register (govinfo.gov or federalregister.gov) or the ITA/Enforcement and Compliance scope pages (trade.gov, access.trade.gov ACCESS). Check for later scope rulings on similar products.",
        'Compare the item with the scope point by point: the product definition, the physical tests it sets (size, weight, material, thickness, coating, printing and so on) and every exclusion. Say which tests the item meets, which it fails, and which the page can\'t show.',
        "Make the best call the evidence supports. When the description and code fit the scope and nothing shows an exclusion, it stays in scope. A clear mismatch (a different product that only shares a word or a code) is out of scope. Only when the deciding fact truly can't be inferred from the page, say so and pick the safe choice.",
      ],
      found: [
        '- **Flagged item:** <the matched line: description, HS code, origin, qty, value>',
        '- **Case:** <case number, product and country> ([scope](<Federal Register or ITA link>))',
        '- **Scope tests:** <each test or exclusion: met | failed | not shown>',
      ],
      noOutreach: true,
      showTracking: true,
      // First thing in the reply, so the call reads at a glance
      header: [
        '**Flagged item:** <the item the case matched, as the page names it, with its HS code and origin>',
        '**Tracking number:** <the tracking number on the page, or "Not shown">',
        '**In or out of scope:** <In scope (keep off IMDW) | Out of scope (file on IMDW)> — <one plain sentence: why the item is in or out of the case\'s written scope>',
        '',
      ],
      bestGuess: "**Best guess:** <in scope | out of scope> — confidence <high | medium | low>; <what, if it were on record, would change it (we can't ask anyone)>",
      note: 'Note',
    },
    ENTRY_REJECTED: {
      label: 'Entry rejected',
      goal: "CBP rejected this entry. Explain each rejection code, find what in the entry caused it, and say exactly what to change before it's sent again.",
      find: [
        "Look up each rejection code in CBP's ACE documentation (the CATAIR error dictionary) and say what it means in plain words.",
        "For classification codes, such as 609 (single HTS not allowed, second HTS required), use the HTS facts below, especially what to report on the entry line for the origin, to name the exact additional or corrected HTS numbers, usually Chapter 99 headings for Section 301, Section 232 or other extra duties.",
        'Check recent CBP messages (CSMS) for changes that explain the rejection.',
        'Check the lines on the page against the fix: codes, origins, values and quantities.',
      ],
      found: [
        '- **Rejection:** <each code: what it means>',
        '- **Cause:** <what in the entry triggered it, line by line>',
      ],
      note: 'Note',
    },
    SUBMISSION_FAILED: {
      label: 'Submission failed',
      goal: "The filing gateway refused to send this entry to CBP. Work out what the gateway's message means and what to fix before submitting again.",
      find: [
        "Decode the gateway's message: which invoice, line and field it names, and what the flag or code means. Flags on an HTS line usually belong to a partner agency (for example DT for NHTSA/DOT, FD for FDA, EP for EPA, AL or AQ for APHIS), and mean that line needs that agency's data or a disclaimer.",
        'Use the HTS facts below (partner agencies and flags for each code) to say which agency, what it requires for these goods, and whether a disclaimer applies.',
        'Check recent CBP messages (CSMS) and the agency\'s own guidance.',
      ],
      found: [
        '- **Error:** <what the gateway refused, in plain words>',
        '- **Cause:** <the line, field and rule behind it>',
      ],
      note: 'Note',
    },
    VALIDATION_BLOCKED: {
      label: 'Validation blocked',
      goal: 'Our pre-filing validation blocked this consignment. Find what failed and what to change so it can be filed.',
      find: [
        'Read each validation message on the page and find the field it is about.',
        'Check the fields involved: HS codes valid in the current HTS release, origins, values, quantities and units, parties, and partner-agency data the codes call for.',
      ],
      found: ['- **What failed:** <each check and why>'],
      note: 'Note',
    },
    CBP_HOLD: {
      label: 'CBP hold',
      goal: 'CBP put a hold on this shipment. Work out which hold it is, why CBP likely placed it, and what CBP will need to release it.',
      find: [
        'Name the hold from the codes and messages on the page, and say what it means.',
        'Look at what about the goods could have triggered it: vague descriptions, values, origin, brands (possible counterfeits), forced-labor orders and UFLPA, import bans, AD/CVD, and partner-agency requirements for the codes.',
        'List the documents or information to have ready for CBP.',
      ],
      found: ['- **Hold:** <which hold and what it means>', '- **Likely reason:** <what about these goods or this entry triggered it>'],
      note: 'Note',
    },
    CBP_EXAM: {
      label: 'CBP exam',
      goal: 'CBP selected this shipment for an exam. Work out what kind of exam and why, and what to prepare so it clears.',
      find: [
        'Name the exam from the codes and messages on the page.',
        "Check whether the entry matches the goods as they really are (descriptions, codes, values, origin), since that's what an exam looks at, and look for brands or goods that draw IPR, safety or agency attention.",
        'List the documents to have ready.',
      ],
      found: ['- **Exam:** <type and what it means>', '- **Risks:** <what CBP is likely to look at in these goods>'],
      note: 'Note',
    },
    PGA_HOLD: {
      label: 'PGA hold',
      goal: 'A partner government agency (FDA, USDA APHIS, EPA, CPSC, NHTSA, FWS and others) is holding this shipment. Work out which agency and why, and what it needs to release it.',
      find: [
        'Name the agency and the hold from the page.',
        "Use the HTS facts below (partner agencies and flags for each code) and the agency's own rules to say what it requires for these goods: registrations, prior notice, permits, certificates, labels, or a disclaimer when the goods aren't regulated.",
      ],
      found: ['- **Agency and hold:** <which agency, which program, what the hold means>', '- **What it needs:** <documents or data, and from whom>'],
      note: 'Note',
    },
    CBP_CANCELLED: {
      label: 'CBP cancelled',
      goal: 'CBP cancelled this entry. Work out why, and what has to happen next: a corrected new filing, nothing, or something else.',
      find: ['Read the cancellation codes and messages on the page and say what they mean.', 'Work out whether the goods still need an entry, and what has to be different this time.'],
      found: ['- **Cancellation:** <why CBP cancelled it>'],
      note: 'Note',
    },
    UNFILEABLE: {
      label: 'Unfileable',
      goal: "This consignment was parked as unfileable. Work out what makes it unfileable, and whether it can be fixed and filed or should stay out.",
      find: ['Read the reasons on the page.', 'For each, say whether it can be fixed (and how, from what source) or not.'],
      found: ['- **Why it can\'t be filed:** <each reason>'],
      note: 'Note',
    },
    CARRIER_MANIFEST_MISMATCH: {
      label: 'Carrier manifest mismatch',
      goal: "The carrier's manifest doesn't match our entry data. Find which fields differ and which side is right.",
      find: ['Compare every field the page shows from both sides: tracking numbers, bills, piece counts, weights, values and descriptions.', 'Work out which side is right for each, from the documents and the goods.'],
      found: ['- **Differences:** <each field: manifest vs our data, and which is right>'],
      note: 'Note',
    },
    DUTY_DISPUTE_REVIEW: {
      label: 'Duty dispute review',
      goal: "A duty dispute needs a broker's review here. The merchant has to prove their claim; without proof, the higher duty stands.",
      find: ["Check every fact the merchant gives against their website, the documents and the goods.", 'Work out what proof is still missing.'],
      found: ['- **Claim:** <what the merchant wants changed>', '- **Proof:** <what supports or contradicts it>'],
      note: 'Note',
    },
  };
  const titleCase = s => s.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const guideFor = type => WORK_ORDER_GUIDES[type] || {
    label: titleCase(type),
    goal: "Work out what the problem on this order is, what caused it, and what to do so the shipment can move.",
    find: ['Read every message and code on the page and say what each means.'],
    found: ['- **Problem:** <what is wrong>', '- **Cause:** <why>'],
    note: 'Note',
  };

  const S10_TRACKING = /\b[A-Z]{2}\d{9}[A-Z]{2}\b/g;
  const codeOfButton = b => tidyCode(b.textContent) || tidyCode(((b.getAttribute('aria-label') || '').match(/\d{4}[\d.]{2,10}/) || [])[0]);

  // Buttons that are a choice on the order, with the line of help the page gives each
  const NOT_A_CHOICE = /^(claim( order| all)?|add note|upload|discard|view raw cbp response|back to entry writer queue|manage consignment)$/i;
  function choicesOn(main, activity) {
    const out = [];
    for (const b of main.querySelectorAll('button')) {
      if (b.getAttribute('aria-expanded') != null || b.title === 'Look up in the HTS' || (activity && activity.contains(b))) continue;
      const label = clean(b.textContent);
      if (!label || label.length > 60 || NOT_A_CHOICE.test(label) || /^[A-Z][a-z]+( [A-Za-z]+)* \([A-Z]{2}\)$/.test(label) || /^\d+$/.test(label)) continue;
      const next = b.nextElementSibling;
      const hint = next?.tagName === 'P' ? clean(next.textContent) : '';
      if (!out.some(c => c.label === label)) out.push({ label, hint });
    }
    return out;
  }

  // An editable code and its lookup button say the same code twice
  function oneCodeEach(text) {
    const seen = [];
    return clean(text).split(' ').filter(w => {
      if (!/^\d{4}[\d.]{4,}$/.test(w)) return true;
      if (seen.some(x => sameCode(x, w))) return false;
      seen.push(w);
      return true;
    }).join(' ');
  }

  // The page as plain lines for the prompt: headings, "Label: value" pairs, tables as rows, editable fields
  // by their values. Left out: the claim banner, the activity log (notes and staff names), upload forms,
  // the consignee, everything about the shipper but its company name, country and email domain, and
  // tracking numbers (only the posting country is kept).
  // showParties keeps every party in full (a denied-party review is about exactly that party).
  function pageLines(main, activity, showParties = false) {
    const out = [];
    let line = '';
    let party = '';
    const push = text => {
      const t = oneCodeEach(text);
      if (!t) return;
      const bare = t.replace(/^#+\s*/, '');
      if (showParties) {
        if (/^(claim this order to work it|you can view it, but edits|claimed by .+ view only)/i.test(t)) return;
        out.push(t.replace(S10_TRACKING, '[tracking number]'));
        return;
      }
      if (/^(consignee|shipper ?\/ ?exporter|shipper|exporter|importer of record|notify party)$/i.test(bare)) {
        party = /^shipper|^exporter/i.test(bare) ? 'shipper' : 'hidden';
        if (party === 'shipper') out.push(bare);
        return;
      }
      if (/^#{2,3} /.test(t) || /^(items|handling units|status history|documents|activity|entry (and|&) consignment)\b/i.test(bare)) party = '';
      if (party === 'hidden') return;
      if (party === 'shipper') {
        const m = /^(company name|country|email): (.+)$/i.exec(t);
        if (!m) return;
        out.push(/email/i.test(m[1]) ? `Email domain: ${(m[2].split('@')[1] || '—')}` : t);
        return;
      }
      if (/^(claim this order to work it|you can view it, but edits|claimed by .+ view only)/i.test(t)) return;
      out.push(t.replace(S10_TRACKING, '[tracking number]').replace(/\bconsignee (?!—)[^·]+·/i, 'consignee [left out] ·'));
    };
    const flush = () => { push(line); line = ''; };
    const valueOf = el => {
      if (el.tagName === 'SELECT') return clean(el.selectedOptions?.[0]?.textContent);
      if (el.type === 'file' || el.type === 'checkbox' || el.type === 'radio' || el.type === 'hidden') return '';
      return clean(el.value);
    };
    const cellText = td => {
      const parts = [];
      const walkCell = n => {
        if (n.nodeType === 3) { parts.push(n.nodeValue); return; }
        if (n.nodeType !== 1 || n.tagName === 'svg') return;
        if (n.tagName === 'BUTTON') { const c = n.title === 'Look up in the HTS' ? codeOfButton(n) : ''; if (c) parts.push(` ${c} `); else if (!n.querySelector('button')) parts.push(` ${n.textContent} `); return; }
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)) { parts.push(` ${valueOf(n)} `); return; }
        // Stacked blocks in one cell ("US Department of Justice…" over "Listed Sep 22, 2017") stay apart
        const stacked = n !== td && (/^(DIV|P|LI|BR)$/.test(n.tagName) || /(^|\s)block(\s|$)/.test(typeof n.className === 'string' ? n.className : ''));
        if (stacked && parts.length) parts.push(' · ');
        n.childNodes.forEach(walkCell);
      };
      walkCell(td);
      return oneCodeEach(parts.join(''));
    };
    const walk = node => {
      if (node.nodeType === 3) { line += node.nodeValue; return; }
      if (node.nodeType !== 1) return;
      const el = node;
      const tag = el.tagName;
      if (el === activity || tag === 'svg' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'FORM') return;
      if (tag === 'INPUT') { const v = valueOf(el); if (v) line += ` ${v} `; return; }
      if (tag === 'TABLE') {
        flush();
        party = '';
        const head = [...el.querySelectorAll('thead th')].map(th => clean(th.textContent));
        const rows = [...el.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(cellText));
        if (head.length) out.push(`| ${head.join(' | ')} |`);
        for (const r of rows.slice(0, 25)) {
          if (head.length) out.push(`| ${r.join(' | ')} |`);
          else if (r.length === 2) push(`${r[0]}: ${r[1]}`);
          else push(r.join(' · '));
        }
        return;
      }
      if (tag === 'BUTTON') {
        if (el.title === 'Look up in the HTS') { const c = codeOfButton(el); if (c) line += ` ${c} `; return; }
        // A country picker ("United States (US)") is a value, not a section
        if (el.getAttribute('aria-expanded') != null && /\([A-Z]{2}\)$/.test(clean(el.textContent))) { line += ` ${clean(el.textContent)} `; return; }
        if (el.getAttribute('aria-expanded') != null) { flush(); out.push(`## ${clean(el.textContent).replace(/\d+$/, '').trim()}`); party = ''; }
        return; // other buttons are the choices, listed on their own
      }
      // A label and its value side by side: <div><p>Company name</p><p>Acme</p></div>, or dt/dd
      const kids = [...el.children];
      if (tag === 'DIV' && kids.length === 2 && kids.every(k => k.tagName === 'P') && !kids[0].children.length) {
        flush();
        push(`${clean(kids[0].textContent)}: ${cellText(kids[1]) || '—'}`);
        return;
      }
      if (tag === 'DT') { flush(); line = `${clean(el.textContent)}: `; return; }
      if (tag === 'DD') { line += cellText(el); flush(); return; }
      const block = /^(DIV|P|SECTION|LI|UL|OL|HEADER|FOOTER|ARTICLE|ASIDE|LABEL|FIELDSET|NAV|DL)$/.test(tag);
      if (/^H[1-6]$/.test(tag)) { flush(); push(`### ${el.textContent}`); return; }
      if (block) flush();
      el.childNodes.forEach(walk);
      if (block) flush();
      else line += ' '; // side-by-side spans keep a space between them
    };
    walk(main);
    flush();
    // Status history and other long lists can run on; keep the prompt to a sensible size
    const text = [];
    let size = 0;
    for (const l of out) {
      if (size > 9000) { text.push('… (the rest of the page is left out)'); break; }
      if (text[text.length - 1] !== l) text.push(l);
      size += l.length;
    }
    return text;
  }

  function readWorkOrder() {
    const m = WORK_ORDER_PATH.exec(location.pathname);
    const main = document.querySelector('main');
    if (!m || !main) return null;
    const [, type, id] = m;
    const guide = guideFor(type);
    const activityToggle = [...main.querySelectorAll('button[aria-expanded]')].find(b => /^activity$/i.test(clean(b.textContent)));
    const activity = activityToggle?.parentElement;
    const lines = pageLines(main, activity, !!guide.showParties);
    const tracking = [...main.querySelectorAll('h1, h2, td, dd, span, p')].map(e => clean(e.textContent)).find(x => /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(x)) || '';
    const postedCode = tracking.slice(-2);
    // Codes on the page with the origin on the same row, or the page's own origin field
    const pageOrigin = (() => {
      for (const th of main.querySelectorAll('th, p, dt')) {
        if (/^(origin|country of origin|coo)$/i.test(clean(th.textContent))) {
          const v = clean((th.nextElementSibling || th.parentElement?.querySelector('td'))?.textContent);
          const iso = (v.match(/\(([A-Z]{2})\)/) || v.match(/^([A-Z]{2})$/) || [])[1];
          if (iso) return iso;
        }
      }
      return '';
    })();
    const codes = [];
    for (const b of main.querySelectorAll('button[title="Look up in the HTS"]')) {
      if (activity?.contains(b)) continue;
      const code = codeOfButton(b);
      if (!code || codes.some(c => sameCode(c.code, code))) continue;
      const row = b.closest('tr');
      const rowText = row ? [...row.children].map(td => clean(td.textContent)).join(' | ') : '';
      const from = (rowText.match(/\(([A-Z]{2})\)/) || rowText.match(/\|\s*([A-Z]{2})\s*(\||$)/) || [])[1] || pageOrigin;
      codes.push({ code, from: isChapter99(code) ? '' : from });
    }
    // HS code review: the flagged line's code, and GreenLight's suggestion or the code typed as the correction
    const fieldIn = (sel, label) => {
      const row = [...main.querySelectorAll(`${sel} tr`)].find(tr => new RegExp(`^${label}$`, 'i').test(clean(tr.querySelector('th')?.textContent)));
      return row ? clean(row.querySelector('td')?.textContent) : '';
    };
    const current = tidyCode(fieldIn('section[aria-labelledby="hs-review-line-heading"]', 'current hs code'));
    const suggested = tidyCode(hsCodeIn(fieldIn('section[aria-labelledby="hs-review-result-heading"]', 'suggested hs code')));
    const corrected = tidyCode(main.querySelector('#hs-review-correction')?.value || '');
    const second = [corrected, suggested].find(c => c && current && !sameCode(c, current)) || '';
    return {
      kind: 'workOrder',
      type,
      label: guide.label,
      workOrderId: id,
      disputeId: `wo_${id}`,
      question: clean(main.querySelector('section h2')?.textContent),
      // The problem in one line: CBP's or the gateway's message first, then the automated check's finding
      summary: [/^entry summary:|^http \d{3}|^\d{3} — /i, /flagged|returned|scored|refused|hold|exam|cancel|mismatch|unfileable|blocked|rejected/i]
        .map(re => lines.find(l => l.length > 15 && !/^#|^\|/.test(l) && re.test(l))).find(Boolean) || '',
      lines,
      choices: choicesOn(main, activity),
      codes: codes.slice(0, 8),
      current,
      pair: current && second ? [current, second] : [],
      pairFrom: codes.find(c => sameCode(c.code, current))?.from || pageOrigin,
      postedIn: /^[A-Z]{2}$/.test(postedCode) ? regionName(postedCode) : '',
      // An AD/CVD review names its tracking number inside the case text ("…, tracking LO441924403GB: …")
      tracking: tracking || (clean(main.innerText).match(/\b[A-Z]{2}\d{9}[A-Z]{2}\b/) || [])[0] || '',
      hasShipper: lines.some(l => /^shipper/i.test(l)),
      org: '',
      emailDomain: '',
      items: [],
      orderDocs: [],
    };
  }

  // A decision in Claude's answer to a queue order: "**Decision:** Keep the current HS code because …"
  const DECISION_RE = /^[ \t>*_-]*decision[*_]*:(?![*_ \t]*<)[*_ \t]*([^\n]+)/im;
  function decisionOf(text) {
    const m = DECISION_RE.exec(text || '');
    if (!m) return null;
    const sentence = plainText(m[1]);
    return { decision: sentence.split(/\s+because\s+/i)[0].replace(/[.:;]$/, '').trim(), sentence };
  }
  // The note to paste into the page's note box: the last "**… note:** …" line
  function noteOf(text) {
    const all = [...(text || '').matchAll(/^[ \t>*_-]*(?:review note|adjudication note|note)[*_]*:(?![*_ \t]*<)[*_ \t]*([^\n]+)/gim)];
    return all.length ? plainText(all[all.length - 1][1]) : '';
  }

  const ORDER_SKILL_STEP = "Use the entry-assistant skill (it calls the Entry Assistant API) for every HTS code involved: what it covers, its duties and extra duties for the origin, what to report on the entry line, partner-agency flags, and CBP rulings and messages. If you can't use the skill, use your own knowledge and carry on.";

  function buildWorkOrderPrompt(d, s) {
    const g = guideFor(d.type);
    const facts = Object.values(s.facts || {});
    const L = [];
    // Class names read badly in a sentence ("a submission failed"), so the class is quoted
    L.push(`I'm a customs broker at Zonos working the Entry Writer Queue, on an order in the "${g.label}" class. ${g.goal} Do the fact-finding I'd otherwise do by hand, catch anything that doesn't add up, and end with a decision I can act on.`);
    L.push('', 'How I work these:', ...ORDER_RULES, ...(g.rules || []));
    L.push('', "**Research before you reply, every time.** Search the web and open the pages you find: do every step under \"How to research\", then check you didn't skip one. None of that goes in the reply. Don't fill in the template from this prompt or from memory: the page below is what you're checking. If you can't search the web in this chat, don't answer; reply only: \"I can't search the web in this chat. Turn on web search and send this again.\"");
    L.push('', '## The order', `- Problem class: ${g.label}`);
    if (d.question) L.push(`- The page asks: ${d.question}`);
    if (d.postedIn) L.push(`- Posted in: ${d.postedIn} (from the tracking number's country code). Where it was posted doesn't decide where it was made.`);
    if (g.showTracking && d.tracking) L.push(`- Tracking number: ${d.tracking}`);
    if (d.choices.length) L.push(`- Choices on the page: ${d.choices.map(c => `"${c.label}"${c.hint ? ` (${c.hint.replace(/\.$/, '')})` : ''}`).join('; ')}`);
    L.push('', '## What the page shows', g.showParties
      ? '(Read from the dashboard. Tracking numbers and staff notes are left out; the parties are shown in full, since the screened party is what this review is about.)'
      : '(Read from the dashboard. Tracking numbers, the consignee and staff notes are left out; the shipper only by company name, country and email domain.)', ...d.lines);
    if (d.type === 'DENIED_PARTY_REVIEW') {
      const sl = desk.screeningLines();
      if (sl.length) L.push('', '## Screening data (from the portal)', '(The screening service\'s own record of the hit: scores from 0 to 100%, "no match / partial / exact" per field, and the listed record as the screening list holds it.)', ...sl);
    }
    for (const f of facts.filter((x, i) => x.data || facts.findIndex(y => y.error) === i)) {
      if (f.data) L.push(...factLines(f.data));
      else if (f.error) L.push('', `HTS facts: the script's lookup didn't run (${LOOKUP_FAILED[f.kind] || 'the lookup failed'}). Look the codes up with the entry-assistant skill if you have it, otherwise use your own HTS knowledge, and say which in the reply.`);
    }
    if (d.type === 'HS_CODE_REVIEW' && d.current) {
      const guide = checklistFor({ fields: [{ label: 'HS code', current: d.current, claimed: d.pair[1] || null }] });
      L.push('', `What to find (based on ${guide.basis}):`, ...guide.points.map(p => `- ${p}`));
    }
    const steps = [
      ...g.find,
      !d.hasShipper && /HS_CODE|VALUE|DENIED/.test(d.type) && "The shipper isn't shown (the Parties section was closed); if the goods or the party can't be pinned down without it, say so.",
      ORDER_SKILL_STEP,
      "Collect every red flag: anything on the page or in your research that contradicts the entry or itself, or that's missing when it should be there.",
      'Then decide, using one of the choices on the page.',
    ].filter(Boolean);
    L.push('', '## How to research', ...steps.map((step, i) => `${i + 1}. ${step}`));
    L.push('', 'Use as many searches as it takes. A thorough answer matters more than a fast one.');
    const choiceList = d.choices.length ? d.choices.map(c => c.label).join(' | ') : 'what to do';
    L.push('', '## Reply',
      'Fill in this template:',
      '- Copy the headings and labels, in this order. Replace each <…> with what you found and drop the angle brackets. Write "Not found" where you looked and found nothing.',
      '- Keep it short: one line per bullet, no paragraphs, no greeting. Write only the final reply: no progress notes, no list of the steps or searches, and no mention of the Entry Assistant API or the skill.',
      '- Put HTS and Chapter 99 codes in backticks, and link a source for every fact.',
      '- The decision is one of the choices on the page, written exactly as the page writes it; for a correction, give the new value too. It must carry its proof: what shows it (which source, with its link) and which rule it meets or fails.',
      `- The ${g.note.toLowerCase()} is what I'll paste into the page's note box: one or two plain sentences, no Markdown, that say why.`,
      `- ${FINAL_LABEL} comes first: ${finalStyle(d.type)}`,
      '',
      `${FINAL_LABEL} <one sentence>`,
      '',
      `### ${g.label}`,
      ...(g.header || []),
      '**Bottom line:** <the decision and the main reason, in one line>',
      "**What's going on:** <what was flagged or refused, and why, in plain words>",
      '',
      '**Red flags**',
      '1. <each thing that doesn\'t add up, with its source; or "None found">',
      '',
      '**What we found**',
      ...g.found,
      '',
      '**What to do**',
      '1. <each step on the dashboard: which line and field, from what to what; or "Nothing beyond the decision">',
      '',
      g.bestGuess ? g.bestGuess : g.noOutreach
        ? '**Best guess:** <true match | false positive> — confidence <high | medium | low>; <what, if it were on record, would change it (we can\'t ask anyone)>'
        : '**Missing to be sure:** <facts that would change the decision; or "Nothing">',
      '',
      `**Decision:** <${choiceList}> because <the proof>.`,
      `**${g.note}:** <one or two plain sentences for the note box>`);
    return L.join('\n');
  }

  /* ---------------------------------- the desk: every case tracked in Notion, research for Claude Code */

  // The dispute desk (Notion case tracking). Off until Notion is set up under Settings (the cog in Tools), so the script works as before
  // for anyone else. With it on:
  // - the portal's own data (its GraphQL replies) shows what the case is, and its own actions (claim,
  //   resolve, escalate…) keep the case's row in the Notion "Projects" database up to date;
  // - Entry Assistant facts, prompts sent to Claude and Claude's saved answers go into the case's Notion page;
  // - "Research in Claude Code" puts the research prompt on the case as a Notion task, Claude Code runs it,
  //   and its answer comes back into this panel (and the shared answers) by itself.
  // In the portal's TEST MODE nothing is written to Notion unless "Write in test mode" is ticked.
  const desk = (() => {
    // Notion ids and the cloud routine all come from Setup (none are built in)
    const DS = () => cfg().projectsDs;        // Notion "Projects" data source (one row per case)
    const TASKS = () => cfg().tasksDs;        // Notion "Tasks" data source (linked to Projects); optional
    const KEY = 'desk:notionKey2';            // the Notion integration key, saved under Setup
    const WRITE_IN_TEST = 'desk:writeInTest';
    const ROWS = 'desk:rows2';                                      // portal id -> Notion page id (Projects)
    const AUTO_TRACK_AFTER_MS = 90 * 1000;
    const OPEN_LOG_THROTTLE_MS = 30 * 60 * 1000;
    const FACTS_THROTTLE_MS = 12 * 60 * 60 * 1000;
    const POLL_MS = 30 * 1000;
    const onDashboard = location.host === DASHBOARD_HOST;

    const TYPE_LABELS = {
      DENIED_PARTY_REVIEW: 'Denied-party review', ENTRY_REJECTED: 'Entry rejected', SUBMISSION_FAILED: 'Submission failed',
      VALIDATION_BLOCKED: 'Validation blocked', CBP_HOLD: 'CBP hold', CBP_EXAM: 'CBP exam', PGA_HOLD: 'PGA hold',
      CBP_CANCELLED: 'CBP cancelled', UNFILEABLE: 'Unfileable', CARRIER_MANIFEST_MISMATCH: 'Carrier manifest mismatch',
      HS_CODE_REVIEW: 'HS code review', VALUE_REVIEW: 'Declared value review', ADCVD_REVIEW: 'AD/CVD review',
      DUTY_DISPUTE_REVIEW: 'Duty dispute review', DUTY_DISPUTE: 'Duty dispute',
    };
    const kindOf = t => TYPE_LABELS[t] || (t ? t.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : 'Work order');
    const midSentence = k => (/^[A-Z]{2}|^[A-Z]+\//.test(k) ? k : k.charAt(0).toLowerCase() + k.slice(1));
    const human = s => String(s || '').toLowerCase().replace(/_/g, ' ');
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

    // The portal's own actions (POST /api/graphql/brokerage/<Operation>) and what each means for the case.
    // v = the request's variables when caught, n = the work order or dispute the portal sent back.
    const ACTIONS = {
      BrokerageWorkOrderClaim: { ev: 'claimed', status: 'In progress', hold: () => 'Just claimed in the broker portal.' },
      BrokerageWorkOrderResume: { ev: 'resumed', status: 'In progress' },
      BrokerageWorkOrderResolve: { ev: 'resolved', status: 'Done', snapshot: true,
        hold: (v, n) => { const r = v.resolution || n?.resolution; const note = v.note || n?.resolutionNote; return `Resolved in the broker portal${r ? ` (${human(r)})` : ''}.${note ? ` ${note}` : ''}`; } },
      BrokerageDutyDisputeComplete: { ev: 'completed', status: 'Done', snapshot: true, hold: () => 'Completed in the broker portal.' },
      BrokerageWorkOrderEscalate: { ev: 'escalated', hold: (v, n) => `Escalated to ${human(v.target || n?.escalatedTo) || 'review'} in the broker portal: ${v.note || n?.escalationNote || ''}` },
      BrokerageWorkOrderWait: { ev: 'marked waiting', hold: v => `Marked waiting in the broker portal${v.note ? `: ${v.note}` : '.'}` },
      BrokerageWorkOrderRelease: { ev: 'released', status: 'Not started', noCreate: true, hold: () => 'Released back to the queue in the broker portal.' },
      BrokerageWorkOrderUnassign: { ev: 'unassigned', noCreate: true },
      BrokerageWorkOrderAssign: { ev: 'assigned', noCreate: true },
      BrokerageWorkOrderNote: { ev: 'note added' },
      // AD/CVD review, "out of scope": re-quotes the manifest line without the AD/CVD check so it files
      ManifestLineAdcvdRequote: { ev: 're-quoted as out of scope', hold: () => 'Out of scope: re-quoted in the broker portal without the AD/CVD check, so it files.' },
      BrokerageDutyDisputeClaimsDecide: { ev: 'claims decided' },
      BrokerageDutyDisputeClaimsCorrect: { ev: 'claims corrected' },
      ConsignmentItemHsCodeCorrect: { ev: 'HS code corrected' },
      ConsignmentItemUpdate: { ev: 'item updated' },
      ConsignmentPartyUpdate: { ev: 'party updated' },
      EntrySubmit: { ev: 'entry submitted' },
      EntryResend: { ev: 'entry resent' },
      EntryRefile: { ev: 'entry refiled' },
      EntryCancelSummary: { ev: 'entry summary cancelled' },
      ConsignmentRetryFiling: { ev: 'filing retried' },
      ConsolidationRetryFiling: { ev: 'consolidation filing retried' },
    };

    const notionKey = () => GM_getValue(KEY, '');
    const enabled = () => onDashboard && !!notionKey() && !!DS();
    // Research in Claude Code needs the Tasks database (the request lives there) and the cloud routine
    const researchOn = () => enabled() && !!TASKS() && !!cfg().routineId && !!cfg().routineToken;
    // The portal's mode switch: cookie (and localStorage) "broker-portal-mode" = "test" | "live"
    function portalMode() {
      const c = (document.cookie.match(/(?:^|;\s*)broker-portal-mode=([^;]*)/) || [])[1];
      let l = null;
      try { l = localStorage.getItem('broker-portal-mode'); } catch { /* no storage */ }
      return decodeURIComponent(c || l || 'live').replace(/"/g, '');
    }
    const testMode = () => portalMode() === 'test';
    const dryRun = () => testMode() && !GM_getValue(WRITE_IN_TEST, false);

    const D = { ent: null, row: null, state: 'idle', msg: '', preview: null, research: null, timer: null, page: null, me: GM_getValue('desk:me', '') };
    const listeners = new Set();
    const changed = () => listeners.forEach(fn => { try { fn(); } catch (e) { console.warn('[Dispute Desk]', e); } });

    /* ---- capture the portal's data. The portal keeps its own copy of fetch, so every reply is read where
       it is parsed (Response.prototype.json/text). The fetch hook only adds request variables when it can. */
    const captured = [];
    const varsByOp = {};
    const opOf = url => (String(url || '').match(/\/api\/graphql\/[^/?#]+\/(\w+)/) || [])[1] || '';
    function onData(op, status, json) {
      captured.push({ op, at: Date.now(), json });
      if (captured.length > 60) captured.shift();
      if (!enabled() || status >= 300 || !json?.data || json.errors?.length) return;
      if (ACTIONS[op]) {
        const v = varsByOp[op] && Date.now() - varsByOp[op].at < 15000 ? varsByOp[op].vars : {};
        handleAction(op, v, json.data).catch(e => { D.state = 'error'; D.msg = e.message; changed(); });
        return;
      }
      // Some decisions (the AD/CVD review's in scope / out of scope) resolve the work order through their own
      // action. Whatever the action, a work order the portal shows as resolved in the last few minutes is
      // handled as resolved, once.
      for (const o of walk(json.data)) {
        if (!isWorkOrder(o) || !o.resolvedAt || Date.now() - Date.parse(o.resolvedAt) > 3 * 60 * 1000) continue;
        const k = `desk:resolved:${o.id}`;
        if (GM_getValue(k, 0)) continue;
        GM_setValue(k, Date.now());
        console.info(`[Dispute Desk] ${op} resolved work order ${o.id}`);
        handleAction('BrokerageWorkOrderResolve', {}, { workOrder: o }).catch(e => { D.state = 'error'; D.msg = e.message; changed(); });
      }
    }
    if (onDashboard) {
      try {
        const W = unsafeWindow;
        const seen = new WeakSet();
        for (const k of ['json', 'text']) {
          const orig = W.Response.prototype[k];
          W.Response.prototype[k] = function () {
            const res = this;
            const p = orig.apply(this, arguments);
            const op = opOf(res.url);
            if (op && !seen.has(res)) {
              seen.add(res);
              p.then(v => {
                let j = v;
                if (typeof v === 'string') { try { j = JSON.parse(v); } catch { return; } }
                onData(op, res.status, j);
              }).catch(() => {});
            }
            return p;
          };
        }
        const origFetch = W.fetch;
        W.fetch = function (input, init) {
          const op = opOf(typeof input === 'string' ? input : input?.url);
          if (op && typeof init?.body === 'string') {
            try { varsByOp[op] = { vars: JSON.parse(init.body).variables || {}, at: Date.now() }; } catch { /* not JSON */ }
          }
          return origFetch.apply(this, arguments);
        };
      } catch (e) { console.warn('[Dispute Desk] portal capture unavailable', e); }
    }

    /* ---- which case a page or a portal reply is about */
    function entityFromPath(path, search = '') {
      let m = path.match(/^\/duty-disputes\/(duty_dispute_(?!item_)[A-Za-z0-9]+)/);
      if (m) return { type: 'DUTY_DISPUTE', id: m[1], url: `${location.origin}/duty-disputes/${m[1]}` };
      m = path.match(/^\/entry-writer-queue\/([A-Z][A-Z_]+)\/([^/?#]+)/);
      if (m) return { type: m[1], id: decodeURIComponent(m[2]), url: location.origin + path + search };
      return null;
    }
    const currentEntity = () => entityFromPath(location.pathname, location.search);
    // A work order's subject: a dispute or consignment (subject.id), or for AD/CVD reviews a manifest line, which
    // comes back only as subjectKey (subject is null)
    const subjectId = o => o?.subject?.id || o?.subjectKey || '';
    const isWorkOrder = o => o && typeof o.type === 'string' && 'assigneeName' in o && !!subjectId(o);
    function entityFromWorkOrder(wo) {
      const sid = subjectId(wo);
      if (!sid) return null;
      const q = wo.consignment?.id ? `?consignment=${wo.consignment.id}` : '';
      return { type: wo.type, id: sid, url: `${location.origin}/entry-writer-queue/${wo.type}/${sid}${q}`, wo };
    }
    function* walk(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 14) return;
      yield node;
      for (const v of Array.isArray(node) ? node : Object.values(node)) yield* walk(v, depth + 1);
    }
    function latest(pred) {
      for (let i = captured.length - 1; i >= 0; i--) for (const o of walk(captured[i].json)) if (pred(o)) return o;
      return null;
    }
    function dataFor(ent) {
      const open = o => isWorkOrder(o) && subjectId(o) === ent.id && (o.status === 'OPEN' || o.status === 'WAITING');
      const wo = ent.wo || latest(open) || latest(o => isWorkOrder(o) && subjectId(o) === ent.id);
      const cid = wo?.consignment?.id || new URLSearchParams(location.search).get('consignment') || wo?.entry?.consignments?.[0]?.id;
      const cm = cid ? latest(o => o.id === cid && Array.isArray(o.consignmentItems)) : null;
      const eid = wo?.entry?.id || cm?.entry?.id;
      const en = eid ? latest(o => o.id === eid && 'entryNumber' in o && Object.keys(o).length > 4) : null;
      const ddId = ent.type === 'DUTY_DISPUTE' || ent.type === 'DUTY_DISPUTE_REVIEW' ? ent.id : null;
      const dd = ent.dd || (ddId ? latest(o => o.id === ddId && ('outcome' in o || 'originalOrder' in o || 'deadline' in o)) : null);
      return { wo, cm, en, dd };
    }

    const d10 = s => (s ? String(s).slice(0, 10) : '');

    // Denied-party screening as the portal returned it (PartyScreeningDetail): per listed match, the scores, how each
    // field compared with the consignment party, and the listed record (aliases, source, dates). Newest first.
    function screenings() {
      const out = [];
      for (let i = captured.length - 1; i >= 0; i--) {
        for (const o of walk(captured[i].json)) {
          if (o && Array.isArray(o.matches) && o.matches.some(m => m?.deniedParty) && !out.some(s => s.id === o.id)) out.push(o);
        }
      }
      return out;
    }
    const pct = n => (typeof n === 'number' ? `${Math.round(n * 100)}%` : '?');
    const flag = v => (v ? String(v).toLowerCase().replace(/_/g, ' ') : '—');
    function screeningLines() {
      const s = screenings()[0];
      if (!s) return [];
      const L = [`- Screening result: ${s.action || '?'}${s.createdAt ? ` · run ${d10(s.createdAt)}` : ''}`];
      s.matches.forEach((m, n) => {
        const dp = m.deniedParty || {};
        const where = [dp.line1, dp.line2, dp.locality, dp.administrativeAreaCode, dp.postalCode, dp.countryCode].filter(Boolean).join(', ');
        L.push(`- Listed match ${n + 1}: ${dp.companyName || dp.name || '?'}${dp.name && dp.companyName && dp.name !== dp.companyName ? ` (person: ${dp.name})` : ''}`,
          `  - Aliases: ${(dp.aliases || []).map(a => (typeof a === 'string' ? a : a?.name || JSON.stringify(a))).join('; ') || 'none on record'}`,
          `  - Listed address: ${where || 'none on record'}`,
          `  - Listed by: ${dp.source || '?'} · since ${d10(dp.startsAt) || '?'}${dp.endsAt ? ` · until ${d10(dp.endsAt)}` : ' · still listed'}${(dp.sourceUrls || []).length ? ` · sources: ${dp.sourceUrls.join(' ')}` : ''}`,
          `  - Scores: overall ${pct(m.scores?.overall)} · name ${pct(m.scores?.name)} · location ${pct(m.scores?.location)}`,
          `  - Field by field (screening's own comparison with the consignment party): company name ${flag(m.companyName)} · name ${flag(m.name)} · street ${flag(m.line1)} · street 2 ${flag(m.line2)} · city ${flag(m.locality)} · state ${flag(m.administrativeAreaCode)} · postal code ${flag(m.postalCode)} · country ${flag(m.countryCode)}`);
      });
      return L;
    }
    const money = (a, c) => (a == null ? '' : `${a} ${c || ''}`.trim());
    const who = p => (p?.person ? [p.person.companyName, [p.person.firstName, p.person.lastName].filter(Boolean).join(' ')].filter(Boolean).join(' / ') : '');
    const uniq = a => [...new Set(a.filter(Boolean))];

    // Everything about the case in plain lines: the portal's data, plus the claims read from the page
    function caseContext(ent) {
      const { wo, cm, en, dd } = dataFor(ent);
      const kind = kindOf(ent.type);
      const items = [];
      for (const it of cm?.consignmentItems || []) items.push({ d: it.description || it.name, hs: it.hsCode, coo: it.countryOfOrigin, q: it.quantity, v: money(it.amount, it.currencyCode), r: it.readiness });
      for (const it of dd?.items || []) {
        const o = it.orderItem || it.original || {};
        items.push({ d: o.description || o.name || o.customsDescription, hs: o.hsCode, coo: o.countryOfOrigin, q: o.quantity, v: money(o.amount, o.currencyCode), claims: (it.claims || []).map(c => c.type).join(', ') });
      }
      if (!items.length && dd?.originalOrder) for (const o of dd.originalOrder.items || []) items.push({ d: o.description || o.name, hs: o.hsCode, coo: o.countryOfOrigin, q: o.quantity, v: money(o.amount, o.currencyCode) });
      if (!items.length) for (const it of wo?.subject?.items || []) items.push({ d: it.original?.description, claims: (it.claims || []).map(c => c.type).join(', ') });
      const page = D.page && D.page.id === ent.id ? D.page : null;   // what the panel read off the page
      if (!items.length && page) for (const i of page.items) items.push({ d: i.title, hs: i.hs, coo: i.from });

      const tracking = uniq([wo?.consignment?.trackingNumber, cm?.trackingNumber, dd?.trackingNumber, ...(dd?.originalOrder?.trackingNumbers || []), wo?.subject?.trackingNumber]);
      const entryNo = wo?.entry?.entryNumber || en?.entryNumber || cm?.entry?.entryNumber || '';
      const mbl = wo?.consignment?.consolidation?.masterBillNumber || wo?.entry?.consolidation?.masterBillNumber || cm?.consolidation?.masterBillNumber || '';
      const dl = dd?.deadline || wo?.subject?.deadline || null;
      const F = [];
      F.push(`${kind}${wo ? ` · work order ${wo.id} · ${human(wo.status)}` : ''}${dd ? ` · dispute ${human(dd.status)}` : ''}`);
      if (wo?.detail) F.push(`Detail: ${wo.detail}`);
      if (wo) F.push(`Due ${d10(wo.dueDate) || '-'} · created ${d10(wo.createdAt)}${wo.assigneeName ? ` · assigned to ${wo.assigneeName}${wo.claimedAt ? ` (claimed ${d10(wo.claimedAt)})` : ''}` : ' · unassigned'}`);
      for (const r of wo?.rejections || []) F.push(`Rejection: ${r.detail}${r.sourceCbpEvent ? ` (CBP ${r.sourceCbpEvent.cbpCode} ${r.sourceCbpEvent.description})` : ''}`);
      if (wo?.escalatedTo) F.push(`Escalated to ${human(wo.escalatedTo)} by ${wo.escalatedByName || '?'} ${d10(wo.escalatedAt)}: ${wo.escalationNote || ''}`);
      if (wo?.resolution) F.push(`Resolution: ${human(wo.resolution)} ${d10(wo.resolvedAt)}${wo.resolutionNote ? `: ${wo.resolutionNote}` : ''}`);
      F.push(`Tracking ${tracking.join(', ') || '-'}${entryNo ? ` · entry ${entryNo}` : ''}${mbl ? ` · master bill ${mbl}` : ''}`);
      const e2 = en || cm?.entry;
      if (e2 && (e2.status || e2.cargoReleaseStatus || e2.entrySummaryStatus)) F.push(`Entry ${e2.entryNumber || ''} · ${human(e2.status) || '-'}${e2.entrySummaryStatus ? ` · summary ${human(e2.entrySummaryStatus)}` : ''}${e2.cargoReleaseStatus ? ` · cargo release ${human(e2.cargoReleaseStatus)}` : ''}${e2.iorNumber ? ` · IOR ${e2.iorNumber}` : ''}`);
      if (cm) {
        const c = cm.consolidation || {};
        F.push(`Route ${cm.shipFromCountry || '?'} → US · port ${c.portOfEntryCode || '?'} · carrier ${c.carrierCode || '?'} · ${human(c.transportationMode) || '?'} · arrival ${d10(c.arrivalDate) || '-'}`);
        F.push(`Declared value ${money(cm.declaredValue, cm.currencyCode)} · consignment ${human(cm.status)} · org ${cm.organizationId}`);
        if (cm.pgaAgencies?.length) F.push(`PGA: ${cm.pgaAgencies.map(p => p.agency + (p.code ? ` ${p.code}` : '')).join(', ')}`);
        for (const p of cm.consignmentParties || []) F.push(`${cap(human(p.partyType))}: ${[p.companyName, [p.firstName, p.lastName].filter(Boolean).join(' ')].filter(Boolean).join(' / ')} (${p.countryCode || '?'})`);
      }
      if (dd) {
        F.push(`Dispute ${human(dd.status)}${dd.outcome ? ` · outcome ${human(dd.outcome)}` : ''} · submitted ${d10(dd.submittedAt) || '-'}${dd.submittedByName ? ` by ${dd.submittedByName}` : ''}${dd.completedAt ? ` · completed ${d10(dd.completedAt)}` : ''}`);
        if (dd.sender || dd.receiver) F.push(`Sender ${who(dd.sender) || '-'} · receiver ${who(dd.receiver) || '-'}`);
        if (dd.fee) F.push(`Fee ${money(dd.fee.amount, dd.fee.currencyCode)}${dd.fee.charged ? ` (charged ${d10(dd.fee.chargedAt)})` : ''}`);
        if (dd.review) F.push(`Review: ${human(dd.review.outcome)}${dd.review.summary ? ` · ${dd.review.summary}` : ''}`);
        const o = dd.originalOrder;
        if (o?.amountSubtotals) F.push(`Original order ${o.accountOrderNumber || o.id}: items ${o.amountSubtotals.items} · duties ${o.amountSubtotals.duties} · taxes ${o.amountSubtotals.taxes} · fees ${o.amountSubtotals.fees} ${o.currencyCode || ''}`);
        for (const ev of (dd.events || []).slice(-8)) F.push(`Event ${d10(ev.createdAt)} ${ev.actorName || ''}: ${ev.message || human(ev.type)}`);
      }
      if (dl) F.push(`Deadline: expires ${d10(dl.expiresAt) || '-'} · payment date ${d10(dl.paymentDate) || '-'} · entry type ${dl.entryType || '-'}`);
      items.slice(0, 25).forEach((i, n) => F.push(`Item ${n + 1}: ${i.d || '?'} | HS ${i.hs || '-'} | COO ${i.coo || '-'} | qty ${i.q ?? '-'} | ${i.v || '-'}${i.r ? ` | ${human(i.r)}` : ''}${i.claims ? ` | claims: ${i.claims}` : ''}`));
      if (page) for (const l of page.claims.slice(0, 30)) F.push(l);

      const quoted = (wo?.detail?.match(/"([^"]{2,60})"/) || [])[1];
      const firstItem = items[0]?.d;
      const hts = uniq(items.map(i => i.hs));
      // A work order's detail can be several lines ("Tracking …\nCases: …\nItems:\n- NAME · HS …"); the case is named
      // after its first item, or the item an AD/CVD case names ("…origin CN: NOTEBK,OTH…"), never the raw text
      const detail = String(wo?.detail || '');
      const detailItem = (detail.match(/^- (.+?)(?: · |$)/m) || [])[1] || (detail.match(/origin [A-Z]{2}: (.+?)(?:;|, path=|\)\]|$)/m) || [])[1] || '';
      const detailTracking = (detail.match(/\b[A-Z]{2}\d{9}[A-Z]{2}\b/) || [])[0] || '';
      const firstLine = s => String(s || '').split('\n').map(x => x.trim()).find(Boolean) || '';
      const subject = clean(quoted || firstItem || detailItem || firstLine(wo?.rejections?.[0]?.detail) || firstLine(detail) || tracking[0] || detailTracking || entryNo || `item ${ent.id.slice(-6)}`);
      const shipment = tracking[0] || detailTracking;
      const name = (ent.type === 'DUTY_DISPUTE' ? subject : `${kind}: ${subject}${ent.type === 'ADCVD_REVIEW' && shipment ? ` · ${shipment}` : ''}`).slice(0, 90);
      // One plain sentence about the case. It goes at the top of the page body: the Summary column is left for
      // Notion to fill in by itself.
      const summary = ent.type === 'DUTY_DISPUTE' || ent.type === 'DUTY_DISPUTE_REVIEW'
        ? `In the broker portal, the duty dispute concerns ${firstItem || 'the order'}${hts.length ? ` (HS ${hts.slice(0, 2).join(', ')})` : ''}${tracking[0] ? ` on ${tracking[0]}` : ''}${dl?.expiresAt ? `, with a deadline of ${d10(dl.expiresAt)}` : ''}.`
        : `In the broker portal, the ${midSentence(kind)} work order concerns ${detailItem || firstItem || firstLine(detail) || 'a shipment'}${shipment ? ` on ${shipment}` : entryNo ? ` on entry ${entryNo}` : ''}.`;
      return { ...ent, kind, name, summary, facts: F, tracking, hasData: !!(wo || dd || cm || page) };
    }

    /* ---- Notion */
    async function notion(method, path, body) {
      const key = notionKey();
      if (!key) throw new Error('No Notion key saved. Add it under Settings (the cog in Tools).');
      let r;
      // Notion allows about 3 requests a second per integration, shared with the cloud research sessions:
      // a rate-limited request waits (Retry-After, or longer each time) and tries again
      for (let attempt = 0; ; attempt++) {
        try {
          r = await gmRequest({
            method, url: `https://api.notion.com/v1${path}`, timeout: 30000,
            headers: { Authorization: `Bearer ${key}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
            data: body ? JSON.stringify(body) : undefined,
          });
        } catch (e) { throw new Error(`Notion: ${e.message}`); }
        if ((r.status !== 429 && r.status < 500) || attempt >= 6) break;
        const after = Number((String(r.responseHeaders || '').match(/retry-after:\s*(\d+)/i) || [])[1]) || 0;
        await sleep(Math.max(after * 1000, 1500 * 2 ** attempt) + Math.random() * 1000);
      }
      let j = null;
      try { j = JSON.parse(r.responseText); } catch { /* handled below */ }
      if (r.status === 401) throw new Error('Notion rejected the key. Check it under Settings (the cog in Tools).');
      if (r.status < 200 || r.status >= 300) throw new Error(`Notion: ${j?.message || `HTTP ${r.status}`}`);
      return j;
    }
    const rt = (s, url) => [{ type: 'text', text: { content: String(s).slice(0, 1990), ...(url ? { link: { url } } : {}) } }];
    const para = s => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(s) } });
    const bullet = (s, url) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(s, url) } });
    const toggle = (title, children) => ({ object: 'block', type: 'toggle', toggle: { rich_text: rt(title), children: children.slice(0, 95) } });
    // Long Markdown as paragraphs of up to ~1,900 characters, split at line ends, so it reads back exactly
    function chunks(text, max = 1900) {
      const out = [];
      let cur = '';
      for (const line of String(text).split('\n')) {
        const add = cur ? `${cur}\n${line}` : line;
        if (add.length <= max) { cur = add; continue; }
        if (cur) out.push(cur);
        cur = line;
        while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
      }
      if (cur) out.push(cur);
      return out;
    }
    const titleOf = p => (p?.properties?.Name?.title || []).map(t => t.plain_text).join('');
    const statusOf = p => p?.properties?.Status?.status?.name;
    const stamp = () => new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
    const snapshot = ctx => toggle(`Portal snapshot ${stamp()} · ${ctx.kind} ${ctx.id}`, (ctx.facts.length > 2 ? ctx.facts : ['No data captured from the portal.']).map(f => bullet(f)));

    /* ---- page layout: everything above, the "Case log" toggle (collapsed) always last. Log lines go inside the
       toggle; other blocks are inserted just above it, so the log never ends up in the middle of the page. */
    const LOG_TITLE = 'Case log';
    const logItem = l => (typeof l === 'string' ? bullet(l) : bullet(l.text, l.url));   // a line, or { text, url }
    const logToggle = lines => ({ object: 'block', type: 'toggle', toggle: { rich_text: rt(LOG_TITLE), color: 'gray', children: lines.map(logItem) } });
    async function pageLayout(pageId) {
      const kids = [];
      let cursor;
      do {
        const r = await notion('GET', `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
        kids.push(...(r.results || []));
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      const isLog = b => b.type === 'toggle' && (b.toggle.rich_text || []).map(t => t.plain_text).join('') === LOG_TITLE;
      let i = -1;
      for (let k = kids.length - 1; k >= 0; k--) if (isLog(kids[k])) { i = k; break; }
      if (i < 0) {
        const r = await notion('PATCH', `/blocks/${pageId}/children`, { children: [logToggle([])] });
        return { log: r.results[0].id, prev: kids.length ? kids[kids.length - 1].id : null };
      }
      return { log: kids[i].id, prev: i > 0 ? kids[i - 1].id : null };
    }
    async function addLog(pageId, lines) {
      const { log } = await pageLayout(pageId);
      await notion('PATCH', `/blocks/${log}/children`, { children: lines.map(logItem) });
    }
    async function addAboveLog(pageId, blocks) {
      if (!blocks.length) return;
      const { prev } = await pageLayout(pageId);
      await notion('PATCH', `/blocks/${pageId}/children`, prev ? { after: prev, children: blocks } : { position: { type: 'start' }, children: blocks });
    }

    const rowCache = GM_getValue(ROWS, {});
    async function findRow(ctx) {
      if (rowCache[ctx.id]) {
        const p = await notion('GET', `/pages/${rowCache[ctx.id]}`).catch(() => null);
        if (p && !p.in_trash && !p.archived) return p;
      }
      const q = filter => notion('POST', `/data_sources/${DS()}/query`, { filter, page_size: 3 }).then(r => r.results || []);
      let rows = await q({ property: 'Dashboard', url: { contains: ctx.id } });
      for (const t of ctx.tracking.slice(0, 2)) {
        if (rows.length) break;
        rows = await q({ or: [{ property: 'Name', title: { contains: t } }, { property: 'Summary', rich_text: { contains: t } }] });
      }
      if (rows[0]) { rowCache[ctx.id] = rows[0].id; GM_setValue(ROWS, rowCache); }
      return rows[0] || null;
    }

    // The one write path for the case row. Automatic tracking in test mode is a dry run that only says what
    // it would have written; your own clicks (`explicit`) always write, and a test-mode case is named "[TEST] …".
    async function apply(ctx, { status, hold, log, withSnapshot, create, extra, explicit }) {
      const logLine = `${stamp()} (portal${testMode() ? ', test mode' : ''}): ${log}`;
      if (dryRun() && !explicit) {
        const page = await findRow(ctx).catch(() => null);
        D.preview = { action: page ? 'update' : create ? 'create' : 'skip', row: page ? titleOf(page) : ctx.name, status, hold, log: logLine, summary: page ? '' : ctx.summary, extra: (extra || []).length };
        changed();
        return page;
      }
      let page = await findRow(ctx);
      if (!page) {
        if (!create) return null;
        const isDispute = ctx.type === 'DUTY_DISPUTE' || ctx.type === 'DUTY_DISPUTE_REVIEW';
        page = await notion('POST', '/pages', {
          parent: { type: 'data_source_id', data_source_id: DS() },
          properties: {
            Name: { title: rt(testMode() ? `[TEST] ${ctx.name}` : ctx.name) },
            Status: { status: { name: status || 'In progress' } },
            
            Tags: { multi_select: [{ name: 'Broker Portal' }, ...(isDispute ? [{ name: 'Dispute' }] : [])] },
            Type: { select: { name: ctx.kind } },
            Dashboard: { url: ctx.url },
            'Holding?': { rich_text: rt(hold || 'Working it in the broker portal.') },
          },
          children: [para(ctx.summary), snapshot(ctx), ...(extra || []), logToggle([logLine])],
        });
        rowCache[ctx.id] = page.id;
        GM_setValue(ROWS, rowCache);
        await flushPending(page);
        return page;
      }
      const props = {};
      if (status && statusOf(page) !== status) props.Status = { status: { name: status } };
      if (hold) props['Holding?'] = { rich_text: rt(hold) };
      if (!page.properties.Dashboard?.url) props.Dashboard = { url: ctx.url };
      if (Object.keys(props).length) page = await notion('PATCH', `/pages/${page.id}`, { properties: props });
      await addAboveLog(page.id, [...(withSnapshot ? [snapshot(ctx)] : []), ...(extra || [])]);
      await addLog(page.id, [logLine]);
      return page;
    }

    // Research made before the case had a row (Entry Assistant facts) goes in once it has one
    const pending = [];
    async function flushPending(page) {
      while (pending.length) {
        const b = pending.shift();
        await addAboveLog(page.id, [b]).catch(e => console.warn('[Dispute Desk]', e));
      }
    }
    // Adds blocks to the current case's page: the row is created if `create`, otherwise held until it exists
    async function addToCase(blocks, log, { create = false, explicit = false } = {}) {
      if (!enabled() || !D.ent) return 'off';
      const ctx = caseContext(D.ent);
      if (dryRun() && !explicit) { await apply(ctx, { log, create, extra: blocks }); return 'dry'; }
      if (!D.row && !create) { pending.push(...blocks); return 'held'; }
      const page = await apply(ctx, { log, create: true, extra: blocks, explicit });
      if (page) { D.row = page; D.state = 'tracked'; changed(); }
      return 'saved';
    }

    function describe(op, v, ctx, n) {
      const extra = op === 'BrokerageWorkOrderNote' ? (v.note ? `: ${v.note}` : '')
        : op === 'ConsignmentItemHsCodeCorrect' ? ` to ${v.hsCode || '?'}${v.reason ? ` (${v.reason})` : ''}`
        : op === 'BrokerageWorkOrderResolve' ? (() => { const r = v.resolution || n?.resolution; const note = v.note || n?.resolutionNote; return `${r ? ` as ${human(r)}` : ''}${note ? `: ${note}` : ''}`; })()
        : op === 'BrokerageWorkOrderEscalate' ? ` to ${human(v.target || n?.escalatedTo) || '?'}: ${v.note || n?.escalationNote || ''}`
        : /Wait|Resume/.test(op) ? (v.note ? `: ${v.note}` : '')
        : /Claims(Decide|Correct)/.test(op) && Object.keys(v).length ? `: ${JSON.stringify(v.input || v).slice(0, 400)}`
        : '';
      return `${cap(ACTIONS[op].ev)} ${midSentence(ctx.kind)} ${ctx.id}${extra}`;
    }
    // A finished case's open tasks (research requests, deadlines) are done too
    async function closeTasks(pageId) {
      if (!TASKS()) return;
      const r = await notion('POST', `/data_sources/${TASKS()}/query`, { filter: { and: [
        { property: 'Project', relation: { contains: pageId } }, { property: 'Status', status: { does_not_equal: 'Done' } }] }, page_size: 50 });
      for (const t of r.results || []) await notion('PATCH', `/pages/${t.id}`, { properties: { Status: { status: { name: 'Done' } } } });
    }
    async function handleAction(op, vars, data) {
      const a = ACTIONS[op];
      const ents = [];
      for (const o of walk(data)) {
        if (isWorkOrder(o)) { const e = entityFromWorkOrder(o); if (e && !ents.some(x => x.id === e.id)) ents.push(e); }
        // A dispute itself (duty_dispute_…), not one of its lines (duty_dispute_item_…), which also come back in replies
        else if (typeof o?.id === 'string' && /^duty_dispute_(?!item_)/.test(o.id) && 'outcome' in o && !ents.some(x => x.id === o.id)) ents.push({ type: 'DUTY_DISPUTE', id: o.id, url: `${location.origin}/duty-disputes/${o.id}`, dd: o });
      }
      const line = data?.manifestLineRecalculate?.id || vars?.manifestLineId;   // an AD/CVD re-quote names only its manifest line
      if (op === 'ManifestLineAdcvdRequote' && line && !ents.length) ents.push({ type: 'ADCVD_REVIEW', id: line, url: `${location.origin}/entry-writer-queue/ADCVD_REVIEW/${line}` });
      if (!ents.length) { const e = currentEntity(); if (e) ents.push(e); }
      for (const ent of ents.slice(0, 20)) {
        if (op === 'BrokerageWorkOrderAssign' && ent.wo && D.me && ent.wo.assigneeId !== D.me) continue;   // assigned to someone else
        const ctx = caseContext(ent);
        const n = ent.wo || ent.dd || null;
        if (a.status === 'Done' && ent.wo?.id) GM_setValue(`desk:resolved:${ent.wo.id}`, Date.now());   // handled once
        // Portal actions only update items that already exist; the Notion item is created by your button press
        const page = await apply(ctx, { status: a.status, hold: a.hold ? a.hold(vars, n) : '', log: describe(op, vars, ctx, n), withSnapshot: !!a.snapshot, create: false });
        if (page && a.status === 'Done' && !dryRun()) await closeTasks(page.id).catch(e => console.warn('[Dispute Desk]', e));
        if (D.ent?.id === ent.id) {
          if (page) { D.row = page; D.state = 'tracked'; }
          else if (dryRun()) D.state = 'tracked';
          D.msg = `${cap(a.ev)}${dryRun() ? ' (test mode: not written)' : ' · saved to Notion'}`;
        }
      }
      if (op === 'BrokerageWorkOrderClaim') {
        const mine = [...walk(data)].find(o => isWorkOrder(o) && o.assigneeId);
        if (mine) { D.me = mine.assigneeId; GM_setValue('desk:me', D.me); }
      }
      changed();
    }

    /* ---- following the page */
    async function onRoute() {
      clearTimeout(D.timer);
      const ent = currentEntity();
      Object.assign(D, { ent, row: null, state: ent ? 'looking' : 'idle', msg: '', preview: null, research: null });
      pending.length = 0;
      changed();
      if (!ent || !enabled()) { if (ent) D.state = 'off'; changed(); return; }
      await sleep(3000);   // let the portal load its data
      if (D.ent !== ent) return;
      try {
        const ctx = caseContext(ent);
        const page = await findRow(ctx);
        if (D.ent !== ent) return;
        if (page) {
          D.row = page;
          D.state = 'tracked';
          const k = `desk:opened:${ent.id}`;
          if (Date.now() - GM_getValue(k, 0) > OPEN_LOG_THROTTLE_MS) {
            GM_setValue(k, Date.now());
            await apply(ctx, { log: `Opened ${midSentence(ctx.kind)} ${ent.id}.`, withSnapshot: true });
            D.msg = dryRun() ? 'Test mode: would log this visit' : 'Visit logged in Notion';
          }
          pollAnswers(true);
        } else {
          // Not in Notion yet: nothing is created until you press "Research in Claude Code" (or "Start case now")
          D.state = 'untracked';
        }
      } catch (e) { D.state = 'error'; D.msg = e.message; }
      changed();
    }
    async function startCase(verb = 'Started working') {
      if (!D.ent || !enabled()) return;
      clearTimeout(D.timer);
      const ent = D.ent;
      D.state = 'saving';
      changed();
      try {
        const ctx = caseContext(ent);
        // A click on "Start case now" always writes; the 90-second auto-track in test mode stays a dry run
        const explicit = verb === 'Started working';
        const page = await apply(ctx, { status: 'In progress', hold: 'Working it in the broker portal.', log: `${verb} ${midSentence(ctx.kind)} ${ent.id}.`, create: true, explicit });
        D.row = page;
        D.state = page || dryRun() ? 'tracked' : 'error';
        D.msg = page ? (testMode() ? 'Test case created in Notion (named [TEST])' : 'Case created in Notion') : 'Test mode: would create this case';
        GM_setValue(`desk:opened:${ent.id}`, Date.now());
      } catch (e) { D.state = 'error'; D.msg = e.message; }
      changed();
    }

    /* ---- research into Notion */
    // What the panel read off the page (lines, claims and reasons), so the snapshot carries it too
    function setPageData(d) {
      const ent = currentEntity();
      if (!ent || !d) return;
      const claims = [];
      const items = [];
      for (const i of (d.items || []).filter(x => x.inDispute)) {
        const hs = i.fields.find(f => /^hs code$/i.test(f.label));
        const coo = i.fields.find(f => /^country of origin$/i.test(f.label));
        items.push({ title: i.title, hs: hs?.current, from: coo?.current });
        for (const f of i.fields.filter(x => x.claimed)) claims.push(`Line ${i.line} ${f.label}: ${f.current || 'blank'} → merchant says ${f.claimed}`);
        for (const c of i.claims || []) if (c.reason) claims.push(`Line ${i.line} claim (${c.field}${c.status ? `, ${c.status}` : ''}): "${c.reason}"`);
      }
      if (d.kind === 'workOrder' && d.summary) claims.push(`Page: ${d.summary}`);
      D.page = { id: ent.id, items, claims };
    }
    // Entry Assistant facts per line, once per line every 12 hours
    async function onFacts(s) {
      if (!enabled() || !s?.facts) return;
      for (const [key, f] of Object.entries(s.facts)) {
        if (!f.data) continue;
        const k = `desk:facts:${D.ent?.id}:${key}`;
        if (Date.now() - GM_getValue(k, 0) < FACTS_THROTTLE_MS) continue;
        const lines = factLines(f.data).filter(l => l && l.trim());
        if (!lines.length) continue;
        const what = s.data.kind === 'workOrder' ? `codes ${f.data.codes.map(c => c.code || c.asked).join(', ')}` : `line ${key}`;
        const r = await addToCase([toggle(`Entry Assistant facts · ${what} · ${stamp()}`, lines.map(l => bullet(l.replace(/^\s*-\s*/, ''))))], `Entry Assistant facts saved for ${what}.`);
        if (r === 'saved' || r === 'held') GM_setValue(k, Date.now());
      }
    }
    // A prompt sent to Claude (claude.ai, the clipboard)
    function onSent(how, lines) {
      if (!enabled() || !D.row) return;
      addToCase([], `Research ${how}${lines.length ? ` for line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}` : ''}.`).catch(e => console.warn('[Dispute Desk]', e));
    }
    // A Claude answer saved in the panel goes into the case's page, as Markdown
    function onAnswer(text, lines, summary, author) {
      if (!enabled()) return;
      const title = `Claude's answer${lines.length ? ` · line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}` : ''}${summary ? ` · ${summary}` : ''}${author ? ` · ${author}` : ''} · ${stamp()}`;
      addToCase([toggle(title, chunks(text).map(para))], `Saved Claude's answer${summary ? ` (${summary})` : ''}.`, { create: true, explicit: true }).catch(e => { D.msg = e.message; changed(); });
    }

    /* ---- research for Claude Code: a Notion task with the prompt; the answer comes back on the case page */
    async function queueResearch({ prompt, docs, lines, label, openTab = true }) {
      if (!researchOn() || !D.ent) throw new Error('Set up Notion (with the Tasks database) and the Claude Code routine under Settings (the cog in Tools) first.');
      const ctx = caseContext(D.ent);
      const what = lines.length ? `line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}` : label;
      // Always written, test mode included: it's your click, and Claude Code needs the case to answer on
      const page = D.row || await apply(ctx, { status: 'In progress', hold: 'Research sent to Claude Code.', log: `Created from the broker portal by "Research in Claude Code" (${midSentence(ctx.kind)} ${ctx.id}).`, withSnapshot: true, create: true, explicit: true });
      if (!page) throw new Error("Couldn't create the case in Notion, so the research wasn't sent.");
      if (!page.properties?.Type?.select) await notion('PATCH', `/pages/${page.id}`, { properties: { Type: { select: { name: ctx.kind } } } }).catch(e => console.warn('[Dispute Desk]', e));
      D.row = page;
      D.preview = null;
      D.state = 'tracked';
      const caseUrl = page.url;
      const body = [
        para(`Case: ${titleOf(page) || ctx.name}`),
        { object: 'block', type: 'paragraph', paragraph: { rich_text: rt('Open the case in Notion', caseUrl) } },
        bullet(`Case page id: ${page.id}`),
        bullet(`Portal: ${ctx.url}`),
        bullet(`Lines: ${lines.join(', ') || '-'}`),
        bullet(`Kind: ${label}`),
        { object: 'block', type: 'heading_3', heading_3: { rich_text: rt('Documents') } },
        ...(docs.length ? docs.map(x => bullet(x.name, /^https?:/.test(x.url) ? x.url : undefined)) : [bullet('None attached.')]),
        { object: 'block', type: 'heading_3', heading_3: { rich_text: rt('Prompt') } },
        ...chunks(prompt).map(c => ({ object: 'block', type: 'code', code: { language: 'markdown', rich_text: rt(c) } })),
      ];
      const task = await notion('POST', '/pages', {
        parent: { type: 'data_source_id', data_source_id: TASKS() },
        properties: {
          Name: { title: rt(`Research: ${titleOf(page) || ctx.name} (${what})${testMode() ? ' [test mode]' : ''}`) },
          Status: { status: { name: 'Not started' } },
          'Due date': { date: { start: new Date().toLocaleDateString('sv-SE') } },
          Project: { relation: [{ id: page.id }] },
          ...(cfg().notionUser ? { Assignee: { people: [{ id: cfg().notionUser }] } } : {}),
        },
        children: body.slice(0, 100),
      });
      if (body.length > 100) await notion('PATCH', `/blocks/${task.id}/children`, { children: body.slice(100, 200) });
      await addLog(page.id, [{ text: `${stamp()} (portal): Research request for Claude Code (${what}).`, url: task.url }]);
      D.research = { at: Date.now(), task: task.url, what };
      // Start the cloud research session now. If this fails, the routine's hourly sweep still picks the request up.
      const f = await fireResearch(task.id, page.id, { openTab });
      Object.assign(D.research, f);
      GM_setValue(`desk:research:${D.ent.id}`, D.research);
      changed();
      return { task, taskId: task.id, page: page.url, session: f.session, fireError: f.fireError, limited: f.limited };
    }

    // Starts the cloud research session for a research task; the session URL goes on the case as its Chat Link
    async function fireResearch(taskId, pageId, { openTab = true } = {}) {
      const { routineId, routineToken } = cfg();
      if (!routineId || !routineToken) return { fireError: 'no routine set up' };
      try {
        const r = await gmRequest({
          method: 'POST', url: `https://api.anthropic.com/v1/claude_code/routines/${routineId}/fire`, timeout: 30000,
          headers: { Authorization: `Bearer ${routineToken}`, 'anthropic-version': '2026-10-21', 'Content-Type': 'application/json' },
          data: JSON.stringify({ text: `Research request (Notion task id): ${taskId}` }),
        });
        const j = (() => { try { return JSON.parse(r.responseText); } catch { return null; } })();
        if (r.status >= 200 && r.status < 300 && j?.claude_code_session_url) {
          if (openTab) GM_openInTab(j.claude_code_session_url, { active: true, insert: true });   // watch the research as it runs
          if (pageId) {
            await notion('PATCH', `/pages/${pageId}`, { properties: { 'Chat Link': { url: j.claude_code_session_url } } }).catch(e => console.warn('[Dispute Desk]', e));
            await addLog(pageId, [{ text: `${stamp()} (portal): Cloud research session started.`, url: j.claude_code_session_url }]).catch(e => console.warn('[Dispute Desk]', e));
          }
          return { session: j.claude_code_session_url };
        }
        return { fireError: r.status === 429 ? 'the routine run limit was hit' : `the routine answered ${r.status}`, limited: r.status === 429 };
      } catch (e) { return { fireError: e.message }; }
    }

    // For the autopilot: has this work order or dispute been sent for research already, and how many research
    // sessions are still waiting or running
    async function researchState(id) {
      const rows = (await notion('POST', `/data_sources/${DS()}/query`, { filter: { property: 'Dashboard', url: { contains: id } }, page_size: 3 })).results || [];
      let tasks = [];
      if (rows[0] && TASKS()) {
        tasks = (await notion('POST', `/data_sources/${TASKS()}/query`, { filter: { and: [
          { property: 'Project', relation: { contains: rows[0].id } }, { property: 'Name', title: { starts_with: 'Research:' } }] }, page_size: 20 })).results || [];
      }
      return { row: rows[0] ? { id: rows[0].id, url: rows[0].url, title: titleOf(rows[0]), status: statusOf(rows[0]) } : null, researched: tasks.length };
    }
    async function openResearch() {
      if (!TASKS()) return 0;
      const r = await notion('POST', `/data_sources/${TASKS()}/query`, { filter: { and: [
        { property: 'Name', title: { starts_with: 'Research:' } },
        { or: [{ property: 'Status', status: { equals: 'Not started' } }, { property: 'Status', status: { equals: 'In progress' } }] }] }, page_size: 100 });
      return (r.results || []).filter(t => Date.now() - Date.parse(t.created_time) < 6 * 3600 * 1000).length;   // older ones are stuck, not running
    }

    // Claude Code's answers are toggles titled "Claude Code answer · lines …" on the case page.
    // New ones are handed to the panel once each.
    let lastPoll = 0;
    let importer = null;
    const IMPORTED = 'desk:imported';
    // The case's research tasks (Notion Tasks named "Research: …") and its Claude chat (the row's Chat Link),
    // read from Notion for the case card, and again with every answer check
    let linksLoading = null;
    function refreshLinks() {
      if (!enabled() || !D.row) return Promise.resolve();
      if (linksLoading) return linksLoading;
      const rowId = D.row.id;
      linksLoading = (async () => {
        const page = await notion('GET', `/pages/${rowId}`).catch(() => null);
        if (page && D.row?.id === rowId) D.row = page;
        let tasks = [];
        if (TASKS()) {
          const r = await notion('POST', `/data_sources/${TASKS()}/query`, { filter: { and: [
            { property: 'Project', relation: { contains: rowId } }, { property: 'Name', title: { starts_with: 'Research:' } }] },
          sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 5 }).catch(() => null);
          tasks = (r?.results || []).map(t => ({ name: titleOf(t).replace(/^Research:\s*/, ''), url: t.url, status: statusOf(t), at: Date.parse(t.created_time) || 0 }));
        }
        if (D.row?.id === rowId) { D.links = { row: rowId, tasks, chat: D.row?.properties?.['Chat Link']?.url || '' }; changed(); }
      })().finally(() => { linksLoading = null; });
      return linksLoading;
    }

    async function pollAnswers(force) {
      if (!enabled() || !D.row || !importer || (!force && Date.now() - lastPoll < POLL_MS)) return;
      lastPoll = Date.now();
      refreshLinks();
      const done = GM_getValue(IMPORTED, {});
      try {
        let cursor;
        const found = [];
        do {
          const r = await notion('GET', `/blocks/${D.row.id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
          for (const b of r.results || []) {
            const title = (b.toggle?.rich_text || []).map(t => t.plain_text).join('');
            if (b.type === 'toggle' && /^Claude Code answer\b/i.test(title) && !done[b.id]) found.push({ id: b.id, title });
          }
          cursor = r.has_more ? r.next_cursor : null;
        } while (cursor);
        for (const f of found) {
          const kids = await notion('GET', `/blocks/${f.id}/children?page_size=100`);
          const text = (kids.results || []).map(b => (b[b.type]?.rich_text || []).map(t => t.plain_text).join('')).join('\n').trim();
          if (!text) continue;
          const lines = ((f.title.match(/lines?\s+([\d,\s]+)/i) || [])[1] || '').split(/[,\s]+/).filter(Boolean).map(Number);
          importer({ text, lines, title: f.title });
          done[f.id] = Date.now();
          GM_setValue(IMPORTED, done);
          D.msg = 'Claude Code answered. Its answer is saved below.';
          D.research = null;
          GM_deleteValue(`desk:research:${D.ent?.id}`);
        }
        if (found.length) changed();
      } catch (e) { console.warn('[Dispute Desk] checking for Claude Code answers', e); }
    }

    /* ---- the card at the top of the Research tab */
    function card(link) {
      if (!onDashboard) return null;
      const ent = D.ent;
      if (!enabled() || !ent) return null;   // Notion tracking is optional (Settings (the cog in Tools))
      const ctx = caseContext(ent);
      const kids = [];
      const head = h('p', { class: 'label' }, `Case · ${kindOf(ent.type)}`, testMode() ? h('span', { class: `chip ${dryRun() ? 'warn' : ''}`, style: 'margin-left:6px', text: dryRun() ? 'TEST MODE' : 'TEST · writing' }) : null);
      if (dryRun()) kids.push(h('p', { class: 'hint', text: 'Test mode: automatic tracking only previews. Your clicks (Start case now, Research in Claude Code, saving an answer) still go to Notion, as a case named [TEST].' }));
      if (D.state === 'looking' || D.state === 'saving') kids.push(h('p', { class: 'hint', text: D.state === 'saving' ? 'Creating the case in Notion…' : 'Matching this to Notion…' }));
      else if (D.state === 'untracked') kids.push(
        h('p', { class: 'order-q', text: ctx.name }),
        h('p', { class: 'hint', text: researchOn() ? 'Not in Notion yet. Press "Research in Claude Code" to create it in Projects and send the research.' : 'Not in Notion yet.' }),
        h('div', { class: 'row' }, h('button', { class: 'secondary', type: 'button', text: 'Start case now', onclick: () => startCase() })));
      else if (D.state === 'tracked') kids.push(
        h('p', { class: 'order-q', text: D.row ? titleOf(D.row) : ctx.name }),
        h('div', { class: 'row', style: 'flex-wrap:wrap;align-items:center' },
          D.row && h('span', { class: 'chip', text: statusOf(D.row) || '' }),
          D.row && h('a', { href: D.row.url, target: '_blank', rel: 'noopener', text: 'Notion' }),
          // The Claude Code session for this case: its Chat Link in Notion, or the research session just started
          (() => {
            const chat = (D.links?.row === D.row?.id && D.links.chat) || D.row?.properties?.['Chat Link']?.url || (D.research || GM_getValue(`desk:research:${ent.id}`, null))?.session;
            return chat ? h('a', { href: chat, target: '_blank', rel: 'noopener', text: 'Claude chat' }) : null;
          })()),
        // Its research tasks in Notion, newest first
        (() => {
          if (!D.row) return null;
          if (D.links?.row !== D.row.id) { refreshLinks(); return h('p', { class: 'hint', text: 'Looking for research tasks…' }); }
          if (!D.links.tasks.length) return null;
          return h('div', { class: 'tasks' }, D.links.tasks.map(t => h('div', { class: 'task-line' },
            h('a', { href: t.url, target: '_blank', rel: 'noopener', text: `Task: ${t.name}` }),
            t.status ? h('span', { class: `chip ${t.status === 'Done' ? 'v-yes' : ''}`, text: t.status }) : null,
            t.at ? h('span', { class: 'hint', style: 'margin:0', text: shortDate(t.at) }) : null)));
        })());
      else if (D.state === 'error') kids.push(h('p', { class: 'hint err', text: D.msg }), h('div', { class: 'row' }, h('button', { class: 'secondary', type: 'button', text: 'Try again', onclick: () => onRoute() })));
      if (D.state !== 'looking' && D.state !== 'error') kids.push(h('p', { class: 'hint', text: ctx.hasData ? `Captured ${ctx.facts.length} facts from the portal${ctx.tracking[0] ? ` · ${ctx.tracking[0]}` : ''}` : "Waiting for the portal's data…" }));
      const r = D.research || GM_getValue(`desk:research:${ent.id}`, null);
      if (r && !r.dry) kids.push(h('p', { class: 'hint' }, `Research for Claude Code (${r.what}) sent ${shortDate(r.at)}. Its answer shows up below by itself. `,
        r.session && h('a', { href: r.session, target: '_blank', rel: 'noopener', text: 'Open the research session' }), r.session && ' · ',
        r.task && link('Task', () => window.open(r.task, '_blank', 'noopener')),
        r.fireError && h('span', { class: 'warn', text: ` (Couldn't start the cloud session right away: ${r.fireError}. The hourly sweep will pick it up.)` })));
      if (D.preview) {
        const p = D.preview;
        kids.push(h('p', { class: 'hint warn', text: `Test mode, nothing written. Would ${p.action} “${p.row}”${p.status ? ` · Status ${p.status}` : ''}${p.hold ? ` · Hold?: ${p.hold}` : ''}${p.summary ? ` · Summary: ${p.summary}` : ''} · Log: ${p.log}${p.extra ? ` · + ${p.extra} research block${p.extra > 1 ? 's' : ''}` : ''}` }));
      }
      if (D.msg && D.state !== 'error') kids.push(h('p', { class: 'hint ok', text: D.msg }));
      return h('div', { class: 'section' }, head, h('div', { class: 'order-card' }, kids));
    }

    async function testKey() {
      if (!notionKey()) throw new Error('Paste your Notion integration key first.');
      if (!DS()) throw new Error('Paste your Projects data source id first.');
      const me = await notion('GET', `/data_sources/${DS()}`);
      let msg = (me.title || []).map(t => t.plain_text).join('') || 'Projects';
      if (TASKS()) {
        const t = await notion('GET', `/data_sources/${TASKS()}`);
        msg += ` and ${(t.title || []).map(x => x.plain_text).join('') || 'Tasks'}`;
      }
      return msg;
    }

    return {
      enabled, researchOn, finalAnswer: () => (D.row?.properties?.['Claude Final Answer']?.rich_text || []).map(t => t.plain_text).join('').trim(),
      dryRun, testMode, onRoute, startCase, setPageData, onFacts, onSent, onAnswer, queueResearch, pollAnswers, card, testKey,
      subscribe: fn => listeners.add(fn),
      setImporter: fn => { importer = fn; },
      key: { get: notionKey, set: v => (v ? GM_setValue(KEY, v) : GM_deleteValue(KEY)) },
      writeInTest: { get: () => GM_getValue(WRITE_IN_TEST, false), set: v => GM_setValue(WRITE_IN_TEST, !!v) },
      screeningLines, fireResearch, researchState, openResearch,
      debug: () => ({ caseContext, currentEntity, captured, describe, entityFromWorkOrder, chunks, screenings, D }),
    };
  })();
  /* ------------------------------------------- dashboard: the portal's own data (queue and bulk actions) */

  // The portal's GraphQL, called the way the portal calls it: same origin, your sign-in, and the
  // x-app-mode header from its Live/Test switch. Without that header every call silently goes to TEST data.
  // Calls go through the page's fetch, so the desk logs bulk actions to existing Notion rows like your clicks.
  const portal = (() => {
    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    function mode() {
      const c = (document.cookie.match(/(?:^|;\s*)broker-portal-mode=([^;]*)/) || [])[1];
      let l = null;
      try { l = localStorage.getItem('broker-portal-mode'); } catch { /* no storage */ }
      return decodeURIComponent(c || l || 'live').replace(/"/g, '') === 'test' ? 'test' : 'live';
    }
    // `headers` adds to the portal's own, e.g. x-act-as-org: some calls answer only on behalf of the order's company
    async function gql(op, query, variables = {}, headers = {}) {
      const res = await W.fetch(`/api/graphql/brokerage/${op}`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-app-mode': mode(), ...headers },
        body: JSON.stringify({ operationName: op, query, variables }),
      });
      let j = null;
      try { j = await res.json(); } catch { /* not JSON */ }
      if (j?.errors?.length) throw new Error(j.errors.map(e => e.message).join('; '));
      if (!res.ok || !j?.data) throw new Error(`The portal answered ${res.status}.`);
      return j.data;
    }
    let session = null;
    async function me() {
      if (session) return session;
      const res = await W.fetch('/api/auth/session', { credentials: 'include' });
      const s = await res.json();
      session = { id: s.userId || '', name: s.displayName || '' };
      return session;
    }

    const WO = `id type status assigneeId assigneeName claimedAt createdAt dueDate updatedAt groupKey detail subjectKey stream
      resolution resolutionNote resolvedAt escalatedTo escalatedAt escalatedByName escalationNote subjectType
      entry { id entryNumber consolidation { id masterBillNumber } consignments { id organizationId consigneeName } }
      consignment { id trackingNumber organizationId consigneeName consolidation { id masterBillNumber } }
      subject {
        ... on Entry { id } ... on Consignment { id } ... on ConsignmentGreenLightFinding { id }
        ... on Consolidation { id masterBillNumber consolidationOrganizationId: organizationId }
        ... on BrokerageDutyDispute { id status organizationId trackingNumber deadline { expiresAt }
          receiver { person { companyName firstName lastName } } items { original { description } claims { type } } }
      }
      rejections { detail stream sourceCbpEvent { id cbpCode description severity } }`;
    const LIST = `query BrokerageWorkOrders($first: Int, $after: String, $filter: BrokerageWorkOrderFilter) {
      brokerageWorkOrders(first: $first, after: $after, filter: $filter) { totalCount pageInfo { hasNextPage endCursor } edges { node { ${WO} } } } }`;
    const PAGE = 100;   // the most the portal returns at once
    // Every order matching a filter. The portal's cursors are offsets ("simple-offset-cursor<n>"), so the
    // pages after the first load side by side; if that ever stops matching the count, it reads them in order.
    async function workOrders(filter, cap = 3000) {
      const first = (await gql('BrokerageWorkOrders', LIST, { first: PAGE, filter })).brokerageWorkOrders;
      const total = Math.min(first.totalCount || 0, cap);
      const nodes = first.edges.map(e => e.node);
      const offsets = [];
      for (let o = PAGE; o < total; o += PAGE) offsets.push(o);
      for (let i = 0; i < offsets.length; i += 4) {
        const batch = await Promise.all(offsets.slice(i, i + 4).map(o =>
          gql('BrokerageWorkOrders', LIST, { first: PAGE, after: btoa(`simple-offset-cursor${o - 1}`), filter })
            .then(d => d.brokerageWorkOrders.edges.map(e => e.node))));
        nodes.push(...batch.flat());
      }
      const unique = [...new Map(nodes.map(n => [n.id, n])).values()];
      if (unique.length >= total || !first.pageInfo.hasNextPage) return unique;
      const all = first.edges.map(e => e.node);
      let after = first.pageInfo.endCursor;
      while (after && all.length < total) {
        const d = (await gql('BrokerageWorkOrders', LIST, { first: PAGE, after, filter })).brokerageWorkOrders;
        all.push(...d.edges.map(e => e.node));
        after = d.pageInfo.hasNextPage ? d.pageInfo.endCursor : null;
      }
      return [...new Map(all.map(n => [n.id, n])).values()];
    }
    const search = (text, cap = 100) => workOrders({ search: text }, cap);

    // Customer names, kept for good: an organization's name doesn't change often
    const ORG_KEY = 'zt:orgs';
    const orgs = GM_getValue(ORG_KEY, {});
    async function orgNames(ids) {
      const missing = [...new Set(ids)].filter(id => id && !(id in orgs));
      for (let i = 0; i < missing.length; i += 6) {
        await Promise.all(missing.slice(i, i + 6).map(id =>
          gql('Organizations', 'query Organizations($id: ID!) { organizationById(id: $id) { id name } }', { id })
            .then(d => { orgs[id] = d.organizationById?.name || ''; }, () => { /* left out; asked again next load */ })));
      }
      if (missing.length) GM_setValue(ORG_KEY, orgs);
      return orgs;
    }

    // The portal's actions. Each takes many ids at once, exactly as the portal's own buttons send them.
    const mutation = (name, field, args, sel = WO) =>
      `mutation ${name}(${args}) { ${field}(${args.split(',').map(a => a.trim().split(':')[0]).map(v => `${v.slice(1)}: ${v}`).join(', ')}) { ${sel} } }`;
    const ACTION_Q = {
      BrokerageWorkOrderClaim: mutation('BrokerageWorkOrderClaim', 'brokerageWorkOrderClaim', '$ids: [ID!]!'),
      BrokerageWorkOrderRelease: mutation('BrokerageWorkOrderRelease', 'brokerageWorkOrderRelease', '$ids: [ID!]!'),
      BrokerageWorkOrderWait: mutation('BrokerageWorkOrderWait', 'brokerageWorkOrderWait', '$ids: [ID!]!, $note: String'),
      BrokerageWorkOrderResume: mutation('BrokerageWorkOrderResume', 'brokerageWorkOrderResume', '$ids: [ID!]!, $note: String'),
      BrokerageWorkOrderEscalate: mutation('BrokerageWorkOrderEscalate', 'brokerageWorkOrderEscalate', '$ids: [ID!]!, $target: BrokerageWorkOrderEscalationTarget!, $note: String!'),
      BrokerageWorkOrderNote: mutation('BrokerageWorkOrderNote', 'brokerageWorkOrderNote', '$ids: [ID!]!, $note: String!', 'id'),
      BrokerageWorkOrderAssign: mutation('BrokerageWorkOrderAssign', 'brokerageWorkOrderAssign', '$ids: [ID!]!, $assigneeId: ID!'),
      BrokerageWorkOrderResolve: mutation('BrokerageWorkOrderResolve', 'brokerageWorkOrderResolve', '$ids: [ID!]!, $resolution: BrokerageWorkOrderResolution!, $note: String'),
    };
    // In chunks of 25; a chunk the portal refuses is retried one order at a time, so one bad order
    // doesn't hold up the rest and the report says exactly which failed and why
    async function act(op, ids, vars = {}, onProgress = () => {}) {
      const done = [];
      const failed = [];
      for (let i = 0; i < ids.length; i += 25) {
        const chunk = ids.slice(i, i + 25);
        try {
          await gql(op, ACTION_Q[op], { ...vars, ids: chunk });
          done.push(...chunk);
        } catch {
          for (const id of chunk) {
            try { await gql(op, ACTION_Q[op], { ...vars, ids: [id] }); done.push(id); }
            catch (e) { failed.push({ id, error: e.message }); }
          }
        }
        onProgress(done.length + failed.length, ids.length);
      }
      return { done, failed };
    }

    return { mode, gql, me, workOrders, search, orgNames, orgs, act };
  })();

  /* ------------------------------------------------- dashboard: the work queue */

  const QUEUE_PATH = '/entry-writer-queue';
  // Which queue the Entry Writer Queue page shows: the portal's own (the default) or the Tools queue
  const QUEUE_VIEW_KEY = 'zt:queueView';
  const toolsQueueOn = () => GM_getValue(QUEUE_VIEW_KEY, 'portal') === 'tools';
  let queueCtl = null;   // set once the queue exists, so Tools can switch views
  const onQueuePage = () => location.pathname.replace(/\/$/, '') === QUEUE_PATH;
  const NAV_KEY = 'zt:queue:nav';        // the queue as last shown: the order of Prev / Next and each order's summary
  const PREFS_KEY = 'zt:queue:prefs';
  const SEEN_KEY = 'zt:queue:seenAt';
  const DAY = 86400000;
  const CLASS_LABELS = {
    ADCVD_REVIEW: 'AD/CVD review', DUTY_DISPUTE_REVIEW: 'Duty dispute review', HS_CODE_REVIEW: 'HS code review',
    VALUE_REVIEW: 'Declared value review', DENIED_PARTY_REVIEW: 'Denied-party review', ENTRY_REJECTED: 'Entry rejected',
    SUBMISSION_FAILED: 'Submission failed', VALIDATION_BLOCKED: 'Validation blocked', CBP_HOLD: 'CBP hold', CBP_EXAM: 'CBP exam',
    PGA_HOLD: 'PGA hold', CBP_CANCELLED: 'CBP cancelled', UNFILEABLE: 'Unfileable', CARRIER_MANIFEST_MISMATCH: 'Carrier manifest mismatch',
    CUSTOMS_DESCRIPTION_REVIEW: 'Customs description review',
  };
  const classLabel = t => CLASS_LABELS[t] || String(t || '').toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const RESOLUTIONS = {
    CONDITION_CLEARED: 'Condition cleared', NO_ACTION_REQUIRED: 'No action required', CORRECTED_PREFILE: 'Corrected pre-file',
    REFERENCE_DATA_FIXED_RESENT: 'Reference data fixed, resent', CANCELLED_AND_REFILED: 'Cancelled and refiled', UNFILEABLE_ACCEPTED: 'Unfileable accepted',
  };

  // One queue order, flattened for showing, searching and sorting
  function queueRow(n) {
    const sid = n.subject?.id || n.subjectKey || '';
    const dd = n.type === 'DUTY_DISPUTE_REVIEW' && /^duty_dispute_/.test(sid);
    const url = dd ? `/duty-disputes/${sid}`
      : `${QUEUE_PATH}/${n.type}/${encodeURIComponent(sid)}${n.consignment?.id ? `?consignment=${n.consignment.id}` : ''}`;
    const lines = (n.detail || '').split('\n').map(clean).filter(Boolean);
    const bullet = lines.find(l => /^- /.test(l));
    const fromError = ((n.detail || '').match(/origin [A-Z]{2}: (.+?)(?:;|, path=|\)\]|$)/) || [])[1];
    const items = (n.subject?.items || []).map(i => clean(i.original?.description)).filter(Boolean);
    const title = items[0] || (bullet ? bullet.slice(2).split(' · ')[0] : '') || fromError || lines[0] || sid;
    const tracking = n.consignment?.trackingNumber || n.subject?.trackingNumber || '';
    const entryNo = n.entry?.entryNumber || '';
    const mbol = n.consignment?.consolidation?.masterBillNumber || n.entry?.consolidation?.masterBillNumber || n.subject?.masterBillNumber || '';
    const orgId = n.consignment?.organizationId || n.subject?.organizationId || n.subject?.consolidationOrganizationId || n.entry?.consignments?.[0]?.organizationId || '';
    const consignee = n.consignment?.consigneeName || n.entry?.consignments?.[0]?.consigneeName
      || clean([n.subject?.receiver?.person?.companyName, n.subject?.receiver?.person?.firstName, n.subject?.receiver?.person?.lastName].filter(Boolean).join(' '));
    const due = n.dueDate || n.subject?.deadline?.expiresAt || '';
    const codes = (n.rejections || []).map(r => r.sourceCbpEvent?.cbpCode).filter(Boolean);
    const problem = lines[0] && lines[0] !== title ? lines[0] : (n.rejections?.[0]?.detail || '');
    return {
      id: n.id, type: n.type, label: classLabel(n.type), status: n.status, assigneeId: n.assigneeId || '', assigneeName: n.assigneeName || '',
      claimedAt: n.claimedAt, createdMs: Date.parse(n.createdAt) || 0, dueMs: Date.parse(due) || null, stream: n.stream || '',
      escalatedTo: n.escalatedTo || '', escalationNote: n.escalationNote || '', resolution: n.resolution || '', detail: n.detail || '', problem: clean(problem).slice(0, 160),
      title: clean(title).slice(0, 120), items, tracking, entryNo, mbol, ref: tracking || entryNo || mbol || sid, sid, url, orgId, customer: '', consignee,
      codes, groupKey: n.groupKey || '',
    };
  }
  // The text a search looks through, built once per row (and again when its customer name arrives)
  const hay = r => r._hay || (r._hay = [r.label, r.status, r.title, r.problem, r.detail, r.tracking, r.entryNo, r.mbol, r.sid, r.id, r.customer, r.consignee,
    r.assigneeName, r.stream, r.escalatedTo, r.escalationNote, ...r.items, ...r.codes].join(' \u0001 ').toLowerCase());

  function dueText(r) {
    if (!r.dueMs) return { text: '—', cls: 'muted' };
    const date = new Date(r.dueMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const days = Math.floor((startOfDay(Date.now()) - startOfDay(r.dueMs)) / DAY);
    if (days > 0) return { text: date, sub: `${days}d overdue`, cls: 'err' };
    if (days === 0) return { text: date, sub: 'due today', cls: 'warn' };
    return { text: date, sub: `in ${-days}d`, cls: days >= -2 ? 'warn' : 'muted' };
  }
  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  const ageText = ms => { const d = Math.floor((Date.now() - ms) / DAY); return d >= 1 ? `${d}d` : `${Math.max(1, Math.floor((Date.now() - ms) / 3600000))}h`; };

  const QUEUE_CSS = `
    :host { all: initial; display: block; --bg:#ffffff; --fg:#18181b; --muted:#71717a; --line:#e4e4e7; --soft:#f4f4f5; --tint:#fff7ed; --accent:#b45309; --accent-fg:#ffffff; --ok:#15803d; --warn:#b45309; --err:#b91c1c; --sel:#fef3c7; }
    :host([data-theme="dark"]) { --bg:#0c0c0d; --fg:#f4f4f5; --muted:#a1a1aa; --line:#27272a; --soft:#18181b; --tint:#2a1d0a; --accent:#f59e0b; --accent-fg:#111111; --ok:#4ade80; --warn:#fbbf24; --err:#f87171; --sel:#2a1d0a; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .q, .scrim, .toast { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .q { color: var(--fg); max-width: 1600px; margin: 0 auto; font-variant-numeric: tabular-nums; }
    button, select, input, textarea { font: inherit; color: inherit; }
    button { cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
    button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible, tr:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    a { color: inherit; text-decoration: none; }
    .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .eyebrow { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
    h1 { margin: 2px 0 0; font-size: 24px; line-height: 1.2; }
    .mode { display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; vertical-align: middle; border: 1px solid currentColor; }
    .mode.live { color: var(--ok); } .mode.test { color: var(--warn); }
    .top-actions { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
    .btn { background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; }
    .btn:hover { background: var(--soft); }
    .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
    .btn.danger { color: var(--err); border-color: currentColor; }
    .btn.small { padding: 2px 8px; font-size: 12px; }
    .scopes { display: flex; gap: 2px; margin-top: 14px; border-bottom: 1px solid var(--line); overflow-x: auto; }
    .scope { background: none; border: 0; border-bottom: 2px solid transparent; padding: 8px 12px; font-weight: 600; color: var(--muted); white-space: nowrap; }
    .scope:hover { color: var(--fg); }
    .scope[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }
    .count { display: inline-block; min-width: 20px; margin-left: 6px; padding: 0 6px; border-radius: 999px; background: var(--soft); font-size: 11px; text-align: center; }
    .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
    .search { flex: 1 1 340px; display: flex; align-items: center; gap: 6px; background: var(--soft); border: 1px solid var(--line); border-radius: 8px; padding: 0 10px; }
    .search input { flex: 1; min-width: 0; border: 0; background: transparent; padding: 8px 0; outline: none; }
    .search kbd { font: 11px ui-monospace, Consolas, monospace; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
    .filter { position: relative; }
    .filter > button { background: transparent; border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; white-space: nowrap; width: 112px; text-align: left; overflow: hidden; text-overflow: ellipsis; }
    .filter > button.on { border-color: var(--accent); color: var(--accent); }
    .pop { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 240px; max-width: 340px; max-height: 360px; overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.35); padding: 6px; }
    .pop label { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 4px; cursor: pointer; }
    .pop label:hover { background: var(--soft); }
    .pop label span.n { margin-left: auto; color: var(--muted); font-size: 11px; }
    .pop input[type=search] { width: 100%; margin-bottom: 4px; background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; }
    .pop .pop-actions { display: flex; justify-content: space-between; padding: 4px 6px 0; border-top: 1px solid var(--line); margin-top: 4px; }
    .linkish { background: none; border: 0; padding: 0; color: var(--accent); font-size: 12px; }
    .summary { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .stat { border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; background: transparent; text-align: left; min-width: 112px; }
    .stat:hover { background: var(--soft); }
    .stat.on { border-color: var(--accent); }
    .stat b { display: block; font-size: 18px; line-height: 1.2; }
    .stat span { font-size: 11px; color: var(--muted); }
    .stat.err b { color: var(--err); } .stat.warn b { color: var(--warn); }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .chip { border: 1px solid var(--line); background: transparent; border-radius: 999px; padding: 1px 9px; font-size: 12px; color: var(--muted); }
    .chip:hover { color: var(--fg); }
    .chip.on { color: var(--accent); border-color: var(--accent); }
    .views { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 8px; font-size: 12px; color: var(--muted); }
    .actionbar { height: 44px; margin-top: 12px; display: flex; align-items: center; }
    .actionbar > * { flex: 1; min-width: 0; }
    .bulk { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; overflow-x: auto; white-space: nowrap; padding: 6px 10px; border: 1px solid var(--accent); border-radius: 8px; background: var(--tint); }
    .bulk .sel-n { font-weight: 700; margin-right: 6px; }
    .bulk > * { flex: none; }
    .bulk .sep { width: 1px; height: 20px; background: var(--line); margin: 0 4px; }
    .tablewrap { margin-top: 10px; border: 1px solid var(--line); border-radius: 8px; overflow-x: auto; }
    table { width: 100%; min-width: 1180px; border-collapse: collapse; table-layout: fixed; }
    th { position: sticky; top: 0; background: var(--bg); text-align: left; font-size: 12px; font-weight: 600; color: var(--muted); padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; user-select: none; }
    th.sortable { cursor: pointer; }
    th.sortable:hover { color: var(--fg); }
    th .arrow { color: var(--accent); margin-left: 3px; font-size: 11px; }
    td { padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; overflow: hidden; }
    tr.row td { height: 52px; }
    .clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    tr.row { cursor: pointer; }
    tr.row:hover td { background: var(--soft); }
    tr.row.sel td { background: var(--sel); }
    tr.row.focus td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
    tr.group td { background: var(--soft); font-weight: 600; font-size: 12px; padding: 6px 10px; }
    td.cb, th.cb { padding-right: 0; }
    td.cb input, th.cb input { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }
    .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; border: 1px solid var(--line); white-space: nowrap; }
    .st-OPEN { color: #60a5fa; border-color: currentColor; } .st-WAITING { color: var(--warn); border-color: currentColor; }
    .st-RESOLVED, .st-AUTO_RESOLVED { color: var(--ok); border-color: currentColor; } .st-CANCELLED { color: var(--muted); }
    .esc { color: var(--err); border-color: currentColor; }
    .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub { font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ref { display: flex; align-items: baseline; min-width: 0; font: 12px ui-monospace, Consolas, monospace; white-space: nowrap; }
    .ref a { overflow: hidden; text-overflow: ellipsis; }
    .badges { display: flex; flex-wrap: nowrap; gap: 4px; white-space: nowrap; }
    .badge { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
    .copy { visibility: hidden; background: none; border: 0; color: var(--muted); padding: 0 4px; font-size: 12px; }
    tr.row:hover .copy { visibility: visible; }
    .copy:hover { color: var(--accent); }
    .new { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-right: 6px; vertical-align: middle; }
    .muted { color: var(--muted); } .err { color: var(--err); } .warn { color: var(--warn); } .ok { color: var(--ok); }
    .empty { padding: 28px; text-align: center; color: var(--muted); }
    .foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 2px; font-size: 12px; color: var(--muted); }
    .toast { position: fixed; z-index: 2147483002; left: 50%; bottom: 24px; transform: translateX(-50%); max-width: min(720px, 90vw); background: var(--fg); color: var(--bg); padding: 10px 14px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.35); white-space: pre-wrap; }
    .toast.err { background: var(--err); color: #fff; }
    .scrim { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.45); display: grid; place-items: center; padding: 16px; }
    .dialog { width: min(520px, 100%); max-height: 90vh; overflow: auto; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; box-shadow: 0 20px 50px rgba(0,0,0,.5); }
    .dialog h2 { margin: 0 0 6px; font-size: 16px; }
    .dialog p { margin: 0 0 10px; }
    .dialog label.f { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin: 10px 0 4px; }
    .dialog textarea, .dialog select, .dialog input[type=text] { width: 100%; background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
    .dialog textarea { min-height: 80px; resize: vertical; }
    .dialog .list { max-height: 140px; overflow: auto; font-size: 12px; color: var(--muted); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; margin: 0 0 8px; }
    .dialog .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
    .progress { height: 4px; background: var(--soft); border-radius: 2px; overflow: hidden; margin-top: 10px; }
    .progress > div { height: 100%; background: var(--accent); width: 0; transition: width .2s; }
    .keys { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .keys kbd { font: 11px ui-monospace, Consolas, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; }
  `;

  // Who can do what to an order. The portal still has the final say; a refusal is reported per order.
  const BULK = [
    { key: 'claim', label: 'Claim', op: 'BrokerageWorkOrderClaim', verb: 'Claimed', can: (r, me) => r.status === 'OPEN' && !r.assigneeId },
    { key: 'release', label: 'Release', op: 'BrokerageWorkOrderRelease', verb: 'Released', can: r => !!r.assigneeId },
    { key: 'wait', label: 'Wait…', op: 'BrokerageWorkOrderWait', verb: 'Marked waiting', can: r => r.status === 'OPEN', note: 'optional' },
    { key: 'resume', label: 'Resume…', op: 'BrokerageWorkOrderResume', verb: 'Resumed', can: r => r.status === 'WAITING', note: 'optional' },
    { key: 'escalate', label: 'Escalate…', op: 'BrokerageWorkOrderEscalate', verb: 'Escalated', can: r => !r.escalatedTo, note: 'required', target: true },
    { key: 'note', label: 'Note…', op: 'BrokerageWorkOrderNote', verb: 'Added a note to', can: () => true, note: 'required' },
    { key: 'assign', label: 'Assign…', op: 'BrokerageWorkOrderAssign', verb: 'Assigned', can: () => true, assignee: true },
    { key: 'resolve', label: 'Resolve…', op: 'BrokerageWorkOrderResolve', verb: 'Resolved', can: r => r.status === 'OPEN' || r.status === 'WAITING', note: 'optional', resolution: true, danger: true },
  ];

  const SCOPES = [
    { key: 'mine', label: 'Mine', test: (r, me) => !!me && r.assigneeId === me },
    { key: 'unclaimed', label: 'Unclaimed', test: r => r.status === 'OPEN' && !r.assigneeId },
    { key: 'waiting', label: 'Waiting', test: r => r.status === 'WAITING' },
    { key: 'escalated', label: 'Escalated', test: r => !!r.escalatedTo },
    { key: 'all', label: 'All open', test: () => true },
  ];
  const DUE = {
    overdue: { label: 'Overdue', test: r => r.dueMs && startOfDay(r.dueMs) < startOfDay(Date.now()) },
    today: { label: 'Due today', test: r => r.dueMs && startOfDay(r.dueMs) === startOfDay(Date.now()) },
    week: { label: 'Due in 7 days', test: r => r.dueMs && r.dueMs >= startOfDay(Date.now()) && r.dueMs < startOfDay(Date.now()) + 8 * DAY },
    none: { label: 'No due date', test: r => !r.dueMs },
  };
  const FILTERS = [
    { key: 'type', label: 'Class', val: r => r.label },
    { key: 'customer', label: 'Customer', val: r => r.customer || r.consignee || '(unknown)', searchable: true },
    { key: 'assignee', label: 'Assignee', val: r => r.assigneeName || 'Unclaimed', searchable: true },
    { key: 'status', label: 'Status', val: r => r.status === 'WAITING' ? 'Waiting' : r.escalatedTo ? 'Escalated' : 'Open' },
    { key: 'stream', label: 'Stream', val: r => r.stream ? human2(r.stream) : 'None' },
    { key: 'due', label: 'Due', val: r => Object.entries(DUE).filter(([, d]) => d.test(r)).map(([, d]) => d.label) },
  ];
  function human2(s) { const t = String(s || '').toLowerCase().replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); }
  // Fixed widths (Item / problem takes the rest), so sorting, filtering or searching never moves a column
  const COLS = [
    { key: 'type', label: 'Class', width: 160, val: r => r.label },
    { key: 'status', label: 'Status', width: 150, val: r => `${r.status}${r.escalatedTo ? '!' : ''}` },
    { key: 'title', label: 'Item / problem', val: r => r.title.toLowerCase() },
    { key: 'ref', label: 'Tracking / entry', width: 180, val: r => r.ref },
    { key: 'customer', label: 'Customer', width: 180, val: r => (r.customer || r.consignee || '').toLowerCase() },
    { key: 'due', label: 'Due', width: 112, val: r => r.dueMs ?? Number.MAX_SAFE_INTEGER },
    { key: 'age', label: 'Age', width: 60, val: r => -r.createdMs },
    { key: 'assignee', label: 'Assignee', width: 124, val: r => (r.assigneeName || '~').toLowerCase() },
  ];
  const GROUPS = { '': 'No grouping', customer: 'Customer', type: 'Class', assignee: 'Assignee', status: 'Status', due: 'Due' };

  function createQueue() {
    const host = h('div', { id: 'zt-queue-host' });
    const root = host.attachShadow({ mode: 'open' });
    for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, e => e.stopPropagation());
    const defaults = { scope: 'mine', filters: {}, sort: [{ key: 'due', dir: 1 }], group: '', views: [], auto: true };
    const prefs = { ...defaults, ...GM_getValue(PREFS_KEY, {}) };
    const savePrefs = () => GM_setValue(PREFS_KEY, { scope: S.scope, filters: S.filters, sort: S.sort, group: S.group, views: prefs.views, auto: S.auto });
    const S = {
      rows: [], me: null, loadedAt: 0, loading: false, error: '', q: '', scope: prefs.scope, filters: prefs.filters || {}, sort: prefs.sort, group: prefs.group,
      auto: prefs.auto, sel: new Set(), anchor: -1, focus: -1, pop: '', popSearch: '', extra: null, extraFor: '', seenAt: GM_getValue(SEEN_KEY, 0), shown: [], limit: 300,
    };
    let autoTimer = null;

    const wrap = h('div', { class: 'q' });
    root.append(h('style', { text: QUEUE_CSS }), wrap);
    const searchInput = h('input', {
      type: 'text', placeholder: 'Search anything: tracking, entry, master bill, customer, item, HS code, note… (paste a list to match many)',
      'aria-label': 'Search the queue', autocomplete: 'off', spellcheck: 'false',
      oninput: e => { S.q = e.target.value; S.extra = null; S.limit = 300; render(); },
      onkeydown: e => {
        if (e.key === 'Escape') { searchInput.value = ''; S.q = ''; S.extra = null; render(); }
        if (e.key === 'Enter' && S.shown.length === 1) openRow(S.shown[0], e);
        if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
      },
    });

    // ---- data
    async function load({ quiet = false } = {}) {
      if (S.loading) return;
      S.loading = true; S.error = '';
      if (!quiet) render();
      try {
        const [me, open, waiting] = await Promise.all([portal.me(), portal.workOrders({ status: 'OPEN' }), portal.workOrders({ status: 'WAITING' })]);
        S.me = me;
        const rows = [...open, ...waiting].map(queueRow);
        const names = portal.orgs;
        for (const r of rows) r.customer = names[r.orgId] || '';
        S.rows = rows;
        S.loadedAt = Date.now();
        const live = new Set(rows.map(r => r.id));
        for (const id of [...S.sel]) if (!live.has(id)) S.sel.delete(id);
        S.loading = false;
        render();
        // Names the cache didn't have yet come in after the first draw
        const missing = rows.filter(r => r.orgId && !(r.orgId in names)).map(r => r.orgId);
        if (missing.length) {
          await portal.orgNames(missing);
          for (const r of S.rows) { r.customer = portal.orgs[r.orgId] || ''; r._hay = ''; }
          render();
        }
      } catch (e) {
        S.error = e.message;
        S.loading = false;
        render();
      }
    }
    function setAuto(on) {
      S.auto = on;
      clearInterval(autoTimer);
      if (on) autoTimer = setInterval(() => { if (!document.hidden && host.isConnected && !S.sel.size && !root.querySelector('.scrim')) load({ quiet: true }); }, 60000);
      savePrefs();
    }

    // ---- what's shown
    function parseQuery(q) {
      const parts = q.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
      const idLike = s => s.length >= 8 && /\d/.test(s) && /^[A-Za-z0-9_\-.]+$/.test(s);
      if (parts.length >= 2 && parts.every(idLike)) return { list: parts.map(p => p.toLowerCase()) };
      const terms = [];
      for (const m of q.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
        const neg = !!(m[1] || m[3]);
        const t = (m[2] || m[4] || '').toLowerCase();
        if (t && t !== '-') terms.push({ t, neg });
      }
      return { terms };
    }
    function filterVals(f, r) { const v = f.val(r); return Array.isArray(v) ? v : [v]; }
    function visible({ ignore = '' } = {}) {
      const scope = SCOPES.find(s => s.key === S.scope) || SCOPES[0];
      const me = S.me?.id;
      const pq = parseQuery(S.q);
      let rows = S.rows.filter(r => scope.test(r, me));
      for (const f of FILTERS) {
        const want = S.filters[f.key];
        if (f.key === ignore || !want?.length) continue;
        rows = rows.filter(r => filterVals(f, r).some(v => want.includes(v)));
      }
      if (pq.list) {
        const found = new Set();
        rows = rows.filter(r => {
          const keys = [r.tracking, r.entryNo, r.mbol, r.sid, r.id].map(k => String(k || '').toLowerCase());
          const hit = pq.list.filter(t => keys.includes(t) || hay(r).includes(t));
          hit.forEach(t => found.add(t));
          return hit.length > 0;
        });
        S.missing = pq.list.filter(t => !found.has(t));
      } else {
        S.missing = [];
        if (pq.terms.length) {
          rows = rows.filter(r => { const s = hay(r); return pq.terms.every(({ t, neg }) => s.includes(t) !== neg); });
        }
      }
      return rows;
    }
    function sortRows(rows) {
      const keys = S.sort.map(s => ({ col: COLS.find(c => c.key === s.key), dir: s.dir })).filter(s => s.col);
      return rows.slice().sort((a, b) => {
        for (const { col, dir } of keys) {
          const x = col.val(a), y = col.val(b);
          const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
          if (c) return c * dir;
        }
        return (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity);
      });
    }
    function groupOf(r) {
      if (S.group === 'customer') return r.customer || r.consignee || '(unknown customer)';
      if (S.group === 'type') return r.label;
      if (S.group === 'assignee') return r.assigneeName || 'Unclaimed';
      if (S.group === 'status') return r.status === 'WAITING' ? 'Waiting' : r.escalatedTo ? 'Escalated' : 'Open';
      if (S.group === 'due') return DUE.overdue.test(r) ? 'Overdue' : DUE.today.test(r) ? 'Due today' : DUE.week.test(r) ? 'Due in 7 days' : r.dueMs ? 'Later' : 'No due date';
      return '';
    }

    // ---- drawing
    function render() {
      host.dataset.theme = pageIsDark() ? 'dark' : 'light';
      const me = S.me?.id;
      const rows = sortRows(visible());
      let ordered = rows;
      if (S.group) {
        const groups = new Map();
        for (const r of rows) { const g = groupOf(r); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
        ordered = [...groups.values()].flat();
      }
      S.shown = ordered;
      saveNav(ordered);
      const focusEl = root.activeElement === searchInput;

      const mode = portal.mode();
      const top = h('div', { class: 'top' },
        h('div', {},
          h('h1', {}, 'Work queue', h('span', { class: `mode ${mode}`, text: mode.toUpperCase(), title: 'The portal mode every action here goes to' }))),
        h('div', { class: 'top-actions' },
          S.loading ? h('span', { text: 'Loading…' }) : S.loadedAt ? h('span', { text: `Updated ${new Date(S.loadedAt).toLocaleTimeString()}` }) : null,
          h('label', { title: 'Reloads every minute while nothing is selected' },
            h('input', { type: 'checkbox', checked: S.auto, onchange: e => setAuto(e.target.checked) }), ' Auto-refresh'),
          h('button', { class: 'btn', type: 'button', text: '↻ Refresh', disabled: S.loading, onclick: () => load() }),
          h('button', { class: 'btn', type: 'button', text: 'Portal view', title: "Show the portal's own queue (switch back under Tools)", onclick: () => setEnhanced(false) })));

      const counts = Object.fromEntries(SCOPES.map(s => [s.key, S.rows.filter(r => s.test(r, me)).length]));
      const scopes = h('div', { class: 'scopes', role: 'tablist' }, SCOPES.map(s =>
        h('button', { class: 'scope', type: 'button', role: 'tab', 'aria-selected': String(S.scope === s.key), onclick: () => { S.scope = s.key; S.sel.clear(); S.focus = -1; savePrefs(); render(); } },
          s.label, h('span', { class: 'count', text: String(counts[s.key]) }))));

      const bar = h('div', { class: 'bar' },
        h('label', { class: 'search' }, h('span', { class: 'muted', text: '⌕' }), searchInput, h('kbd', { text: '/' })),
        FILTERS.map(filterButton),
        h('select', { class: 'btn', style: 'width:150px', 'aria-label': 'Group by', onchange: e => { S.group = e.target.value; savePrefs(); render(); } },
          Object.entries(GROUPS).map(([k, v]) => h('option', { value: k, text: k ? `Group: ${v}` : v, selected: S.group === k }))),
        // Always there (hidden when there's nothing to clear), so turning a filter on moves nothing
        h('button', { class: 'linkish', type: 'button', text: 'Clear all', style: `width:56px;visibility:${Object.values(S.filters).some(v => v?.length) || S.q ? 'visible' : 'hidden'}`, onclick: () => { S.filters = {}; S.q = ''; searchInput.value = ''; savePrefs(); render(); } }));

      // Summary: what's in front of you, each number a one-click filter
      const scoped = visible({ ignore: 'due' });
      const nOver = scoped.filter(DUE.overdue.test).length;
      const nToday = scoped.filter(DUE.today.test).length;
      const nWeek = scoped.filter(DUE.week.test).length;
      const dueOn = k => (S.filters.due || []).includes(DUE[k].label);
      const stat = (n, label, cls, key) => h('button', { class: `stat ${cls}${key && dueOn(key) ? ' on' : ''}`, type: 'button', title: key ? `Show only: ${DUE[key].label}` : '', onclick: key ? () => toggleFilter('due', DUE[key].label, true) : null },
        h('b', { text: String(n) }), h('span', { text: label }));
      const byType = tally(rows, r => r.label);
      const summary = h('div', {},
        h('div', { class: 'summary' },
          stat(rows.length, `shown of ${S.rows.length} open`, ''),
          stat(nOver, 'overdue', nOver ? 'err' : '', 'overdue'),
          stat(nToday, 'due today', nToday ? 'warn' : '', 'today'),
          stat(nWeek, 'due in 7 days', '', 'week'),
          stat(rows.filter(r => r.status === 'WAITING').length, 'waiting', ''),
          stat(rows.filter(r => r.escalatedTo).length, 'escalated', ''),
          stat(rows.filter(r => r.createdMs > S.seenAt).length, 'new since last visit', '')),
        h('div', { class: 'chips' }, h('span', { class: 'muted', style: 'font-size:12px', text: 'Classes:' }), byType.length ? byType.slice(0, 10).map(([k, n]) => chip('type', k, n)) : h('span', { class: 'muted', style: 'font-size:12px', text: 'none' })),
        viewsBar());

      wrap.replaceChildren(top, scopes, bar, summary, h('div', { class: 'actionbar' }, bulkBar()), table(ordered), foot(ordered));
      if (S.pop) { const p = root.querySelector('.pop input[type=search]'); if (p) p.focus(); }
      if (focusEl) { searchInput.focus(); }
    }
    function tally(rows, fn) {
      const m = new Map();
      for (const r of rows) { const k = fn(r); m.set(k, (m.get(k) || 0) + 1); }
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    }
    function chip(key, val, n) {
      const on = (S.filters[key] || []).includes(val);
      return h('button', { class: `chip${on ? ' on' : ''}`, type: 'button', onclick: () => toggleFilter(key, val, true), text: `${val} · ${n}` });
    }
    function toggleFilter(key, val, only = false) {
      const cur = S.filters[key] || [];
      S.filters = { ...S.filters, [key]: cur.includes(val) ? cur.filter(v => v !== val) : only ? [val] : [...cur, val] };
      S.limit = 300;
      savePrefs();
      render();
    }
    function filterButton(f) {
      const want = S.filters[f.key] || [];
      // Same width picked or not: the count shows here, what's picked in the tooltip and the chips
      const btn = h('button', { type: 'button', class: want.length ? 'on' : '', 'aria-expanded': String(S.pop === f.key),
        title: want.length ? `${f.label}: ${want.join(', ')}` : `Filter by ${f.label.toLowerCase()}`,
        text: want.length ? `${f.label} · ${want.length} ▾` : `${f.label} ▾`,
        onclick: e => { e.stopPropagation(); S.pop = S.pop === f.key ? '' : f.key; S.popSearch = ''; render(); } });
      const box = h('div', { class: 'filter' }, btn);
      if (S.pop === f.key) {
        const opts = tally(visible({ ignore: f.key }).flatMap(r => filterVals(f, r).map(v => ({ v }))), x => x.v);
        for (const v of want) if (!opts.some(([k]) => k === v)) opts.push([v, 0]);
        const term = S.popSearch.toLowerCase();
        const list = opts.filter(([k]) => !term || k.toLowerCase().includes(term)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        box.append(h('div', { class: 'pop', onclick: e => e.stopPropagation() },
          f.searchable || opts.length > 12 ? h('input', { type: 'search', placeholder: `Find a ${f.label.toLowerCase()}`, value: S.popSearch, oninput: e => { S.popSearch = e.target.value; render(); } }) : null,
          list.slice(0, 200).map(([k, n]) => h('label', {},
            h('input', { type: 'checkbox', checked: want.includes(k), onchange: () => toggleFilter(f.key, k) }), h('span', { text: k }), h('span', { class: 'n', text: String(n) }))),
          list.length ? null : h('div', { class: 'muted', style: 'padding:6px', text: 'Nothing to pick.' }),
          h('div', { class: 'pop-actions' },
            h('button', { class: 'linkish', type: 'button', text: 'Clear', onclick: () => { S.filters = { ...S.filters, [f.key]: [] }; savePrefs(); render(); } }),
            h('button', { class: 'linkish', type: 'button', text: 'Done', onclick: () => { S.pop = ''; render(); } }))));
      }
      return box;
    }
    function viewsBar() {
      const views = prefs.views || [];
      return h('div', { class: 'views' },
        h('span', { text: 'Saved views:' }),
        views.map((v, i) => h('span', {},
          h('button', { class: 'chip', type: 'button', text: v.name, title: 'Apply this view', onclick: () => applyView(v) }),
          h('button', { class: 'linkish', type: 'button', text: '×', title: `Delete "${v.name}"`, 'aria-label': `Delete view ${v.name}`, onclick: () => { prefs.views.splice(i, 1); savePrefs(); render(); } }))),
        h('button', { class: 'linkish', type: 'button', text: '+ Save current view', onclick: saveView }));
    }
    function saveView() {
      const name = prompt('Name this view (scope, search, filters, sort and grouping are saved):');
      if (!name) return;
      prefs.views = [...(prefs.views || []).filter(v => v.name !== name), { name: clean(name), scope: S.scope, q: S.q, filters: S.filters, sort: S.sort, group: S.group }];
      savePrefs();
      render();
    }
    function applyView(v) {
      Object.assign(S, { scope: v.scope, q: v.q || '', filters: v.filters || {}, sort: v.sort || defaults.sort, group: v.group || '' });
      searchInput.value = S.q;
      S.sel.clear();
      savePrefs();
      render();
    }

    function bulkBar() {
      if (!S.sel.size) return h('div', { class: 'keys' },
        'Keys: ', h('kbd', { text: '/' }), ' search · ', h('kbd', { text: 'j' }), ' ', h('kbd', { text: 'k' }), ' move · ', h('kbd', { text: 'x' }), ' select · ',
        h('kbd', { text: 'Shift' }), '+click range · ', h('kbd', { text: 'Enter' }), ' open · ', h('kbd', { text: 'o' }), ' new tab · ', h('kbd', { text: 'Esc' }), ' clear · Shift-click a column to sort by two');
      const sel = selectedRows();
      return h('div', { class: 'bulk', role: 'toolbar', 'aria-label': 'Bulk actions' },
        h('span', { class: 'sel-n', text: `${sel.length} selected` }),
        BULK.map(a => {
          const n = sel.filter(r => a.can(r, S.me?.id)).length;
          return h('button', { class: `btn small${a.danger ? ' danger' : ''}`, type: 'button', disabled: !n, title: n < sel.length ? `${n} of ${sel.length} can be ${a.verb.toLowerCase()}` : '', text: n < sel.length && n ? `${a.label} (${n})` : a.label, onclick: () => runBulk(a) });
        }),
        h('span', { class: 'sep' }),
        h('button', { class: 'btn small', type: 'button', text: 'Copy refs', title: 'Tracking / entry numbers, one per line', onclick: () => copy(sel.map(r => r.ref).join('\n'), `${sel.length} references copied.`) }),
        h('button', { class: 'btn small', type: 'button', text: 'Copy links', onclick: () => copy(sel.map(r => location.origin + r.url).join('\n'), `${sel.length} links copied.`) }),
        h('button', { class: 'btn small', type: 'button', text: 'Export CSV', onclick: () => exportCsv(sel) }),
        h('button', { class: 'btn small', type: 'button', text: 'Open in tabs', onclick: () => openTabs(sel) }),
        h('button', { class: 'linkish', type: 'button', text: 'Clear', onclick: () => { S.sel.clear(); render(); } }));
    }
    const selectedRows = () => S.rows.filter(r => S.sel.has(r.id));

    function table(rows) {
      if (S.error) return h('div', { class: 'tablewrap' }, h('div', { class: 'empty err' }, `Couldn't load the queue: ${S.error} `, h('button', { class: 'btn small', type: 'button', text: 'Try again', onclick: () => load() })));
      if (!S.loadedAt && S.loading) return h('div', { class: 'tablewrap' }, h('div', { class: 'empty', text: 'Loading every open and waiting order…' }));
      const shown = rows.slice(0, S.limit);
      const allSel = rows.length > 0 && rows.every(r => S.sel.has(r.id));
      const head = h('tr', {},
        h('th', { class: 'cb' }, h('input', { type: 'checkbox', 'aria-label': 'Select every order shown', checked: allSel,
          onchange: e => { for (const r of rows) e.target.checked ? S.sel.add(r.id) : S.sel.delete(r.id); render(); } })),
        COLS.map(c => {
          const i = S.sort.findIndex(s => s.key === c.key);
          const arrow = i < 0 ? '' : `${S.sort[i].dir > 0 ? '▲' : '▼'}${S.sort.length > 1 ? i + 1 : ''}`;
          return h('th', { class: 'sortable', 'aria-sort': i < 0 ? 'none' : S.sort[i].dir > 0 ? 'ascending' : 'descending', title: 'Click to sort, Shift-click to add a second sort',
            onclick: e => sortBy(c.key, e.shiftKey) }, c.label, arrow ? h('span', { class: 'arrow', text: arrow }) : null);
        }));
      const body = [];
      let lastGroup = null;
      shown.forEach((r, i) => {
        if (S.group) {
          const g = groupOf(r);
          if (g !== lastGroup) {
            lastGroup = g;
            const members = rows.filter(x => groupOf(x) === g);
            const on = members.every(x => S.sel.has(x.id));
            body.push(h('tr', { class: 'group' }, h('td', { class: 'cb' }, h('input', { type: 'checkbox', checked: on, 'aria-label': `Select all in ${g}`,
              onchange: e => { for (const x of members) e.target.checked ? S.sel.add(x.id) : S.sel.delete(x.id); render(); } })),
              h('td', { colspan: String(COLS.length), text: `${g} · ${members.length}` })));
          }
        }
        body.push(rowEl(r, i));
      });
      return h('div', { class: 'tablewrap' },
        h('table', {}, h('colgroup', {}, h('col', { style: 'width:40px' }), COLS.map(c => h('col', { style: c.width ? 'width:' + c.width + 'px' : '' }))),
          h('thead', {}, head), h('tbody', {}, body)),
        rows.length ? null : h('div', { class: 'empty' }, emptyMessage()));
    }
    function emptyMessage() {
      if (!S.loadedAt) return 'Nothing loaded yet.';
      const q = clean(S.q);
      const kids = [h('p', { text: q ? `Nothing open matches "${q}" here.` : 'Nothing here.' })];
      if (q && S.scope !== 'all') kids.push(h('button', { class: 'btn small', type: 'button', text: 'Search all open orders', onclick: () => { S.scope = 'all'; render(); } }));
      if (q && !/\s/.test(q)) {
        if (S.extraFor === q && S.extra) {
          kids.push(S.extra.length ? h('div', { style: 'text-align:left;margin-top:10px' }, h('p', { class: 'muted', text: 'Found in the portal (any status):' }),
            S.extra.map(r => h('div', {}, h('a', { href: r.url, style: 'color:var(--accent)', onclick: e => openRow(r, e) }, `${r.label} · ${r.ref} · ${r.title}`), ` (${human2(r.status)}${r.assigneeName ? `, ${r.assigneeName}` : ''})`)))
            : h('p', { class: 'muted', text: 'The portal has no order with that exact number either.' }));
        } else {
          kids.push(h('button', { class: 'btn small', type: 'button', style: 'margin-left:6px', text: 'Look it up in the portal (includes closed)',
            onclick: async () => {
              S.extraFor = q; S.extra = null;
              try { S.extra = (await portal.search(q, 50)).map(queueRow); } catch (e) { toast(e.message, true); S.extra = []; }
              render();
            } }));
        }
      }
      return kids;
    }
    function rowEl(r, i) {
      const due = dueText(r);
      const isNew = r.createdMs > S.seenAt;
      const tr = h('tr', { class: `row${S.sel.has(r.id) ? ' sel' : ''}${S.focus === i ? ' focus' : ''}`, tabindex: '-1', 'data-i': String(i),
        onclick: e => { if (e.target.closest('input,button,a')) return; openRow(r, e); },
        onauxclick: e => { if (e.button === 1) { e.preventDefault(); GM_openInTab(location.origin + r.url, { active: false, insert: true }); } } },
        h('td', { class: 'cb' }, h('input', { type: 'checkbox', checked: S.sel.has(r.id), 'aria-label': `Select ${r.label} ${r.ref}`, onclick: e => selectClick(r, i, e) })),
        h('td', {}, h('span', { class: 'badge', text: r.label, title: r.label })),
        h('td', {}, h('div', { class: 'badges' }, h('span', { class: `badge st-${r.status}`, text: human2(r.status) }), r.escalatedTo ? h('span', { class: 'badge esc', text: `↑ ${r.escalatedTo === 'ENGINEERING' ? 'Eng' : human2(r.escalatedTo)}`, title: `Escalated to ${human2(r.escalatedTo)}${r.escalationNote ? `: ${r.escalationNote}` : ''}` }) : null)),
        h('td', {}, h('div', { class: 'title', title: r.items.join(' · ') || r.title }, isNew ? h('span', { class: 'new', title: 'New since your last visit' }) : null, r.title),
          r.problem ? h('div', { class: 'sub', title: r.detail, text: r.problem }) : null),
        h('td', {}, h('span', { class: 'ref' }, h('a', { href: r.url, onclick: e => openRow(r, e) }, r.ref)),
          h('button', { class: 'copy', type: 'button', title: 'Copy', 'aria-label': `Copy ${r.ref}`, text: '⧉', onclick: () => copy(r.ref, `Copied ${r.ref}`) }),
          r.entryNo && r.tracking ? h('div', { class: 'sub', text: `Entry ${r.entryNo}`, title: r.entryNo }) : r.mbol && r.ref !== r.mbol ? h('div', { class: 'sub', text: `MBOL ${r.mbol}`, title: r.mbol }) : null),
        h('td', {}, h('div', { class: 'clip', title: r.customer || r.consignee || '', text: r.customer || r.consignee || '—' }), r.customer && r.consignee && r.consignee !== r.customer ? h('div', { class: 'sub', title: r.consignee, text: r.consignee }) : null),
        h('td', { class: due.cls }, h('div', { class: 'clip', text: due.text }), due.sub ? h('div', { class: 'sub', style: 'color:inherit', text: due.sub }) : null),
        h('td', { class: 'muted', text: r.createdMs ? ageText(r.createdMs) : '—' }),
        h('td', {}, h('div', { class: 'clip' + (r.assigneeName ? '' : ' muted'), title: r.assigneeName, text: r.assigneeId && r.assigneeId === S.me?.id ? 'You' : r.assigneeName || '—' })));
      return tr;
    }
    function foot(rows) {
      return h('div', { class: 'foot' },
        h('span', { text: `${Math.min(rows.length, S.limit)} of ${rows.length} shown${S.missing?.length ? ` · not found: ${S.missing.join(', ')}` : ''}` }),
        rows.length > S.limit ? h('button', { class: 'btn small', type: 'button', text: `Show ${Math.min(300, rows.length - S.limit)} more`, onclick: () => { S.limit += 300; render(); } }) : null,
        S.missing?.length ? h('button', { class: 'btn small', type: 'button', text: 'Copy not found', onclick: () => copy(S.missing.join('\n'), 'Copied.') }) : null);
    }

    // ---- interaction
    function sortBy(key, add) {
      const i = S.sort.findIndex(s => s.key === key);
      if (add) {
        if (i >= 0) S.sort[i] = { key, dir: -S.sort[i].dir };
        else S.sort = [...S.sort, { key, dir: 1 }].slice(-3);
      } else {
        S.sort = [{ key, dir: i === 0 ? -S.sort[0].dir : 1 }];
      }
      savePrefs();
      render();
    }
    function selectClick(r, i, e) {
      if (e.shiftKey && S.anchor >= 0) {
        const [a, b] = [Math.min(S.anchor, i), Math.max(S.anchor, i)];
        const on = !S.sel.has(r.id);
        for (const x of S.shown.slice(a, b + 1)) on ? S.sel.add(x.id) : S.sel.delete(x.id);
      } else if (S.sel.has(r.id)) S.sel.delete(r.id);
      else S.sel.add(r.id);
      S.anchor = i;
      render();
    }
    function openRow(r, e) {
      if (e) {
        e.preventDefault?.();
        if (e.ctrlKey || e.metaKey || e.button === 1) { GM_openInTab(location.origin + r.url, { active: false, insert: true }); return; }
      }
      goTo(r.url);
    }
    function moveFocus(step) {
      if (!S.shown.length) return;
      S.focus = Math.max(0, Math.min(S.shown.length - 1, (S.focus < 0 ? -1 : S.focus) + step));
      if (S.focus >= S.limit) S.limit = S.focus + 50;
      render();
      root.querySelector(`tr.row[data-i="${S.focus}"]`)?.scrollIntoView({ block: 'nearest' });
      root.querySelector(`tr.row[data-i="${S.focus}"]`)?.focus({ preventScroll: true });
    }
    // Typed anywhere on the page (not in a box): the queue's own keys
    function onKey(e) {
      if (!host.isConnected || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.composedPath()[0];
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (root.querySelector('.scrim')) { if (e.key === 'Escape') root.querySelector('.scrim').remove(); return; }
      if (e.key === 'Escape' && S.pop) { S.pop = ''; render(); return; }
      if (e.key === '/' && !typing) { e.preventDefault(); searchInput.focus(); searchInput.select(); return; }
      if (typing) return;
      const r = S.shown[S.focus];
      if (e.key === 'j') { moveFocus(1); e.preventDefault(); }
      else if (e.key === 'k') { moveFocus(-1); e.preventDefault(); }
      else if (e.key === 'x' && r) { selectClick(r, S.focus, e); e.preventDefault(); }
      else if (e.key === 'Enter' && r) { openRow(r); e.preventDefault(); }
      else if (e.key === 'o' && r) { GM_openInTab(location.origin + r.url, { active: false, insert: true }); e.preventDefault(); }
      else if (e.key === 'Escape') { if (S.pop) S.pop = ''; else S.sel.clear(); render(); }
    }
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', () => { if (S.pop) { S.pop = ''; render(); } });

    function toast(text, err = false) {
      root.querySelector('.toast')?.remove();
      const t = h('div', { class: `toast${err ? ' err' : ''}`, role: 'status', text });
      root.append(t);
      setTimeout(() => t.remove(), err ? 9000 : 4000);
    }
    function copy(text, msg) { GM_setClipboard(text, 'text'); toast(msg); }
    function exportCsv(rows) {
      const cols = ['Class', 'Status', 'Escalated to', 'Item', 'Problem', 'Tracking', 'Entry', 'Master bill', 'Customer', 'Consignee', 'Due', 'Created', 'Assignee', 'Link', 'Work order id'];
      const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [cols.map(q).join(','), ...rows.map(r => [r.label, r.status, r.escalatedTo, r.title, r.problem, r.tracking, r.entryNo, r.mbol, r.customer, r.consignee,
        r.dueMs ? new Date(r.dueMs).toISOString().slice(0, 10) : '', r.createdMs ? new Date(r.createdMs).toISOString().slice(0, 10) : '', r.assigneeName, location.origin + r.url, r.id].map(q).join(','))];
      const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' })), download: `work-queue-${new Date().toISOString().slice(0, 10)}.csv` });
      root.append(a); a.click(); a.remove();
      toast(`Exported ${rows.length} orders.`);
    }
    function openTabs(rows) {
      if (rows.length > 10 && !confirm(`Open ${rows.length} tabs?`)) return;
      for (const r of rows.slice(0, 40)) GM_openInTab(location.origin + r.url, { active: false, insert: true });
    }

    // ---- bulk actions: a dialog says exactly what will happen, in which mode, before anything is sent
    function runBulk(a) {
      const sel = selectedRows();
      const ok = sel.filter(r => a.can(r, S.me?.id));
      const skipped = sel.length - ok.length;
      const mode = portal.mode();
      const note = a.note ? h('textarea', { 'aria-label': 'Note', placeholder: a.note === 'required' ? 'Required' : 'Optional' }) : null;
      const target = a.target ? h('select', { 'aria-label': 'Escalate to' }, h('option', { value: 'BROKER', text: 'Broker' }), h('option', { value: 'ENGINEERING', text: 'Engineering' })) : null;
      const resolution = a.resolution ? h('select', { 'aria-label': 'Resolution' }, h('option', { value: '', text: 'Pick a resolution' }),
        Object.entries(RESOLUTIONS).map(([k, v]) => h('option', { value: k, text: v }))) : null;
      const people = new Map();
      if (S.me?.id) people.set(S.me.id, `${S.me.name || 'Me'} (me)`);
      for (const r of S.rows) if (r.assigneeId && !people.has(r.assigneeId)) people.set(r.assigneeId, r.assigneeName || r.assigneeId);
      const assignee = a.assignee ? h('select', { 'aria-label': 'Assign to' }, [...people].sort((x, y) => x[1].localeCompare(y[1])).map(([id, name]) => h('option', { value: id, text: name }))) : null;
      const bar = h('div', { class: 'progress', hidden: true }, h('div'));
      const msg = h('p', { class: 'err', hidden: true });
      const go = h('button', { class: `btn ${a.danger ? 'danger' : 'primary'}`, type: 'button', text: `${a.label.replace('…', '')} ${ok.length}` });
      const cancel = h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => scrim.remove() });
      const scrim = h('div', { class: 'scrim', onclick: e => { if (e.target === scrim) scrim.remove(); } },
        h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': a.label },
          h('h2', { text: `${a.label.replace('…', '')} ${ok.length} order${ok.length === 1 ? '' : 's'}` }),
          h('p', {}, 'In ', h('span', { class: `mode ${mode}`, text: mode.toUpperCase() }), ' mode, through the portal, the same as its own buttons.',
            skipped ? ` ${skipped} selected order${skipped === 1 ? " can't" : "s can't"} be ${a.verb.toLowerCase()} and ${skipped === 1 ? 'is' : 'are'} skipped.` : ''),
          h('div', { class: 'list' }, ok.slice(0, 60).map(r => h('div', { text: `${r.label} · ${r.ref} · ${r.customer || r.consignee || ''}` })), ok.length > 60 ? h('div', { text: `…and ${ok.length - 60} more` }) : null),
          target ? [h('label', { class: 'f', text: 'Escalate to' }), target] : null,
          resolution ? [h('label', { class: 'f', text: 'Resolution' }), resolution] : null,
          assignee ? [h('label', { class: 'f', text: 'Assign to' }), assignee] : null,
          note ? [h('label', { class: 'f', text: a.note === 'required' ? 'Note (required)' : 'Note (optional)' }), note] : null,
          msg, bar,
          h('div', { class: 'actions' }, cancel, go)));
      go.addEventListener('click', async () => {
        const vars = {};
        if (note) { const v = note.value.trim(); if (a.note === 'required' && !v) { msg.textContent = 'Add a note first.'; msg.hidden = false; return; } if (v) vars.note = v; }
        if (target) vars.target = target.value;
        if (resolution) { if (!resolution.value) { msg.textContent = 'Pick a resolution first.'; msg.hidden = false; return; } vars.resolution = resolution.value; }
        if (assignee) vars.assigneeId = assignee.value;
        msg.hidden = true;
        go.disabled = cancel.disabled = true;
        bar.hidden = false;
        const res = await portal.act(a.op, ok.map(r => r.id), vars, (d, n) => { bar.firstChild.style.width = `${Math.round(d / n * 100)}%`; });
        scrim.remove();
        for (const id of res.done) S.sel.delete(id);
        const byId = new Map(S.rows.map(r => [r.id, r]));
        const fails = res.failed.map(f => `${byId.get(f.id)?.ref || f.id}: ${f.error}`);
        toast(`${a.verb} ${res.done.length} order${res.done.length === 1 ? '' : 's'}.${fails.length ? `\n${fails.length} failed:\n${fails.slice(0, 6).join('\n')}${fails.length > 6 ? '\n…' : ''}` : ''}`, fails.length > 0);
        load({ quiet: true });
      });
      root.append(scrim);
      (note || target || resolution || assignee || go).focus();
    }

    // ---- Prev / Next on order pages follow the queue exactly as you last left it
    function saveNav(rows) {
      GM_setValue(NAV_KEY, { at: Date.now(), items: rows.slice(0, 1500).map(r => ({
        url: r.url, label: r.label, title: r.title, ref: r.ref, tracking: r.tracking, entryNo: r.entryNo, mbol: r.mbol, customer: r.customer || r.consignee,
        due: r.dueMs, status: r.status, assignee: r.assigneeName, escalatedTo: r.escalatedTo, problem: r.problem, id: r.id, created: r.createdMs,
      })) });
    }

    // ---- showing it in place of the portal's own queue. The portal's queue is the default; the Tools queue is
    // a choice under Tools (the Tools tab's queue switch, or Setup), remembered on this computer.
    const native = () => [...(document.querySelector('main')?.children || [])].find(el => el !== host);
    function setEnhanced(on) {
      GM_setValue(QUEUE_VIEW_KEY, on ? 'tools' : 'portal');
      if (on) mount(); else unmount();
    }
    let started = false;
    // On the portal's own queue, a switch to the Tools queue sits by its "Updated … ↻", where the Tools queue
    // has its "Portal view" button. It lives in the page, so it's put back whenever the portal redraws.
    const switchBtn = h('button', { id: 'zt-queue-switch', type: 'button', text: '⚡ Tools queue', title: 'Switch to the Tools queue (search everything, filters, bulk actions)',
      style: 'margin-left:8px;padding:4px 10px;border-radius:6px;border:1px solid #f59e0b;background:rgba(245,158,11,.10);color:#f59e0b;font:600 12.5px system-ui,sans-serif;cursor:pointer',
      onclick: () => setEnhanced(true) });
    function placeSwitch() {
      if (!onQueuePage() || toolsQueueOn()) { switchBtn.remove(); return; }
      const updated = [...(document.querySelector('main')?.querySelectorAll('div') || [])].find(e => /^Updated\s/.test(e.textContent.trim()) && e.textContent.length < 40 && e.children.length < 4);
      if (updated && switchBtn.parentElement !== updated) updated.append(switchBtn);
    }
    function mount() {
      const main = document.querySelector('main');
      if (!main || !onQueuePage()) return;
      if (!toolsQueueOn()) { unmount(); placeSwitch(); return; }
      switchBtn.remove();
      const nat = native();
      if (nat && nat.style.display !== 'none') nat.style.display = 'none';
      if (host.parentElement !== main || main.firstElementChild !== host) main.prepend(host);
      if (!started) {
        started = true;
        // The first visit has nothing to compare with, so nothing is marked new until the next one
        S.seenAt = GM_getValue(SEEN_KEY, 0) || Date.now();
        render();
        load();
        setAuto(S.auto);
      }
    }
    function unmount() {
      if (!onQueuePage()) switchBtn.remove();
      if (!host.isConnected) return;
      const nat = native();
      if (nat) nat.style.display = '';
      host.remove();
      GM_setValue(SEEN_KEY, Date.now());
      started = false;
      clearInterval(autoTimer);
    }
    queueCtl = { setEnhanced };
    return { mount, unmount };
  }

  // Moves to a portal page the way its own links do (no full reload) when the app's router is reachable
  function goTo(url) {
    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    try {
      const r = W.next?.router;
      if (r?.push) { r.push(url); return; }
    } catch { /* falls back to a normal load */ }
    location.assign(url);
  }

  // The order the current page is about, from the queue as you last left it
  function navPosition() {
    const nav = GM_getValue(NAV_KEY, null);
    if (!nav?.items?.length) return { items: [], i: -1 };
    const here = decodeURIComponent(location.pathname).replace(/\/$/, '');
    const i = nav.items.findIndex(it => decodeURIComponent(it.url.split('?')[0]) === here);
    return { items: nav.items, i, at: nav.at };
  }

  // The portal's own Classify / Quote rail on order pages is hidden: Classify and Quote are built into Tools.
  const RAIL_CSS_ID = 'zt-rail-css';
  function hideRail(on) {
    let el = document.getElementById(RAIL_CSS_ID);
    if (!on) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('style');
      el.id = RAIL_CSS_ID;
      el.textContent = `
        div:has(> div > button[title="Classify"][aria-pressed]) { display: none !important; }
        div.shrink-0:has(button[title="Classify"][aria-pressed]) { width: 0 !important; min-width: 0 !important; }`;
    }
    if (!el.isConnected) (document.head || document.documentElement).append(el);
  }

  /* ------------------------------------------- dashboard: order pages, easier to read */

  // Keeps the portal's look, and makes two things plain: the run-together "Entry … · consignee … · ship-from KR"
  // lines become a labeled grid (blank values left out, countries named), and every all-caps CBP message gets a
  // plain-English line under it. The portal's own text is never changed; it's hidden or added to.
  const READABLE_KEY = 'zt:readable';
  const ABBR = {
    DESC: 'description', MERCH: 'merchandise', INV: 'invoice', QTY: 'quantity', REQ: 'required', REQD: 'required', MISS: 'missing',
    INVLD: 'invalid', NO: 'number', NBR: 'number', NUM: 'number', ET: 'entry type', HTS: 'HTS', TARIFF: 'tariff', ORIG: 'origin', CTRY: 'country',
    MFR: 'manufacturer', MANUF: 'manufacturer', MID: 'manufacturer ID (MID)', IOR: 'importer of record', CNEE: 'consignee', SHPR: 'shipper',
    VAL: 'value', AMT: 'amount', DT: 'date', INFO: 'information', NOT: 'not', ON: 'on', FILE: 'file', ACCPT: 'accepted', ACPT: 'accepted',
    REJ: 'rejected', SUMM: 'summary', SUM: 'summary', PGA: 'PGA', FDA: 'FDA', USDA: 'USDA', CBP: 'CBP', ACE: 'ACE', AD: 'AD', CVD: 'CVD',
    BOND: 'bond', DUP: 'duplicate', DUPL: 'duplicate', CERT: 'certificate', DOC: 'document', DOCS: 'documents', PORT: 'port', TRANS: 'transaction',
    CONV: 'conveyance', ARRV: 'arrival', ARR: 'arrival', HAWB: 'house air waybill', MAWB: 'master air waybill', BOL: 'bill of lading', SE: 'SE',
  };
  function plainEnglish(text) {
    const words = text.replace(/\//g, ' / ').split(/\s+/).filter(Boolean).map(w => {
      const m = w.match(/^([A-Z]+)(\d+)$/);
      if (m && ABBR[m[1]] && m[1].length <= 3) return `${ABBR[m[1]]} ${m[2]}`;   // ET13 -> entry type 13
      return ABBR[w] || w.toLowerCase();   // known acronyms stay as they are (they map to themselves)
    });
    const s = words.join(' ').replace(/\s+\/\s+/g, ' / ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const READABLE_CSS = `
    .zt-meta { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px 18px; margin-top: 8px; }
    .zt-meta > div { min-width: 0; }
    .zt-meta dt { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .75; }
    .zt-meta dd { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
    .zt-plain { display: block; margin-top: 2px; font-size: 12.5px; font-weight: 400; text-transform: none; letter-spacing: normal; opacity: .85; }
  `;
  function makeReadable() {
    const main = document.querySelector('main');
    if (!main || !isCasePage()) return;
    if (!document.getElementById('zt-readable-css')) {
      const st = document.createElement('style');
      st.id = 'zt-readable-css';
      st.textContent = READABLE_CSS;
      (document.head || document.documentElement).append(st);
    }
    // "Label <value> · label <value> · …" lines
    for (const p of main.querySelectorAll('p')) {
      if (p.dataset.ztSrc === p.textContent && p.nextElementSibling?.classList.contains('zt-meta')) continue;
      const vals = [...p.children].filter(c => c.tagName === 'SPAN');
      if (vals.length < 3 || p.closest('#zt-queue-host')) continue;
      const pairs = [];
      let label = '';
      for (const n of p.childNodes) {
        if (n.nodeType === 3) label += n.textContent;
        else if (n.tagName === 'SPAN') { pairs.push([clean(label.replace(/^\s*·\s*/, '').replace(/·/g, '')), clean(n.textContent)]); label = ''; }
      }
      if (pairs.length < 3 || pairs.some(([l]) => !l || l.length > 30)) continue;
      if (p.nextElementSibling?.classList.contains('zt-meta')) p.nextElementSibling.remove();
      const country = /ship-from|exported from|origin|country/i;
      const grid = h('dl', { class: 'zt-meta text-muted-foreground' },
        pairs.filter(([, v]) => v && v !== '—' && v !== '-').map(([l, v]) => {
          const shown = country.test(l) && /^[A-Z]{2}$/.test(v) ? `${regionName(v)} (${v})` : v;
          return h('div', {}, h('dt', { text: l.charAt(0).toUpperCase() + l.slice(1) }), h('dd', { class: 'text-foreground', text: shown }));
        }));
      p.dataset.ztSrc = p.textContent;
      p.style.display = 'none';
      p.after(grid);
    }
    // All-caps CBP messages: "336 — INVOICE/MERCH DESC REQUIRED FOR ET13", "Cargo release: 336 INVOICE/…"
    // Only lines that carry a CBP code ("336 — …", "Cargo release: 336 …"), so all-caps item names are left alone
    for (const el of main.querySelectorAll('p, div')) {
      if (el.closest('.zt-meta, #zt-queue-host')) continue;
      if ([...el.children].some(c => !/^(SPAN|CODE|B|STRONG|EM|BUTTON)$/.test(c.tagName))) continue;   // the code itself is a tooltip button
      const text = clean([...el.childNodes].filter(n => !(n.classList?.contains('zt-plain'))).map(n => n.textContent).join(''));
      const m = text.match(/^(?:[^:]{0,40}:\s*)?\d{2,3}\s*[—–-]?\s*([A-Z0-9][A-Z0-9/&().,' -]{6,}?)\s*(\([^)]*\))?$/);
      if (!m || /[a-z]/.test(m[1]) || m[1].replace(/[^A-Z]/g, '').length < 8) continue;
      const plain = plainEnglish(m[1].trim());
      const existing = el.querySelector(':scope > .zt-plain');
      if (existing?.textContent === plain) continue;
      existing?.remove();
      el.append(h('span', { class: 'zt-plain', text: plain }));
    }
  }
  function undoReadable() {
    for (const g of document.querySelectorAll('.zt-meta, .zt-plain')) g.remove();
    for (const p of document.querySelectorAll('p[data-zt-src]')) { p.style.display = ''; delete p.dataset.ztSrc; }
  }

  /* ------------------------------------------- duty disputes: what a "Disputed program compliance_program_…" is */

  // A questionnaire dispute names the program it claims only by its id. The dispute's questionnaire session
  // (the same data the portal loads, asked for on behalf of the order's company) has the program's name,
  // type and code, and each question with the merchant's answer. Shown next to the id on the page, and put
  // into the research prompt.
  const programs = new Map();   // program id -> { name, code, type, authority, qa: [[question, answer]] }
  let programsFor = '';
  const PROGRAMS_KEY = 'zt:programs';   // show them on the page (Settings; off by default)
  async function loadPrograms(disputeId) {
    programsFor = disputeId;
    try {
      const d = (await portal.gql('BrokerageDutyDispute', 'query BrokerageDutyDispute($id: ID!) { brokerageDutyDispute(id: $id) { id organizationId items { questionnaireSessionId } } }', { id: disputeId })).brokerageDutyDispute;
      const sessions = [...new Set((d?.items || []).map(i => i.questionnaireSessionId).filter(Boolean))];
      for (const id of sessions) {
        const s = (await portal.gql('QuestionnaireSessionForDutyDispute', `query QuestionnaireSessionForDutyDispute($id: ID!) { questionnaireSession(id: $id) {
          id lines { programId program { id code name programType authority }
            visibleQuestions { question { prompt displayOrder } answer { value label } } } } }`, { id }, { 'x-act-as-org': d.organizationId })).questionnaireSession;
        for (const l of s?.lines || []) {
          const p = l.program || {};
          programs.set(l.programId || p.id, {
            name: p.name || '', code: p.code || '', type: p.programType || '', authority: p.authority || '',
            qa: (l.visibleQuestions || []).slice().sort((a, b) => (a.question?.displayOrder ?? 0) - (b.question?.displayOrder ?? 0))
              .map(v => [clean(v.question?.prompt), clean(v.answer?.label || v.answer?.value || '') || '(no answer)']),
          });
        }
      }
      showPrograms();
    } catch (e) { console.warn('[Tools] questionnaire programs', e); }
  }
  const programLabel = p => [p.name, [p.type, p.code].filter(Boolean).join(' · ')].filter(Boolean).join(' — ');
  function showPrograms() {
    const main = document.querySelector('main');
    if (!main || !DISPUTE_PATH.test(location.pathname)) return;
    const id = location.pathname.split('/').filter(Boolean).pop();
    if (programsFor !== id) { loadPrograms(id); return; }   // loaded either way: the research prompt uses it
    const on = GM_getValue(PROGRAMS_KEY, false);
    // Turned off: the ids come back and the questionnaire lists go
    if (!on) {
      for (const b of main.querySelectorAll('.zt-program')) b.remove();
      for (const el of main.querySelectorAll('[data-zt-program]')) { el.textContent = el.dataset.ztProgram; el.removeAttribute('title'); delete el.dataset.ztProgram; }
      return;
    }
    // The id itself ("compliance_program_…", the bold text after "Disputed program") is replaced by what it is;
    // the id stays in its tooltip. The questions and answers fold out under the line.
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const m = n.textContent.match(/compliance_program_\w+/);
      if (m && programs.has(m[0]) && !n.parentElement.closest('.zt-program')) hits.push([n, m[0]]);
    }
    for (const [node, pid] of hits) {
      const p = programs.get(pid);
      const el = node.parentElement;
      const whole = el.textContent.trim() === pid;   // the id has its own element (the bold part): swap its text
      if (whole) { el.dataset.ztProgram = pid; el.textContent = programLabel(p); el.title = pid; }
      else node.textContent = node.textContent.replace(pid, programLabel(p));
      const line = (whole ? el.parentElement : el);
      if (!p.qa.length || (line.nextElementSibling?.classList.contains('zt-program') && line.nextElementSibling.dataset.id === pid)) continue;
      line.after(h('details', { class: 'zt-program text-sm', 'data-id': pid, style: 'margin:4px 0 8px' },
        h('summary', { class: 'text-muted-foreground', style: 'cursor:pointer', text: `Questionnaire: ${p.qa.length} question${p.qa.length === 1 ? '' : 's'} and the merchant's answers` }),
        h('ol', { style: 'margin:6px 0 0 18px;list-style:decimal' }, p.qa.map(([q, a]) => h('li', { style: 'margin:4px 0' },
          h('span', { class: 'text-muted-foreground', text: q }), h('br'), h('strong', { text: a }))))));
    }
  }
  // For the research prompt: each program claimed on this dispute, with its questions and answers
  function programLines() {
    if (!programs.size || !DISPUTE_PATH.test(location.pathname)) return [];
    const L = ['', '## Questionnaire programs claimed', '(What the "Disputed program" ids on the page are, from the dispute\'s questionnaire session. The answers are the merchant\'s claims: check each one against the documents and the real listing, and say which are matched, contradicted or unsupported.)'];
    for (const [id, p] of programs) {
      L.push(`- ${programLabel(p)} (${id})${p.authority ? `, authority ${p.authority}` : ''}`);
      for (const [q, a] of p.qa) L.push(`  - Q: ${q}`, `    A: ${a}`);
    }
    return L;
  }

  /* ------------------------------------------- denied-party reviews: "Listed on" goes to the list itself */

  // The portal links each match's list to a Google search. This sends it to the list's own official page
  // instead: the source's own link when the screening has one (EU matches carry their EUR-Lex regulation),
  // otherwise the list's official search or publication page. The listed name is copied as you click, ready
  // to paste into that site's search. Alt-click (or a list with no official page) keeps the Google search.
  const LIST_PAGES = [
    [/European Union|\bEU\b/i, 'https://www.sanctionsmap.eu/#/main'],
    [/British Columbia Securities/i, 'https://www.bcsc.bc.ca/enforcement/early-intervention/investment-caution-list'],
    [/Directorate of Fisheries/i, 'https://www.fiskeridir.no/english/Fisheries/iuu-and-the-norwegian-blacklist'],
    [/Foreign Affairs and Trade/i, 'https://www.dfat.gov.au/international-relations/security/sanctions/consolidated-list'],
    [/Foreign Affairs and International Trade|Global Affairs Canada/i, 'https://www.international.gc.ca/world-monde/international_relations-relations_internationales/sanctions/consolidated-consolide.aspx?lang=eng'],
    [/Health\s*(&|and)?\s*Human Services|\bOIG\b/i, 'https://exclusions.oig.hhs.gov/'],
    [/System for Award Management|\bSAM\b/i, 'https://sam.gov/search/?index=ex'],
    [/Consolidated Screening List|Entity List|Denied Persons|Unverified List|Military End|\bBIS\b|Commerce/i, 'https://www.trade.gov/data-visualization/csl-search'],
    [/OFAC|Specially Designated|Treasury|Foreign Sanctions Evaders|Sectoral/i, 'https://sanctionssearch.ofac.treas.gov/'],
    [/Securities and Exchange Commission|\bSEC\b|Department of Justice/i, 'https://www.sec.gov/enforcement-litigation/litigation-releases'],
    [/United Nations|Security Council/i, 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list'],
    [/HM Treasury|OFSI|United Kingdom|\bUK\b/i, 'https://search-uk-sanctions-list.service.gov.uk/'],
  ];
  // The screening details the portal loaded (PartyScreeningDetail): each match's list and its own links
  function screeningSources() {
    const out = [];
    const walk = (n, d = 0) => {
      if (!n || typeof n !== 'object' || d > 12) return;
      if (typeof n.source === 'string' && ('sourceUrls' in n || 'aliases' in n)) out.push(n);
      for (const v of Array.isArray(n) ? n : Object.values(n)) walk(v, d + 1);
    };
    for (const c of desk.debug().captured) if (c.op === 'PartyScreeningDetail') walk(c.json?.data);
    return out;
  }
  function listLinkFor(a) {
    let q = '';
    try { q = new URL(a.dataset.ztGoogle || a.href).searchParams.get('q') || ''; } catch { return null; }
    const source = clean(a.textContent);
    const name = (q.match(/"([^"]+)"/) || [])[1] || clean(q.replace(source, ''));
    const match = screeningSources().find(p => clean(p.source) === source && (!name || [p.name, p.companyName, ...(p.aliases || [])].some(x => clean(x).toLowerCase() === name.toLowerCase())))
      || screeningSources().find(p => clean(p.source) === source);
    const own = (match?.sourceUrls || []).find(u => /^https?:\/\//.test(u));
    const page = own || (LIST_PAGES.find(([re]) => re.test(source)) || [])[1];
    return page ? { url: page, name } : null;
  }
  const LIST_LINKS_KEY = 'zt:listLinks';     // "Listed on" opens the official list (Settings)
  const ENTRY_CLICKS_KEY = 'zt:entryClicks'; // a code clicked on the page opens Entry Assistant in Tools (Settings)
  function fixListLinks() {
    if (!/DENIED_PARTY_REVIEW/.test(location.pathname)) return;
    if (!GM_getValue(LIST_LINKS_KEY, false)) {   // turned off: the portal's Google links come back
      for (const a of document.querySelectorAll('main a[data-zt-google]')) { a.setAttribute('href', a.dataset.ztGoogle); a.removeAttribute('title'); delete a.dataset.ztGoogle; delete a.dataset.ztName; }
      return;
    }
    for (const a of document.querySelectorAll('main a[href^="https://www.google.com/search"]')) {
      const link = listLinkFor(a);
      if (!link) continue;
      a.dataset.ztGoogle = a.dataset.ztGoogle || a.href;
      a.dataset.ztName = link.name;
      if (a.getAttribute('href') !== link.url) a.setAttribute('href', link.url);
      a.title = `Opens the list's official page. "${link.name}" is copied as you click, to paste into its search. Alt-click for the Google search.`;
    }
  }
  window.addEventListener('click', e => {
    const a = e.target?.closest?.('a[data-zt-google]');
    if (!a) return;
    if (e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); window.open(a.dataset.ztGoogle, '_blank', 'noreferrer'); return; }
    if (a.dataset.ztName) GM_setClipboard(a.dataset.ztName, 'text');
  }, true);

  /* ------------------------------------------------- dashboard: the panel */

  const PANEL_CSS = `
    :host { all: initial; --bg:#ffffff; --fg:#18181b; --muted:#71717a; --line:#e4e4e7; --soft:#f4f4f5; --tint:#fff7ed; --accent:#b45309; --accent-fg:#ffffff; --ok:#15803d; --warn:#b45309; --err:#b91c1c; }
    :host([data-theme="dark"]) { --bg:#0c0c0d; --fg:#f4f4f5; --muted:#a1a1aa; --line:#27272a; --soft:#18181b; --tint:#2a1d0a; --accent:#f59e0b; --accent-fg:#111111; --ok:#4ade80; --warn:#fbbf24; --err:#f87171; }
    * { box-sizing: border-box; }
    .wrap { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); }
    button { font: inherit; cursor: pointer; }
    button:disabled { opacity: .55; cursor: default; }
    button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .launch { position: fixed; z-index: 2147483000; width: 58px; height: 58px; display: grid; place-items: center; background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 50%; padding: 0; font-weight: 700; font-size: 12px; line-height: 1.1; box-shadow: 0 6px 20px rgba(0,0,0,.4); cursor: grab; touch-action: none; user-select: none; }
    .launch .ico { display: block; font-size: 18px; }
    .launch.dragging { cursor: grabbing; transform: scale(1.06); }
    .panel { position: fixed; top: 0; right: 0; height: 100vh; width: min(var(--w, 480px), 100vw); z-index: 2147483001; display: flex; flex-direction: column; background: var(--bg); color: var(--fg); border-left: 1px solid var(--line); box-shadow: -10px 0 30px rgba(0,0,0,.3); }
    .panel.docked { box-shadow: none; }
    .panel.overlay { top: 12px; right: 12px; height: calc(100vh - 24px); width: min(var(--w, 480px), calc(100vw - 24px)); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; box-shadow: 0 24px 70px rgba(0,0,0,.55); }
    .panel.resizing { user-select: none; }
    .panel.resizing iframe { pointer-events: none; }
    [hidden] { display: none !important; }
    .grip { position: absolute; top: 0; bottom: 0; left: -4px; width: 8px; cursor: col-resize; z-index: 2; }
    .panel.grip-right .grip { left: auto; right: -4px; }
    .grip::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: transparent; }
    .grip:hover::after, .grip:focus-visible::after, .resizing .grip::after { background: var(--accent); }
    .grip:focus-visible { outline: none; }
    header { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; padding: 6px 8px 0 10px; border-bottom: 1px solid var(--line); }
    .tabs { display: flex; gap: 0; min-width: 0; overflow-x: auto; scrollbar-width: none; }
    .tab { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--muted); padding: 9px 7px 8px; font-weight: 600; white-space: nowrap; }
    .tab:hover { color: var(--fg); }
    .tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }
    .header-actions { display: flex; align-items: center; gap: 2px; padding-bottom: 5px; }
    .icon { background: none; border: 0; color: var(--muted); font-size: 18px; line-height: 1; padding: 3px 6px; border-radius: 6px; }
    .icon:hover, .icon[aria-pressed="true"] { color: var(--fg); background: var(--soft); }
    .view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .body { flex: 1; overflow-y: auto; padding: 14px 16px; }
    footer { border-top: 1px solid var(--line); padding: 12px 16px; }
    .entry-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted); }
    .entry-caption { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .entry-bar a { flex: none; font-size: 12px; }
    .entry-frame { flex: 1; display: block; width: 100%; min-height: 0; border: 0; background: var(--bg); }
    .entry-blocked { padding: 16px; }
    .entry-blocked p { margin: 0 0 12px; }
    a.primary, a.secondary { display: inline-block; text-decoration: none; }
    .group { margin-bottom: 16px; }
    .group .row { margin-top: 6px; }
    .section { margin-bottom: 18px; }
    .label { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
    .row { display: flex; gap: 6px; }
    .row > button { flex: none; white-space: nowrap; }
    input[type="text"], input[type="password"] { flex: 1; min-width: 0; font: inherit; background: var(--soft); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
    .primary { background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 6px; padding: 8px 12px; font-weight: 600; }
    .secondary { background: transparent; color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 7px 12px; }
    .secondary:hover { background: var(--soft); }
    .muted { color: var(--muted); }
    .hint { color: var(--muted); font-size: 12px; margin: 4px 0 0; }
    .ok { color: var(--ok); } .warn { color: var(--warn); } .err { color: var(--err); }
    .chip { display: inline-block; padding: 0 6px; border: 1px solid var(--line); border-radius: 999px; font-size: 11px; color: var(--muted); }
    .sub-block { margin: 6px 0 0 40px; }
    .lines { display: grid; gap: 8px; }
    .line { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: start; padding: 10px 12px; border: 2px solid var(--line); border-radius: 8px; cursor: pointer; }
    .line:hover { border-color: var(--muted); }
    .line.on { border-color: var(--accent); background: var(--tint); }
    .line input { width: 18px; height: 18px; margin: 1px 0 0; accent-color: var(--accent); cursor: pointer; }
    .line-main { min-width: 0; }
    .line:not(.on) .line-main { color: var(--muted); }
    .line-name { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
    .line-name strong { white-space: nowrap; }
    .line-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .line-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 6px; }
    .tag { padding: 0 6px; border-radius: 4px; background: var(--soft); font-size: 11px; color: var(--fg); }
    .docs summary { cursor: pointer; color: var(--muted); font-size: 12px; }
    .doc { display: flex; align-items: baseline; gap: 6px; margin: 4px 0 0 2px; font-size: 12px; overflow-wrap: anywhere; }
    a { color: var(--accent); }
    .actions { display: flex; gap: 8px; }
    .status { font-size: 12px; color: var(--muted); }
    .status:not(:empty) { margin-top: 8px; }
    .fine { margin: 6px 0 0; font-size: 11px; color: var(--muted); }
    .chip.state { white-space: nowrap; }
    .chip.v-yes { color: var(--ok); border-color: currentColor; }
    .chip.v-some { color: var(--warn); border-color: currentColor; }
    .chip.v-no { color: var(--err); border-color: currentColor; }
    .summary { margin: 0 0 8px; }
    .verdict { margin: 0 0 4px; font-size: 12px; font-style: italic; }
    .linkish { background: none; border: 0; padding: 0; color: var(--accent); font-size: 12px; text-decoration: underline; }
    .saved { margin: 6px 0 0; padding: 8px 10px; background: var(--soft); border-radius: 6px; }
    .answers { display: grid; gap: 8px; margin-bottom: 8px; }
    .reply-ready { border: 2px solid var(--accent); background: var(--tint); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
    .reply-title { margin: 0 0 2px; font-weight: 600; }
    .order-card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
    .order-q { margin: 0 0 4px; font-weight: 600; }
    .order-links { margin-top: 8px; display: grid; gap: 4px; }
    .reply-ready summary { cursor: pointer; font-size: 12px; color: var(--muted); }
    .answer-card { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
    .answer-card.theirs { border-left: 3px solid var(--accent); }
    .answer-card summary { cursor: pointer; font-size: 12px; }
    .answer-card[open] summary { margin-bottom: 4px; }
    .md { font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
    .md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; }
    .md h3, .md h4, .md h5, .md h6 { margin: 12px 0 4px; font-size: 13px; line-height: 1.35; }
    .md h3 { font-size: 14px; }
    .md p { margin: 0 0 8px; }
    .md ul, .md ol { margin: 0 0 8px; padding-left: 20px; }
    .md li { margin: 2px 0; }
    .md li > ul, .md li > ol { margin: 2px 0 0; }
    .md code { font: 11.5px ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--bg); padding: 0 3px; border-radius: 3px; }
    .md pre { margin: 0 0 8px; padding: 8px; background: var(--bg); border-radius: 6px; overflow-x: auto; }
    .md pre code { padding: 0; white-space: pre; }
    .md blockquote { margin: 0 0 8px; padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted); }
    .md .table-wrap { overflow-x: auto; margin: 0 0 8px; }
    .md table { border-collapse: collapse; font-size: 12px; }
    .md th, .md td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; vertical-align: top; }
    .md th { background: var(--bg); font-weight: 600; }
    .md hr { border: 0; border-top: 1px solid var(--line); margin: 10px 0; }
    .note-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 4px; font-size: 11px; color: var(--muted); }
    .note-meta .linkish { font-size: 11px; }
    textarea.answer { width: 100%; min-height: 110px; font: inherit; background: var(--soft); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; resize: vertical; }
    .toolstrip { display: flex; align-items: center; gap: 5px; padding: 6px 8px; overflow: hidden; border-bottom: 1px solid var(--line); background: var(--soft); }
    .toolstrip .spacer { flex: 1; }
    .tool { background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; font-weight: 600; font-size: 12px; white-space: nowrap; }
    .tool:hover:not(:disabled) { border-color: var(--accent); }
    .tool[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
    .pos { font-size: 12px; color: var(--muted); white-space: nowrap; min-width: 50px; text-align: center; font-variant-numeric: tabular-nums; }
    .facts { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; align-items: baseline; font-size: 12.5px; }
    .facts dt { color: var(--muted); }
    .facts dd { margin: 0; overflow-wrap: anywhere; }
    .facts .copy { background: none; border: 0; color: var(--muted); padding: 0 2px; }
    .facts .copy:hover { color: var(--accent); }
    .big-tools { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .big-tools .tool { padding: 10px; font-size: 13px; }
    kbd { font: 11px ui-monospace, Consolas, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; }
    .keys { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 12px; color: var(--muted); }
    .keys kbd { justify-self: start; }
    details.setting { border: 1px solid var(--line); border-radius: 8px; padding: 0; margin-bottom: 8px; }
    details.setting > summary { cursor: pointer; margin: 0; padding: 10px 12px; list-style: none; display: flex; justify-content: space-between; align-items: center; }
    details.setting > summary::-webkit-details-marker { display: none; }
    details.setting > summary::after { content: "▸"; color: var(--muted); }
    details.setting[open] > summary::after { content: "▾"; }
    details.setting > summary:hover { background: var(--soft); }
    .setting-body { padding: 0 12px 12px; }
    .final-card { border: 2px solid var(--accent); background: var(--tint); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
    .final-text { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.4; }
    .tasks { display: grid; gap: 4px; margin-top: 8px; }
    .task-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 12.5px; }
    .form { display: grid; gap: 10px; }
    .frow { display: grid; gap: 4px; min-width: 0; }
    .flabel { font-size: 12px; font-weight: 600; }
    .frow2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .frow3 { display: grid; grid-template-columns: 1fr 1.4fr .8fr; gap: 10px; }
    .field { width: 100%; min-width: 0; font: inherit; background: var(--soft); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
    textarea.field { resize: vertical; }
    select.field { padding: 5px 6px; }
    .result:not(:empty) { margin-top: 4px; }
    .code-line { display: inline-flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
    .code-line code { font: 600 14px ui-monospace, Consolas, monospace; }
    .quote-line { padding: 6px 0; border-top: 1px solid var(--line); }
    .quote-line:first-of-type { border-top: 0; }
    .bars { display: grid; gap: 4px; }
    .bar-row { display: grid; grid-template-columns: minmax(0, 1.3fr) 1fr 40px; gap: 8px; align-items: center; font-size: 12px; }
    .bar-k { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar { height: 8px; background: var(--soft); border-radius: 4px; overflow: hidden; }
    .bar > span { display: block; height: 100%; background: var(--accent); }
    .bar-n { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
  `;

  function createPanel() {
    const host = h('div', { id: 'zdr-host' });
    const root = host.attachShadow({ mode: 'open' });
    // Keep the dashboard's keyboard shortcuts from firing while typing in the panel
    for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, e => e.stopPropagation());

    const body = h('div', { class: 'body' });
    const status = h('div', { class: 'status', role: 'status' });
    const ccBtn = h('button', { class: 'primary', type: 'button', text: 'Research in Claude Code', title: 'Puts this research on the case in Notion for Claude Code. Its answer comes back here by itself.', onclick: () => run(sendToClaudeCode) });
    const openBtn = h('button', { class: 'secondary', type: 'button', text: 'Open in claude.ai', onclick: () => run(handoff) });
    const copyBtn = h('button', { class: 'secondary', type: 'button', text: 'Copy prompt', onclick: () => run(copyPrompt) });
    // A bubble you can drag anywhere (where you leave it is remembered); a click without a drag opens Tools
    const BUBBLE_KEY = 'zt:bubble';
    const launch = h('button', { class: 'launch', type: 'button', title: 'Tools: Classify, Quote, research and Entry Assistant. Drag to move; \\ to toggle.', 'aria-label': 'Open Tools', hidden: true,
      onclick: () => { if (launch.dataset.dragged) { delete launch.dataset.dragged; return; } open(); } },
      h('span', {}, h('span', { class: 'ico', text: '⚒' }), 'Tools'));
    const clampX = x => Math.max(8, Math.min(innerWidth - 66, x));
    const clampY = y => Math.max(8, Math.min(innerHeight - 66, y));
    function placeBubble() {
      const p = GM_getValue(BUBBLE_KEY, null);
      launch.style.left = `${clampX(p ? p.x : innerWidth - 80)}px`;
      launch.style.top = `${clampY(p ? p.y : innerHeight - 80)}px`;
    }
    placeBubble();
    window.addEventListener('resize', placeBubble);
    // The other launcher: an orange Tools button at the bottom of the portal's sidebar, above References.
    // It lives in the page, so it's put back whenever the portal redraws its sidebar.
    const LAUNCHER_KEY = 'zt:launcher';   // 'bubble' | 'sidebar'
    const launcherMode = () => GM_getValue(LAUNCHER_KEY, 'bubble');
    const sideBtn = h('button', { type: 'button', id: 'zt-side-launch', 'aria-label': 'Open Tools', title: 'Tools (\\ to toggle)',
      class: 'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors',
      style: 'border-color:#f59e0b;color:#f59e0b;background:rgba(245,158,11,.10);font-weight:600;cursor:pointer',
      onclick: () => { if (panel.hidden) open(); else close(); } },
      h('span', { 'aria-hidden': 'true', text: '⚒' }), h('span', { text: 'Tools' }));
    const sideWrap = h('div', { class: 'px-2 pb-2', id: 'zt-side-wrap' }, sideBtn);
    function placeLauncher() {
      const side = launcherMode() === 'sidebar';
      const ref = side && [...document.querySelectorAll('aside button, aside a')].find(e => /References/.test(e.textContent));
      const holder = ref?.parentElement;
      // Back to the bubble if the sidebar isn't there (a narrow window hides it)
      const useSide = !!(holder && holder.offsetParent);
      launch.style.display = useSide ? 'none' : '';
      if (!useSide) { sideWrap.remove(); return; }
      if (sideWrap.nextElementSibling !== holder) holder.before(sideWrap);
    }
    launch.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const sx = e.clientX, sy = e.clientY, r = launch.getBoundingClientRect();
      let moved = false;
      try { launch.setPointerCapture(e.pointerId); } catch { /* the drag still works while over the bubble */ }
      const move = ev => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        moved = true;
        launch.classList.add('dragging');
        launch.style.left = `${clampX(r.left + ev.clientX - sx)}px`;
        launch.style.top = `${clampY(r.top + ev.clientY - sy)}px`;
      };
      const up = () => {
        launch.removeEventListener('pointermove', move);
        launch.removeEventListener('pointerup', up);
        launch.removeEventListener('pointercancel', up);
        launch.classList.remove('dragging');
        if (!moved) return;
        launch.dataset.dragged = '1';   // the click that follows a drag doesn't open the panel
        GM_setValue(BUBBLE_KEY, { x: parseFloat(launch.style.left), y: parseFloat(launch.style.top) });
      };
      launch.addEventListener('pointermove', move);
      launch.addEventListener('pointerup', up);
      launch.addEventListener('pointercancel', up);
    });
    const tokenInput = h('input', { type: 'password', placeholder: 'Paste your Entry Assistant token', 'aria-label': 'Entry Assistant token', autocomplete: 'off' });
    const tokenNote = h('p', { class: 'hint' });
    // A new name also goes to the notes server, which puts it on the answers you already saved
    const authorInput = h('input', {
      type: 'text', placeholder: 'Your name, shown on answers you save', 'aria-label': 'Your name, shown on answers you save',
      value: GM_getValue(AUTHOR_KEY, ''),
      onchange: () => {
        const name = clean(authorInput.value);
        GM_setValue(AUTHOR_KEY, name);
        if (name && (manualNotesKey() || joinRecord().key)) {
          notesApi('PATCH', '/me', { name }).then(
            () => { GM_setValue(NOTES_JOIN, { ...joinRecord(), name }); setNotesKeyNote(`Your answers now show as ${name}.`, 'ok'); if (state) syncNow(); },
            e => setNotesKeyNote(e.message, 'err'));
        }
      },
    });
    const notesKeyInput = h('input', { type: 'password', placeholder: 'Notes key (only if joining by yourself fails)', 'aria-label': 'Notes key', autocomplete: 'off' });
    const notesKeyNote = h('p', { class: 'hint' });
    const setNotesKeyNote = (text, kind = '') => { notesKeyNote.textContent = text; notesKeyNote.className = `hint ${kind}`; };
    function refreshNotesKeyNote() {
      const rec = joinRecord();
      if (!authorInput.value && root.activeElement !== authorInput) authorInput.value = GM_getValue(AUTHOR_KEY, '');
      if (!notesBase()) setNotesKeyNote('Shared answers are off: answers you save stay on this computer.');
      else if (manualNotesKey()) setNotesKeyNote('Using the notes key you pasted. To join through your dashboard sign-in instead, empty the box and click Save.');
      else if (rec.key) setNotesKeyNote(`Shared answers: joined through your dashboard sign-in as ${rec.name}.`, 'ok');
      else if (rec.error) setNotesKeyNote(rec.error, 'err');
      else setNotesKeyNote('Shared answers: you join on your own through your dashboard sign-in.');
    }
    async function testNotesKey() {
      if (!notesBase()) { refreshNotesKeyNote(); return; }
      setNotesKeyNote('Testing…');
      try {
        const me = await notesApi('GET', '/me');
        setNotesKeyNote(`Connected to shared answers as ${me.name}.`, 'ok');
      } catch (e) {
        setNotesKeyNote(e.message, 'err');
      }
    }
    function saveNotesKey() {
      const value = cleanToken(notesKeyInput.value);
      if (value) GM_setValue(NOTES_KEY, value);
      else GM_deleteValue(NOTES_KEY);
      notesKeyInput.value = '';
      refreshNotesKeyNote();
      // With the box emptied, this joins through the dashboard sign-in
      testNotesKey().then(() => state && syncNow());
    }
    // ---- Setup (the gear, and "Setup" in the Tools tab): everything personal, kept in Tampermonkey storage on
    // this computer. Every part is optional; what isn't set up is simply left out of the panel.
    const note = () => h('p', { class: 'hint' });
    const say = (el, text, kind = '') => { el.textContent = text; el.className = `hint ${kind}`; };
    const textField = (key, placeholder, label) => h('input', { type: 'text', placeholder, 'aria-label': label, autocomplete: 'off', spellcheck: 'false', value: cfg()[key] || '' });
    // Secrets are never shown again once saved; the box says so, and pasting a new one replaces it
    const secretField = (has, label) => h('input', { type: 'password', placeholder: has() ? 'Saved (paste a new one to replace it)' : label, 'aria-label': label, autocomplete: 'off' });
    // Each section folds up like a dropdown, so Settings opens as a short list of titles
    const group = (title, intro, ...kids) => h('details', { class: 'group setting' }, h('summary', { class: 'label', text: title }), h('div', { class: 'setting-body' }, intro ? h('p', { class: 'hint', style: 'margin:0 0 6px', text: intro }) : null, ...kids));
    const btn = (text, onclick) => h('button', { class: 'secondary', type: 'button', text, onclick });
    const afterSetup = () => { if (state) render(); refreshTools(); if (view === 'dispute') showResearchIdle(); };

    // Entry Assistant
    const entryUrlInput = textField('entryUrl', CONFIG_DEFAULTS.entryUrl, 'Entry Assistant site');
    tokenInput.placeholder = entryToken() ? 'Saved (paste a new one to replace it)' : 'Paste your Entry Assistant token';
    const saveEntry = () => {
      setCfg({ entryUrl: baseUrl(entryUrlInput.value) || CONFIG_DEFAULTS.entryUrl });
      entryFrameCheck = null;
      if (cleanToken(tokenInput.value)) saveToken();
      else { refreshTokenNote(); testConnection(); }
      tokenInput.placeholder = entryToken() ? 'Saved (paste a new one to replace it)' : 'Paste your Entry Assistant token';
      afterSetup();
    };

    // Notion case tracking
    const notionKeyInput = secretField(() => !!desk.key.get(), 'Notion integration key (ntn_…)');
    const projectsInput = textField('projectsDs', 'Projects data source id', 'Projects data source id');
    const tasksInput = textField('tasksDs', 'Tasks data source id (optional)', 'Tasks data source id');
    const userInput = textField('notionUser', 'Your Notion user id (optional, for task Assignee)', 'Notion user id');
    const notionNote = note();
    const saveNotion = async () => {
      const k = clean(notionKeyInput.value);
      if (k) desk.key.set(k);
      notionKeyInput.value = '';
      notionKeyInput.placeholder = desk.key.get() ? 'Saved (paste a new one to replace it)' : 'Notion integration key (ntn_…)';
      setCfg({ projectsDs: clean(projectsInput.value), tasksDs: clean(tasksInput.value), notionUser: clean(userInput.value) });
      afterSetup();
      if (!desk.key.get() && !cfg().projectsDs) { say(notionNote, 'Saved. Notion tracking is off.'); return; }
      say(notionNote, 'Saved. Testing…');
      try { say(notionNote, `Saved. Connected to Notion: ${await desk.testKey()}.`, 'ok'); } catch (err) { say(notionNote, `Saved, but: ${err.message}`, 'err'); }
    };
    const clearNotion = () => {
      desk.key.set('');
      setCfg({ projectsDs: '', tasksDs: '', notionUser: '' });
      for (const i of [projectsInput, tasksInput, userInput]) i.value = '';
      notionKeyInput.placeholder = 'Notion integration key (ntn_…)';
      say(notionNote, 'Notion tracking is off.');
      afterSetup();
    };

    // Claude Code cloud research
    const routineIdInput = textField('routineId', 'Routine id (trig_…)', 'Routine id');
    const routineTokenInput = secretField(() => !!cfg().routineToken, 'Routine API token');
    const routineNote = note();
    const saveRoutine = () => {
      const t = clean(routineTokenInput.value);
      setCfg({ routineId: clean(routineIdInput.value), ...(t ? { routineToken: t } : {}), ...(clean(routineIdInput.value) ? {} : { routineToken: '' }) });
      routineTokenInput.value = '';
      routineTokenInput.placeholder = cfg().routineToken ? 'Saved (paste a new one to replace it)' : 'Routine API token';
      say(routineNote, desk.researchOn() ? 'Saved. "Research in Claude Code" is on.' : cfg().routineId ? 'Saved. It also needs Notion with a Tasks database.' : 'Saved. Claude Code research is off.', desk.researchOn() ? 'ok' : '');
      afterSetup();
    };

    // Shared answers server
    const notesUrlInput = textField('notesUrl', 'Notes server address (optional)', 'Notes server address');
    const saveNotesUrl = () => {
      setCfg({ notesUrl: baseUrl(notesUrlInput.value) });
      refreshNotesKeyNote();
      if (cfg().notesUrl) testNotesKey().then(() => state && syncNow());
      afterSetup();
    };

    // Back up / restore: everything above as one block of text, e.g. to move to another computer
    const importBox = h('textarea', { class: 'answer', rows: 4, placeholder: 'Paste a setup block here', 'aria-label': 'Setup to import', style: 'min-height:70px' });
    const backupNote = note();
    const exportSetup = () => {
      GM_setClipboard(JSON.stringify({ zonosToolsSetup: 1, entryToken: entryToken(), notionKey: desk.key.get(), config: GM_getValue(CONFIG_KEY, {}) }, null, 2), 'text');
      say(backupNote, 'Copied, keys included. Keep it private: anyone with it can use your keys.', 'warn');
    };
    const importSetup = () => {
      let s;
      try { s = JSON.parse(importBox.value); } catch { say(backupNote, "That isn't a setup block.", 'err'); return; }
      if (!s || s.zonosToolsSetup !== 1) { say(backupNote, "That isn't a setup block.", 'err'); return; }
      if (s.entryToken) GM_setValue(TOKEN_KEY, cleanToken(s.entryToken));
      if (s.notionKey) desk.key.set(clean(s.notionKey));
      const c = {};
      for (const k of Object.keys(CONFIG_DEFAULTS)) if (typeof s.config?.[k] === 'string') c[k] = s.config[k];
      setCfg(c);
      importBox.value = '';
      for (const [input, k] of [[entryUrlInput, 'entryUrl'], [projectsInput, 'projectsDs'], [tasksInput, 'tasksDs'], [userInput, 'notionUser'], [routineIdInput, 'routineId'], [notesUrlInput, 'notesUrl']]) input.value = cfg()[k] || '';
      say(backupNote, 'Imported and saved.', 'ok');
      refreshTokenNote();
      refreshNotesKeyNote();
      afterSetup();
    };

    const settingsBody = h('div', { class: 'body' },
      h('p', { class: 'hint', style: 'margin:0 0 14px', text: "Tools works without any of this: the queue, Classify, Quote and research prompts need nothing. Each part below adds something, and what you save stays on this computer." }),
      group('Your name', '', h('div', { class: 'row' }, authorInput)),
      group('Entry Assistant', 'HTS facts for each line in the research prompt, and the lookup box. Uses your own token.',
        h('div', { class: 'row' }, entryUrlInput),
        h('div', { class: 'row', style: 'margin-top:6px' }, tokenInput, btn('Save', saveEntry), btn('Test', () => testConnection())),
        tokenNote),
      group('Notion case tracking', 'Tracks each dispute and work order you work as a row in your Notion Projects database (needs a Notion integration with access to it). The Tasks database is needed only for Claude Code research.',
        h('div', { class: 'row' }, notionKeyInput),
        h('div', { class: 'row', style: 'margin-top:6px' }, projectsInput),
        h('div', { class: 'row', style: 'margin-top:6px' }, tasksInput),
        h('div', { class: 'row', style: 'margin-top:6px' }, userInput),
        h('div', { class: 'row', style: 'margin-top:6px' }, btn('Save and test', saveNotion), btn('Turn off', clearNotion)),
        notionNote,
        h('label', { class: 'doc', style: 'margin-top:6px' },
          h('input', { type: 'checkbox', checked: desk.writeInTest.get(), onchange: e => desk.writeInTest.set(e.target.checked) }),
          h('span', { text: 'Write to Notion in test mode too (normally test mode is a dry run)' }))),
      group('Claude Code research', 'Adds "Research in Claude Code": the request goes to your Notion Tasks and starts your cloud routine. Without it, use Copy prompt or Open in claude.ai.',
        h('div', { class: 'row' }, routineIdInput),
        h('div', { class: 'row', style: 'margin-top:6px' }, routineTokenInput, btn('Save', saveRoutine)),
        routineNote),
      group('Shared answers', 'Shares saved answers with your team through a notes server. Leave the address empty to keep answers on this computer only.',
        h('div', { class: 'row' }, notesUrlInput, btn('Save', saveNotesUrl)),
        h('div', { class: 'row', style: 'margin-top:6px' }, notesKeyInput, btn('Save key', () => saveNotesKey()), btn('Test', () => testNotesKey())),
        notesKeyNote),
      group('Back up or move your setup', '',
        h('div', { class: 'row' }, btn('Copy my setup', exportSetup)),
        h('div', { style: 'margin-top:6px' }, importBox),
        h('div', { class: 'row', style: 'margin-top:6px' }, btn('Import', importSetup)),
        backupNote),
      h('p', { class: 'fine', text: "Clicking a code on the page opens it in the Entry Assistant tab once that site allows being shown here (Alt-click for the portal's References). Claude never sends anything until you press Enter there." }),
      h('p', { class: 'fine', text: 'Drag the panel\'s left edge to make it wider or narrower; double-click the edge for the default width.' }));

    // The Entry Assistant site, in a frame that's kept while you switch tabs
    const entryCaption = h('span', { class: 'entry-caption' });
    const entryNewTab = h('a', { target: '_blank', rel: 'noreferrer', text: 'Open in a new tab ↗' });
    const entryFrame = h('iframe', { class: 'entry-frame', title: 'Entry Assistant', referrerpolicy: 'no-referrer', allow: 'clipboard-write', hidden: true });
    const entryBlockedLink = h('a', { class: 'primary', target: '_blank', rel: 'noreferrer', text: 'Open Entry Assistant ↗' });
    const entryBlocked = h('div', { class: 'entry-blocked', hidden: true },
      h('p', { text: "The Entry Assistant site doesn't allow being shown inside the dashboard yet, so it opens in its own tab for now." }),
      entryBlockedLink);

    // ---- the Tools tab and the strip above every tab: the portal's Classify / Quote, and Prev / Next through
    // the queue as you last left it in the Tools queue
    const HIDE_RAIL_KEY = 'zt:hideRail';
    // ---- Classify and Quote, built into the panel so they work on every portal page. They send the same
    // requests as the portal's own Classify and Quote boxes (ClassificationsCalculate, ItemQuoteLandedCost).
    const COUNTRIES = 'AD AE AF AG AI AL AM AO AR AS AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GI GM GN GR GT GU GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PR PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW'.split(' ');
    const countrySelect = (label, value = '', required = false) => h('select', { 'aria-label': label, class: 'field' },
      h('option', { value: '', text: required ? 'Pick a country' : '—' }),
      COUNTRIES.map(c => [c, regionName(c)]).sort((a, b) => a[1].localeCompare(b[1])).map(([c, n]) => h('option', { value: c, text: `${n} (${c})`, selected: c === value })));
    const fieldRow = (label, input, hint) => h('label', { class: 'frow' }, h('span', { class: 'flabel', text: label }), input, hint ? h('span', { class: 'hint', style: 'margin:0', text: hint }) : null);
    const codeLine = code => h('span', { class: 'code-line' },
      h('code', { text: code }),
      h('button', { class: 'linkish', type: 'button', text: 'copy', onclick: () => { GM_setClipboard(code, 'text'); } }),
      h('button', { class: 'linkish', type: 'button', text: 'Entry Assistant', onclick: () => showEntry({ codes: [code] }) }));
    // What the current order says about its first item, to start the forms from
    function orderItem() {
      const it = navPosition().items[navPosition().i] || {};
      let d = null;
      try { d = state?.data; } catch { /* the panel is still being set up */ }
      const line = d?.items?.[0] || d?.lines?.[0] || {};
      return {
        name: clean(line.name || line.description || it.title || ''),
        hs: clean(line.hsCode || line.code || '').replace(/[^\d.]/g, ''),
        coo: (line.origin || line.coo || '').toUpperCase().slice(0, 2),
      };
    }

    const classifyBody = h('div', { class: 'body' });
    function renderClassify() {
      const pre = orderItem();
      const name = h('input', { type: 'text', class: 'field', placeholder: "e.g. Men's cotton t-shirt", value: pre.name, 'aria-label': 'Item name' });
      const desc = h('textarea', { class: 'field', rows: 3, placeholder: 'Material, use, construction, and anything that sets it apart', 'aria-label': 'Description' });
      const material = h('input', { type: 'text', class: 'field', placeholder: 'e.g. 100% cotton', 'aria-label': 'Material' });
      const shipTo = countrySelect('Ship to', 'US', true);
      const origin = countrySelect('Country of origin', pre.coo);
      const hs = h('input', { type: 'text', class: 'field', placeholder: 'Refine or check an existing code', value: pre.hs, 'aria-label': 'HS code' });
      const out = h('div', { class: 'result', role: 'status' });
      const go = h('button', { class: 'primary', type: 'submit', text: 'Classify' });
      const form = h('form', { class: 'form', onsubmit: async e => {
        e.preventDefault();
        if (!clean(name.value)) { out.replaceChildren(h('p', { class: 'err', text: 'Item name is required.' })); return; }
        const code = clean(hs.value);
        go.disabled = true;
        out.replaceChildren(h('p', { class: 'muted', text: 'Classifying…' }));
        try {
          const data = await portal.gql('ClassificationsCalculate', `mutation ClassificationsCalculate($level: ClassificationLevel!, $inputs: [ClassificationCalculateInput!]!) {
            classificationsCalculate(input: $inputs, level: $level) { id confidenceScore customsDescription
              hsCode { code description { friendly full } }
              hsCodeProvidedValidation { code result type }
              alternates { subheadingAlternate { code description { friendly } } } } }`,
          { level: 'BASE', inputs: [{ name: clean(name.value), description: clean(desc.value).slice(0, 500) || undefined, material: clean(material.value) || undefined,
            countryOfOrigin: origin.value || undefined,
            configuration: { hsCodeProvided: code || undefined, hsCodeProvidedTreatment: code ? 'CHECK_COHERENCE' : 'IGNORE', shipToCountries: shipTo.value ? [shipTo.value] : null } }] });
          const c = (data.classificationsCalculate || []).find(Boolean);
          if (!c?.hsCode?.code) { out.replaceChildren(h('p', { class: 'warn', text: 'No classification came back. Add more detail and try again.' })); return; }
          const v = c.hsCodeProvidedValidation;
          const alts = (c.alternates || []).map(a => a.subheadingAlternate).filter(a => a?.code && a.code !== c.hsCode.code);
          out.replaceChildren(h('div', { class: 'order-card' },
            h('p', { class: 'label', text: 'Classification' }),
            codeLine(c.hsCode.code),
            h('p', { style: 'margin:6px 0 0', text: c.hsCode.description?.friendly || '' }),
            c.hsCode.description?.full ? h('p', { class: 'hint', text: c.hsCode.description.full }) : null,
            c.confidenceScore != null ? h('p', { class: 'hint', text: `Confidence ${Math.round(Number(c.confidenceScore) * 100)}%` }) : null,
            c.customsDescription ? h('p', { class: 'hint', text: `Customs description: ${c.customsDescription}` }) : null,
            v && code ? h('p', { class: `hint ${/COHERENT$/.test(v.result || '') && !/NOT/.test(v.result || '') ? 'ok' : 'warn'}`, text: `Your code ${v.code || code}: ${human2(v.result || '')}${v.type ? ` (${human2(v.type)})` : ''}` }) : null,
            alts.length ? [h('p', { class: 'label', style: 'margin-top:10px', text: 'Alternate subheadings' }),
              alts.map(a => h('div', { style: 'margin-top:4px' }, codeLine(a.code), a.description?.friendly ? h('span', { class: 'hint', style: 'display:block;margin:0', text: a.description.friendly }) : null))] : null));
        } catch (err) { out.replaceChildren(h('p', { class: 'err', text: err.message })); }
        finally { go.disabled = false; }
      } },
      fieldRow('Item name', name), fieldRow('Description', desc), fieldRow('Material (optional)', material),
      h('div', { class: 'frow2' }, fieldRow('Ship to', shipTo), fieldRow('Country of origin (optional)', origin)),
      fieldRow('HS code (optional)', hs), h('div', { class: 'actions' }, go), out);
      classifyBody.replaceChildren(form);
      name.focus();
    }

    const quoteBody = h('div', { class: 'body' });
    function renderQuote() {
      const pre = orderItem();
      const name = h('input', { type: 'text', class: 'field', value: pre.name, 'aria-label': 'Name' });
      const desc = h('textarea', { class: 'field', rows: 2, 'aria-label': 'Description' });
      const hs = h('input', { type: 'text', class: 'field', value: pre.hs, placeholder: 'e.g. 6403.91.9045', 'aria-label': 'HS code' });
      const origin = countrySelect('Country of origin', pre.coo, true);
      const shipFrom = countrySelect('Ship from', pre.coo, true);
      const qty = h('input', { type: 'number', class: 'field', min: '1', step: '1', value: '1', 'aria-label': 'Quantity' });
      const amount = h('input', { type: 'number', class: 'field', min: '0', step: '0.01', placeholder: '0.00', 'aria-label': 'Amount' });
      const currency = h('input', { type: 'text', class: 'field', value: 'USD', maxlength: '3', 'aria-label': 'Currency' });
      const out = h('div', { class: 'result', role: 'status' });
      const go = h('button', { class: 'primary', type: 'submit', text: 'Quote' });
      const form = h('form', { class: 'form', onsubmit: async e => {
        e.preventDefault();
        const err = !shipFrom.value ? 'Pick a ship-from country.' : !origin.value ? 'Pick a country of origin.' : !clean(hs.value) ? 'Enter an HS code.'
          : !(Number.isInteger(Number(qty.value)) && Number(qty.value) >= 1) ? 'Quantity must be a whole number of at least 1.'
          : !amount.value || Number.isNaN(Number(amount.value)) ? 'Enter an item amount.' : !/^[A-Za-z]{3}$/.test(clean(currency.value)) ? 'Enter a currency code such as USD.' : '';
        if (err) { out.replaceChildren(h('p', { class: 'err', text: err })); return; }
        go.disabled = true;
        out.replaceChildren(h('p', { class: 'muted', text: 'Quoting…' }));
        const cur = clean(currency.value).toUpperCase();
        const from = { location: { countryCode: shipFrom.value } };
        try {
          const data = await portal.gql('ItemQuoteLandedCost', `mutation ItemQuoteLandedCost($originParty: PartyCreateWorkflowInput!, $destinationParty: PartyCreateWorkflowInput!, $payorParty: PartyCreateWorkflowInput!, $items: [ItemCreateWorkflowInput!]!, $landedCostCalculation: LandedCostWorkFlowInput!) {
            partyCreateQuoterWorkflow(input: [$originParty, $destinationParty, $payorParty]) { id type }
            itemCreateQuoterWorkflow(input: $items) { id }
            cartonsCreateQuoterWorkflow(input: [{dimensionalUnit: INCH, length: 1, width: 1, height: 1, weight: 1, weightUnit: POUND}]) { id }
            shipmentRatingCreateQuoterWorkflow(input: {amount: 0, currencyCode: USD, serviceLevelCode: "ups.express"}) { id }
            landedCostCalculateQuoterWorkflow(input: $landedCostCalculation) { id currencyCode
              additionalHsCodes { id additionalHsCode additionalScheme customsDescription formula condition item { id } } } }`,
          { originParty: { ...from, type: 'ORIGIN' }, payorParty: { ...from, type: 'PAYOR' }, destinationParty: { location: { countryCode: 'US' }, type: 'DESTINATION' },
            items: [{ amount: String(amount.value), countryOfOrigin: origin.value, currencyCode: cur, hsCode: clean(hs.value), quantity: Number(qty.value),
              name: clean(name.value) || undefined, description: clean(desc.value) || undefined }],
            landedCostCalculation: { currencyCode: cur, endUse: 'NOT_FOR_RESALE', tariffRate: 'ZONOS_PREFERRED' } });
          const lc = (data.landedCostCalculateQuoterWorkflow || []).find(Boolean);
          const extra = (lc?.additionalHsCodes || []).filter(x => x?.additionalHsCode);
          out.replaceChildren(h('div', { class: 'order-card' },
            h('p', { class: 'label', text: `Quote · ${clean(hs.value)} from ${regionName(origin.value)} to the US` }),
            extra.length ? [h('p', { class: 'hint', style: 'margin:0 0 6px', text: 'Additional HS codes (Chapter 99) that apply:' }),
              extra.map(x => h('div', { class: 'quote-line' }, codeLine(x.additionalHsCode),
                h('span', { class: 'hint', style: 'display:block;margin:0', text: [x.customsDescription, x.formula && `Formula: ${x.formula}`, x.condition && `Condition: ${x.condition}`, x.additionalScheme && human2(x.additionalScheme)].filter(Boolean).join(' · ') })))]
              : h('p', { class: 'ok', style: 'margin:0', text: 'No additional (Chapter 99) HS codes apply.' })));
        } catch (err2) { out.replaceChildren(h('p', { class: 'err', text: err2.message })); }
        finally { go.disabled = false; }
      } },
      h('p', { class: 'hint', style: 'margin:0 0 8px', text: 'Ship-to is the United States. Shipping cost, service and carton size are placeholders, as in the portal.' }),
      fieldRow('Name', name), fieldRow('Description', desc), fieldRow('HS code', hs),
      h('div', { class: 'frow2' }, fieldRow('Country of origin', origin), fieldRow('Ship from', shipFrom)),
      h('div', { class: 'frow3' }, fieldRow('Quantity', qty), fieldRow('Amount', amount), fieldRow('Currency', currency)),
      h('div', { class: 'actions' }, go), out);
      quoteBody.replaceChildren(form);
      (pre.hs ? amount : hs).focus();
    }

    // ---- Analytics: every order the portal has (closed ones included) for a period, by company, class,
    // item / problem, resolution and who worked it. The portal keeps this history itself, so nothing is logged
    // anywhere else; Export gives a CSV for bookkeeping.
    const analyticsBody = h('div', { class: 'body' });
    const ANALYTICS_KEY = 'zt:analytics';
    let analytics = null;   // { from, to, rows, at }
    function renderAnalytics() {
      const pref = GM_getValue(ANALYTICS_KEY, { days: 30 });
      const days = h('select', { class: 'field', 'aria-label': 'Period' },
        [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last 12 months']].map(([d, t]) => h('option', { value: String(d), text: t, selected: d === pref.days })));
      const statusSel = h('select', { class: 'field', 'aria-label': 'Status' },
        [['', 'Every status'], ['RESOLVED', 'Resolved'], ['OPEN', 'Open'], ['WAITING', 'Waiting'], ['CANCELLED', 'Cancelled'], ['AUTO_RESOLVED', 'Auto-resolved']]
          .map(([v, t]) => h('option', { value: v, text: t, selected: v === (pref.status || '') })));
      const mineOnly = h('input', { type: 'checkbox', checked: !!pref.mine });
      const out = h('div', { role: 'status' });
      const loadBtn = h('button', { class: 'primary', type: 'button', text: analytics ? 'Reload' : 'Load', onclick: () => loadAnalytics() });
      async function loadAnalytics() {
        const p = { days: Number(days.value), status: statusSel.value, mine: mineOnly.checked };
        GM_setValue(ANALYTICS_KEY, p);
        loadBtn.disabled = true;
        out.replaceChildren(h('p', { class: 'muted', text: 'Reading the portal…' }));
        try {
          const me = await portal.me();
          const filter = { createdAt: { after: new Date(Date.now() - p.days * DAY).toISOString() }, ...(p.status ? { status: p.status } : {}), ...(p.mine && me.id ? { assigneeIds: [me.id] } : {}) };
          const rows = (await portal.workOrders(filter, 5000)).map(queueRow);
          await portal.orgNames(rows.map(r => r.orgId));
          for (const r of rows) r.customer = portal.orgs[r.orgId] || '';
          analytics = { ...p, rows, at: Date.now() };
          showAnalytics();
        } catch (e) { out.replaceChildren(h('p', { class: 'err', text: e.message })); }
        finally { loadBtn.disabled = false; loadBtn.textContent = 'Reload'; }
      }
      function table(title, entries, total) {
        return h('div', { class: 'section' }, h('p', { class: 'label', text: title }),
          h('div', { class: 'bars' }, entries.slice(0, 12).map(([k, n]) => h('div', { class: 'bar-row', title: `${k}: ${n}` },
            h('span', { class: 'bar-k', text: k }), h('span', { class: 'bar' }, h('span', { style: `width:${Math.max(2, Math.round(n / total * 100))}%` })), h('span', { class: 'bar-n', text: String(n) })))),
          entries.length > 12 ? h('p', { class: 'hint', text: `…and ${entries.length - 12} more (in the CSV)` }) : null);
      }
      function showAnalytics() {
        const a = analytics;
        if (!a) { out.replaceChildren(h('p', { class: 'hint', text: 'Pick a period and press Load. It reads every matching order from the portal, closed ones included.' })); return; }
        const rows = a.rows;
        const tally = fn => { const m = new Map(); for (const r of rows) { const k = fn(r) || '(unknown)'; m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((x, y) => y[1] - x[1]); };
        const n = rows.length || 1;
        const exportCsv = () => {
          const cols = ['Created', 'Class', 'Status', 'Resolution', 'Company', 'Consignee', 'Item', 'Problem', 'Tracking', 'Entry', 'Assignee', 'Link'];
          const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
          const csv = [cols.map(q).join(','), ...rows.map(r => [r.createdMs ? new Date(r.createdMs).toISOString().slice(0, 10) : '', r.label, r.status, r.resolution, r.customer, r.consignee, r.title, r.problem, r.tracking, r.entryNo, r.assigneeName, location.origin + r.url].map(q).join(','))].join('\r\n');
          const link = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `orders-${new Date().toISOString().slice(0, 10)}.csv` });
          root.append(link); link.click(); link.remove();
        };
        out.replaceChildren(
          h('p', { class: 'hint', text: `${rows.length} orders created in the ${days.selectedOptions[0].text.toLowerCase()}${a.status ? `, ${human2(a.status).toLowerCase()}` : ''}${a.mine ? ', assigned to you' : ''} · read ${new Date(a.at).toLocaleTimeString()}` }),
          h('div', { class: 'actions', style: 'margin:6px 0 12px' }, h('button', { class: 'secondary', type: 'button', text: 'Export CSV', onclick: exportCsv })),
          table('By company', tally(r => r.customer || r.consignee), n),
          table('By class', tally(r => r.label), n),
          table('By status / resolution', tally(r => r.resolution ? human2(r.resolution) : human2(r.status)), n),
          table('By item / problem', tally(r => r.title), n),
          table('By assignee', tally(r => r.assigneeName || 'Unclaimed'), n));
      }
      analyticsBody.replaceChildren(
        h('div', { class: 'frow2' }, fieldRow('Period', days), fieldRow('Status', statusSel)),
        h('label', { class: 'doc', style: 'margin:6px 0' }, mineOnly, h('span', { text: 'Only orders assigned to me' })),
        h('div', { class: 'actions', style: 'margin-bottom:10px' }, loadBtn), out);
      showAnalytics();
    }

    function openTool(name) {
      if (panel.hidden) open();
      setView(name);
    }
    const analyticsBtn = h('button', { class: 'icon', type: 'button', text: '▤', title: 'Analytics: orders by company, class and item', 'aria-label': 'Analytics', 'aria-pressed': 'false', onclick: () => setView(view === 'analytics' ? lastView : 'analytics') });
    // On order pages only: Prev / Next through your queue as you last left it, and back to the queue
    const prevBtn = h('button', { class: 'tool', type: 'button', text: '◀', title: 'Previous order in your queue ([)', 'aria-label': 'Previous order', onclick: () => step(-1) });
    const nextBtn = h('button', { class: 'tool', type: 'button', text: '▶', title: 'Next order in your queue (])', 'aria-label': 'Next order', onclick: () => step(1) });
    const posLabel = h('span', { class: 'pos' });
    const queueBtn = h('button', { class: 'tool', type: 'button', text: 'Queue', title: 'Back to the work queue', onclick: () => goTo(QUEUE_PATH) });
    const toolstrip = h('div', { class: 'toolstrip' }, prevBtn, posLabel, nextBtn, h('span', { class: 'spacer' }), queueBtn);
    function step(d) {
      const { items, i } = navPosition();
      const it = items[i + d];
      if (it) goTo(it.url);
    }
    // Cheap enough to run every second: the queue position and what's set up
    function refreshTools() {
      hideRail(GM_getValue(HIDE_RAIL_KEY, false));
      const onOrder = isCasePage();
      analyticsBtn.setAttribute('aria-pressed', String(view === 'analytics'));
      toolstrip.hidden = !onOrder;
      // Research only exists on a dispute or an order; elsewhere Tools opens on Classify, and comes back to
      // Research once you open one
      tabs.dispute.hidden = !onOrder;
      if (!onOrder && view === 'dispute') { leftResearch = true; setView('classify'); return; }
      if (onOrder && leftResearch && view === 'classify') { leftResearch = false; setView('dispute'); return; }
      const { items, i } = navPosition();
      prevBtn.disabled = !(i > 0);
      nextBtn.disabled = !(i >= 0 && i < items.length - 1) && !(i < 0 && items.length);
      posLabel.textContent = i >= 0 ? `${i + 1} of ${items.length}` : '';
      // Research in Claude Code only when Notion and the cloud routine are set up; otherwise claude.ai leads
      ccBtn.hidden = !desk.researchOn();
      openBtn.className = ccBtn.hidden ? 'primary' : 'secondary';
    }

    // ---- the panel's own options, at the top of Settings (the cog), out of the way of the tabs
    const setQueueView = on => { GM_setValue(QUEUE_VIEW_KEY, on ? 'tools' : 'portal'); queueCtl?.setEnhanced(on); };
    const check = (label, on, change) => h('label', { class: 'doc' }, h('input', { type: 'checkbox', checked: on, onchange: e => change(e.target.checked) }), h('span', { text: label }));
    const prefsGroup = group('Panel and pages', "Changes to the portal's own pages are off until you turn them on here.",
      h('label', { class: 'frow', style: 'margin-bottom:6px' }, h('span', { class: 'flabel', text: 'Tools button' }),
        h('select', { class: 'field', 'aria-label': 'Tools button', onchange: e => { GM_setValue(LAUNCHER_KEY, e.target.value); placeLauncher(); dock(); } },
          h('option', { value: 'bubble', text: 'Floating bubble (drag it anywhere)', selected: launcherMode() === 'bubble' }),
          h('option', { value: 'sidebar', text: 'Button in the sidebar, above References', selected: launcherMode() === 'sidebar' }))),
      check("Use the Tools queue on the Entry Writer Queue page (instead of the portal's own)", toolsQueueOn(), setQueueView),
      check('Easier-to-read order pages (labeled details, CBP messages in plain English)', GM_getValue(READABLE_KEY, false), on => { GM_setValue(READABLE_KEY, on); if (on) makeReadable(); else undoReadable(); }),
      check("Hide the portal's own Classify / Quote rail", GM_getValue(HIDE_RAIL_KEY, false), on => { GM_setValue(HIDE_RAIL_KEY, on); refreshTools(); }),
      check('Denied-party reviews: "Listed on" opens the official list (and copies the name) instead of a Google search', GM_getValue(LIST_LINKS_KEY, false), on => { GM_setValue(LIST_LINKS_KEY, on); fixListLinks(); }),
      check("Clicking an HS code on the page opens it in the Entry Assistant tab (off: the portal's own References window)", GM_getValue(ENTRY_CLICKS_KEY, false), on => GM_setValue(ENTRY_CLICKS_KEY, on)),
      check('Questionnaire disputes: show what each "Disputed program" is, with its questions and answers', GM_getValue(PROGRAMS_KEY, false), on => { GM_setValue(PROGRAMS_KEY, on); showPrograms(); }),
      h('details', { class: 'docs', style: 'margin-top:6px' }, h('summary', { text: 'Keyboard shortcuts' }),
        h('div', { class: 'keys', style: 'margin-top:6px' },
          h('kbd', { text: '\\' }), h('span', { text: 'Open or close Tools' }),
          h('kbd', { text: 'Shift+C' }), h('span', { text: 'Classify' }),
          h('kbd', { text: 'Shift+Q' }), h('span', { text: 'Quote' }),
          h('kbd', { text: '[  ]' }), h('span', { text: 'Previous / next order' }),
          h('kbd', { text: '/' }), h('span', { text: 'Search the queue (Tools queue)' }),
          h('kbd', { text: 'j k x Enter o' }), h('span', { text: 'Move, select, open, new tab (Tools queue)' }))));
    settingsBody.insertBefore(prefsGroup, settingsBody.children[1]);

    // Off an order page there's nothing to research: the Research tab says so instead of showing stale content
    const researchIdle = h('div', { class: 'body', hidden: true });
    let researchFooter = null;
    function showResearchIdle() {
      const idle = !isCasePage();
      if (idle) researchIdle.replaceChildren(
        h('p', { class: 'muted', text: 'Open a dispute or a work order to research it here. Classify and Quote work on any page.' }),
        !entryToken() && !desk.enabled()
          ? h('p', { class: 'hint' }, 'To add HTS facts, Notion tracking or Claude Code research, open ', h('button', { class: 'linkish', type: 'button', text: 'Settings', onclick: () => setView('settings') }), ' (the cog).')
          : null);
      researchIdle.hidden = !idle;
      body.hidden = idle;
      if (researchFooter) researchFooter.hidden = idle;
    }

    const views = {
      classify: h('section', { class: 'view', hidden: true }, classifyBody),
      quote: h('section', { class: 'view', hidden: true }, quoteBody),
      analytics: h('section', { class: 'view', hidden: true }, analyticsBody),
      dispute: h('section', { class: 'view' }, body, researchIdle,
        researchFooter = h('footer', {},
          h('div', { class: 'actions', style: 'flex-wrap:wrap' }, ccBtn, openBtn, copyBtn),
          status)),
      entry: h('section', { class: 'view', hidden: true },
        h('div', { class: 'entry-bar' }, entryCaption, entryNewTab),
        entryBlocked, entryFrame),
      settings: h('section', { class: 'view', hidden: true }, settingsBody),
    };
    const tab = (name, text) => h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'false', text, onclick: () => setView(name) });
    const tabs = { dispute: tab('dispute', 'Research'), classify: tab('classify', 'Classify'), quote: tab('quote', 'Quote'), entry: tab('entry', 'Entry Assistant') };
    const gear = h('button', { class: 'icon', type: 'button', 'aria-label': 'Settings', title: 'Settings: options, keys and connections', 'aria-pressed': 'false', text: '⚙︎', onclick: () => setView(view === 'settings' ? lastView : 'settings') });
    // Overlay (floats over the page) or side by side (the page narrows beside it); your choice is remembered
    const LAYOUT_KEY = 'zt:layout';
    let layout = GM_getValue(LAYOUT_KEY, 'overlay');
    const layoutBtn = h('button', { class: 'icon', type: 'button', onclick: () => { layout = layout === 'side' ? 'overlay' : 'side'; GM_setValue(LAYOUT_KEY, layout); dock(); refreshTools(); } });
    const grip = h('div', { class: 'grip', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': 'Resize panel', title: 'Drag to resize. Double-click for the default width.' });
    const panel = h('aside', { class: 'panel', hidden: true, 'aria-label': 'Tools' },
      grip,
      h('header', {},
        h('nav', { class: 'tabs', role: 'tablist' }, tabs.dispute, tabs.classify, tabs.quote, tabs.entry),
        h('div', { class: 'header-actions' },
          analyticsBtn,
          layoutBtn,
          gear,
          h('button', { class: 'icon', type: 'button', 'aria-label': 'Close panel', title: 'Close', text: '×', onclick: () => close() }))),
      toolstrip,
      views.dispute, views.classify, views.quote, views.analytics, views.entry, views.settings);
    root.append(h('style', { text: PANEL_CSS }), h('div', { class: 'wrap' }, launch, panel));

    let view = 'dispute';
    let lastView = 'dispute';
    let leftResearch = false;   // Tools moved off Research because the page has nothing to research
    function setView(name) {
      view = name;
      if (name !== 'settings') lastView = name;
      for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
      for (const [k, el] of Object.entries(tabs)) el.setAttribute('aria-selected', String(k === name));
      gear.setAttribute('aria-pressed', String(name === 'settings'));
      if (name === 'classify') renderClassify();
      if (name === 'quote') renderQuote();
      if (name === 'analytics') renderAnalytics();
      if (name === 'dispute') showResearchIdle();
      refreshTools();
      if (name === 'entry') showEntryPage();
      if (name === 'settings') refreshNotesKeyNote();
    }
    setView('dispute');

    // The desk redraws the Research tab when the case changes, and hands over Claude Code's answers,
    // which are saved like a pasted answer (shared with the team) but not written back to Notion
    desk.subscribe(() => { if (state && !panel.hidden) render(); });
    desk.setImporter(({ text, lines }) => {
      if (!state) return;
      const d = state.data;
      const use = d.kind === 'workOrder' ? [] : lines.length ? lines : d.items.filter(i => i.inDispute).map(i => i.line);
      addAnswer(d.disputeId, use, text);
      state.selected = unresearchedLines(d);
      setStatus('Claude Code answered. The answer is saved below and shared with your team.', 'ok');
      answersChanged();
    });

    // Opened from a code on the page or a line card: the site comes up with those codes
    let entryTarget = null;
    function showEntry(target) {
      entryTarget = target;
      setView('entry');
      open();
    }
    async function showEntryPage() {
      const t = entryTarget || {};
      const [a, b] = t.codes || [];
      entryCaption.textContent = !a ? 'Look up and compare HTS codes, notes, rulings and more.'
        : `${b ? `Comparing ${a} with ${b}` : a}${t.from ? ` · made in ${regionName(t.from)}` : ''}`;
      entryNewTab.href = entryBlockedLink.href = entryLink(t);
      const ok = await entryFrameable();
      entryFrame.hidden = !ok;
      entryBlocked.hidden = ok;
      entryNewTab.hidden = !ok;
      const url = entryLink(t, true);
      if (ok && entryFrame.getAttribute('src') !== url) entryFrame.setAttribute('src', url);
    }

    // While the panel is open the page is narrowed beside it rather than covered. The width is yours to
    // drag and is remembered, but the panel never takes so much room that the page gets narrower than
    // MIN_PAGE, so a wide panel in a smaller window stays beside the page. Only a window too narrow for
    // both gets the panel over the page.
    const DEFAULT_WIDTH = 480;
    const MIN_WIDTH = 380;
    const MIN_PAGE = 640;
    let width = GM_getValue(PANEL_WIDTH_KEY, 0) || DEFAULT_WIDTH;
    // Side by side leaves the page at least MIN_PAGE wide; the overlay can be as wide as the window allows
    const panelWidth = () => Math.round(Math.max(MIN_WIDTH, Math.min(width, layout === 'side' ? innerWidth - MIN_PAGE : innerWidth - 48, 1400)));
    const dockStyle = h('style', { id: 'zdr-dock' });
    function dock() {
      const w = panelWidth();
      host.style.setProperty('--w', `${w}px`);
      const docked = !panel.hidden && layout === 'side' && innerWidth - w >= MIN_PAGE;
      panel.classList.toggle('docked', docked);
      panel.classList.toggle('overlay', layout !== 'side');
      // The overlay opens beside the bubble: to its left when the bubble is on the right half of the screen,
      // otherwise to its right, lined up with it and kept inside the window
      if (layout !== 'side') {
        // The anchor is the sidebar button when that's the chosen launcher, otherwise the bubble
        const a = launcherMode() === 'sidebar' && sideBtn.isConnected ? sideBtn.getBoundingClientRect()
          : (() => { const x = parseFloat(launch.style.left) || innerWidth - 80, y = parseFloat(launch.style.top) || innerHeight - 80; return { left: x, top: y, right: x + 58, bottom: y + 58 }; })();
        const pw = Math.min(w, innerWidth - 24);
        const ph = Math.min(innerHeight - 24, 820);
        const toRight = (a.left + a.right) / 2 <= innerWidth / 2;   // opens to the button's right, so it resizes from its right edge
        const left = toRight ? a.right + 10 : a.left - 10 - pw;
        panel.classList.toggle('grip-right', toRight);
        panel.style.left = `${Math.round(Math.max(12, Math.min(innerWidth - pw - 12, left)))}px`;
        panel.style.top = `${Math.round(Math.max(12, Math.min(innerHeight - ph - 12, (a.top + a.bottom) / 2 - ph / 2)))}px`;
        panel.style.height = `${ph}px`;
        panel.style.right = 'auto';
      } else {
        for (const k of ['left', 'top', 'height', 'right']) panel.style[k] = '';
        panel.classList.remove('grip-right');
      }
      layoutBtn.textContent = layout === 'side' ? '⧉' : '◫';
      layoutBtn.title = layout === 'side' ? 'Float over the page (overlay)' : 'Open side by side with the page';
      layoutBtn.setAttribute('aria-label', layoutBtn.title);
      const css = docked ? `body { margin-right: ${w}px !important; }` : '';
      if (dockStyle.textContent !== css) dockStyle.textContent = css;
      if (!dockStyle.isConnected) (document.head || document.documentElement).append(dockStyle);
    }
    window.addEventListener('resize', () => { if (!panel.hidden) dock(); });
    grip.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch { /* the drag still works while the pointer stays on the edge */ }
      panel.classList.add('resizing');
      // The edge away from the button moves; the side by the button stays put
      const box = panel.getBoundingClientRect();
      const fromRight = panel.classList.contains('grip-right');
      const edge = layout === 'side' ? innerWidth : box.right;
      const move = ev => { width = fromRight ? ev.clientX - box.left : edge - ev.clientX; dock(); };
      const done = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', done);
        grip.removeEventListener('pointercancel', done);
        panel.classList.remove('resizing');
        width = panelWidth();
        GM_setValue(PANEL_WIDTH_KEY, width);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', done);
      grip.addEventListener('pointercancel', done);
    });
    grip.addEventListener('dblclick', () => { width = DEFAULT_WIDTH; GM_deleteValue(PANEL_WIDTH_KEY); dock(); });
    grip.addEventListener('keydown', e => {
      const step = e.key === 'ArrowLeft' ? 40 : e.key === 'ArrowRight' ? -40 : 0;
      if (!step) return;
      e.preventDefault();
      width = panelWidth() + step;
      dock();
      width = panelWidth();
      GM_setValue(PANEL_WIDTH_KEY, width);
    });

    let state = null;
    let siteInput = null;
    let answerInput = null;
    // Whether answers are shared and synced; kept outside `rest` so a sync can update it without a redraw
    const syncState = h('p', { class: 'hint', style: 'margin:0 0 8px' });
    const rest = h('div');

    // While the panel is open, coworkers' answers are picked up every 15 seconds and when you come back to the tab
    const NOTES_POLL_MS = 15000;
    let pollTimer = null;
    // The panel is only redrawn when the answers changed, so reading or selecting text in an open answer
    // isn't interrupted every 15 seconds. The first sync also re-picks the lines to tick, since coworkers'
    // answers may have just arrived.
    function syncNow() {
      if (!state) return Promise.resolve();
      const id = state.data.disputeId;
      const before = JSON.stringify(loadNotes(id).notes);
      return syncNotes(id).then(() => {
        if (state && state.data.disputeId === id) {
          const pad = loadNotes(id);
          const first = !state.synced;
          state.synced = true;
          if (first && !state.selectionTouched) state.selected = unresearchedLines(state.data);
          if (first || JSON.stringify(pad.notes) !== before) render();
          else showSyncState(pad);
        }
        if (view !== 'settings') refreshNotesKeyNote();
      });
    }

    function showSyncState(pad) {
      const shared = sharedNotesOn();
      const waiting = pad.notes.filter(n => n.pending).length;
      syncState.className = `hint${shared && pad.syncError ? ' warn' : ''}`;
      syncState.textContent = !shared
        ? 'Saved on this computer only.'
        : pad.syncError
          ? `${pad.syncError} Saved here; it will sync when it can${waiting ? ` (${waiting} waiting)` : ''}.`
          : pad.syncedAt
            ? `Shared with your team · checked ${new Date(pad.syncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${waiting ? ` · ${waiting} waiting to sync` : ''}`
            : 'Shared with your team · checking…';
    }
    function startPolling() {
      stopPolling();
      pollTimer = setInterval(() => {
        if (state && !panel.hidden && document.visibilityState === 'visible') {
          syncNow();
          claudeTabNews();
          desk.pollAnswers();
        }
      }, NOTES_POLL_MS);
    }
    function stopPolling() {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state && !panel.hidden) syncNow();
    });

    // Show the change at once, then send it to the notes server in the background
    function answersChanged() {
      render();
      syncNow();
    }

    // Lines nobody has an answer for, and that this computer hasn't sent to Claude
    function unresearchedLines(data) {
      const rec = loadRecord(data.disputeId);
      const pad = loadNotes(data.disputeId);
      return new Set(data.items.filter(i => i.inDispute && !rec.lines[i.line]?.sentAt && !lineAnswer(pad, i.line)).map(i => i.line));
    }

    // Coming back from the Claude tab: it may have filled the message box and kept Claude's answer
    window.addEventListener('focus', () => {
      if (!state || panel.hidden) return;
      render();
      claudeTabNews();
    });

    const setStatus = (text, kind = '') => { status.textContent = text; status.className = `status ${kind}`; };

    // What the Claude tab left for this panel: how filling its message box went (shown once), and Claude's
    // finished answer, which render() offers to save
    function claudeTabNews() {
      const s = state;
      if (!s || panel.hidden) return;
      const last = s.lastHandoff;
      const fill = last && GM_getValue(FILL_PREFIX + last.id, null);
      if (fill && fill.at !== last.reportedAt) {
        last.reportedAt = fill.at;
        const [text, ok] = fillMessage(fill, last);
        setStatus(text, ok ? 'ok' : 'warn');
        if (!fill.login) GM_deleteValue(FILL_PREFIX + last.id);
      }
      const reply = GM_getValue(REPLY_PREFIX + s.data.disputeId, null);
      if ((reply?.at || 0) !== (s.replyShown || 0)) render();
    }

    function fillMessage(fill, last) {
      const names = fill.files.join(', ');
      const also = [last.skipped.length && `Couldn't download ${last.skipped.join('; ')}.`, last.warning].filter(Boolean).join(' ');
      const say = (text, ok) => [`${text}${also ? ` ${also}` : ''}`, ok && !also];
      if (fill.login) return say('Claude asked you to sign in. Once you have, in that tab, the prompt fills in by itself.', false);
      if (!fill.typed) return say(`Claude's message box couldn't be filled, so the prompt is on your clipboard: click the box there and press Ctrl+V.${names ? ` Then attach ${names} from the page.` : ''}`, false);
      if (!fill.attached) return say(`Claude has the prompt, but the files didn't attach: add ${names} from the page.`, false);
      const n = fill.files.length;
      return say(`Claude has the prompt${n ? ` and ${n} ${n === 1 ? 'file' : 'files'}` : ''}. Nothing has been sent: check it there and press Enter. Claude's answer shows up here to save once it's done.`, true);
    }

    const setTokenNote = (text, kind = '') => { tokenNote.textContent = text; tokenNote.className = `hint ${kind}`; };

    // Without a token, the Research tab also says so (see render)
    function refreshTokenNote() {
      const saved = !!entryToken();
      if (saved) setTokenNote('Token saved. Click Test to check the connection.');
      else setTokenNote('No token saved, so the HTS lookups are off. Paste the ENTRY_API_TOKEN value from your entry-assistant skill.', 'warn');
    }
    refreshTokenNote();
    refreshNotesKeyNote();

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
      if (state) {
        state.factsPromise = (st => loadFacts().then(() => { if (st === state) desk.onFacts(st); }))(state);
        render();
      }
    }

    // HTS lookups for every disputed item that shows an HS code
    async function loadFacts() {
      const s = state;
      s.facts = {};
      if (s.data.kind === 'workOrder') return loadOrderFacts(s);
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

    // A queue order: the HS code review's pair first, then the other codes on the page, four at most, each
    // with what to report on the entry line and the partner agencies
    async function loadOrderFacts(s) {
      const d = s.data;
      const targets = d.pair.length ? [{ current: d.pair[0], claimed: d.pair[1], from: d.pairFrom }] : [];
      for (const c of d.codes) {
        if (targets.length < 4 && !targets.some(x => sameCode(x.current, c.code) || (x.claimed && sameCode(x.claimed, c.code)))) targets.push({ current: c.code, from: c.from });
      }
      if (!targets.length) return;
      targets.forEach((_, i) => { s.facts[i] = { loading: true }; });
      render();
      const review = d.type === 'HS_CODE_REVIEW';
      await Promise.all(targets.map(async (x, i) => {
        const item = { fields: [{ label: 'HS code', current: x.current, claimed: x.claimed || null }, { label: 'Country of origin', current: x.from || '', claimed: null }] };
        try {
          s.facts[i] = { data: await gatherFacts(item, { roles: review ? ['Current code', 'Suggested or corrected code'] : ['Code on the page', 'Second code'], rulings: review, extended: true }) };
        } catch (e) {
          console.warn('[Dispute Researcher] HTS lookup failed', e);
          s.facts[i] = { error: e.message, kind: e.kind || 'server' };
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
      dock();
      refreshTools();
      // Off an order page there's nothing to research, so the Research tab gives way to Tools
      if (!isCasePage()) {
        setView(view);
        return;
      }
      if (view === 'dispute') showResearchIdle();
      if (state && state.path === location.pathname) {
        reopenSync();
        return;
      }
      const path = location.pathname;
      setStatus('');
      if (WORK_ORDER_PATH.test(path)) {
        openOrder(path);
        return;
      }
      body.replaceChildren(h('p', { class: 'muted', text: 'Reading the dispute…' }));
      const ready = await waitFor(() => lineHeaders(document.querySelector('main') || document.body).length > 0);
      if (path !== location.pathname) return;
      const data = ready && extractDispute();
      if (!data) {
        body.replaceChildren(h('p', { class: 'err', text: "Couldn't find any items on this page. Wait for it to finish loading, then close and reopen this panel." }));
        return;
      }
      // A site you entered before wins, then the dashboard's own Website field, then a guess from the email
      const saved = GM_getValue(SITE_PREFIX + data.org.toLowerCase(), '');
      const guessed = guessWebsite(data.emailDomain);
      state = { path, data, website: saved || data.website || guessed, guessed: !saved && !data.website && !!guessed, site: null, siteError: '', checking: false, matches: {}, checked: {}, facts: {}, factsPromise: null, selected: new Set(), answerOpen: false, showAnswer: {}, openAnswers: {} };
      // Every document is attached by default; untick any you don't want sent
      for (const doc of [...data.items.flatMap(i => i.docs), ...data.orderDocs]) state.checked[doc.name] = true;
      shareOldAnswers(data.disputeId);
      // Lines not yet sent to Claude or answered start ticked (checked again once coworkers' answers arrive)
      state.selected = unresearchedLines(data);
      answerInput = h('textarea', { class: 'answer', rows: 6, placeholder: "Paste Claude's whole answer here (formatting is kept as Markdown)", 'aria-label': "Claude's answer", onpaste: pasteAsMarkdown });
      body.replaceChildren(rest);
      startPolling();
      syncNow();
      siteInput = h('input', {
        type: 'text', value: state.website, placeholder: 'https://merchant-site.com', 'aria-label': 'Merchant website',
        oninput: e => { state.website = e.target.value; },
        onkeydown: e => { if (e.key === 'Enter') checkSite(); },
      });
      render();
      state.factsPromise = (st => loadFacts().then(() => { if (st === state) desk.onFacts(st); }))(state);
      if (state.website) checkSite();
    }

    // A queue order: one page, read generally; no lines to tick, website or documents
    async function openOrder(path) {
      body.replaceChildren(h('p', { class: 'muted', text: 'Reading the order…' }));
      await waitFor(() => document.querySelector('main section h2, main h1, main button[title="Look up in the HTS"]'));
      if (path !== location.pathname) return;
      const data = readWorkOrder();
      if (!data || !data.lines.length) {
        body.replaceChildren(h('p', { class: 'err', text: "Couldn't read this order. Wait for the page to finish loading, then close and reopen this panel." }));
        return;
      }
      state = { kind: 'workOrder', path, data, site: null, matches: {}, checked: {}, facts: {}, factsPromise: null, selected: new Set(), answerOpen: false, showAnswer: {}, openAnswers: {} };
      answerInput = h('textarea', { class: 'answer', rows: 6, placeholder: "Paste Claude's whole answer here (formatting is kept as Markdown)", 'aria-label': "Claude's answer", onpaste: pasteAsMarkdown });
      body.replaceChildren(rest);
      startPolling();
      syncNow();
      render();
      state.factsPromise = (st => loadFacts().then(() => { if (st === state) desk.onFacts(st); }))(state);
    }

    function close() {
      panel.hidden = true;
      dock();
      stopPolling();
      launch.hidden = false;
    }

    // Reopening an already-loaded panel picks up coworkers' answers straight away
    function reopenSync() {
      if (state && !pollTimer) startPolling();
      syncNow();
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
      const isOrder = d.kind === 'workOrder';
      const word = isOrder ? 'order' : 'dispute';
      // The panel only shows what the dashboard page doesn't: the site check result is one line, and the
      // HTS facts, claim details and product numbers go into the prompt without being shown here
      const matchCount = Object.values(s.matches).reduce((n, found) => n + found.length, 0);
      const siteLine = s.siteError ? h('p', { class: 'hint err', text: s.siteError })
        : s.checking ? h('p', { class: 'hint', text: s.site ? "Searching the merchant's products…" : 'Checking the site…' })
        : s.site && h('p', { class: `hint${s.site.blocked ? ' warn' : ''}`, text: [
            `Checked: ${s.site.platforms.join(', ') || s.site.generator || 'platform not recognized'}`,
            Object.keys(s.matches).length > 0 && (matchCount ? `${matchCount} possible product ${matchCount === 1 ? 'match' : 'matches'}` : 'no product matches'),
            s.site.blocked && 'the site may block automated checks',
          ].filter(Boolean).join(' · ') });

      const rec = loadRecord(d.disputeId);
      const pad = loadNotes(d.disputeId);
      const shared = sharedNotesOn();
      const noteLink = (text, onclick) => h('button', { class: 'linkish', type: 'button', text, onclick });
      const inDispute = d.items.filter(i => i.inDispute);
      const claimCount = inDispute.reduce((n, i) => n + claimsOf(i).length, 0);
      const doneCount = inDispute.filter(i => lineAnswer(pad, i.line)).length;
      const picked = inDispute.filter(i => s.selected.has(i.line));
      const pickedClaims = picked.reduce((n, i) => n + claimsOf(i).length, 0);

      const toggleLine = (line, on) => {
        if (on) s.selected.add(line);
        else s.selected.delete(line);
        s.selectionTouched = true;
        render();
      };

      // Under a line: the verdict sentence from the newest answer, and that line's part of the answer
      const savedAnswer = item => {
        const la = lineAnswer(pad, item.line);
        const part = la && answerPart(la.answer.text, item.line);
        if (!la || (!la.sentence && !part)) return null;
        const open = !!s.showAnswer[item.line];
        return h('div', { class: 'sub-block' },
          la.sentence && h('p', { class: 'verdict', text: la.sentence }),
          part && noteLink(open ? 'Hide answer' : 'Show answer', () => { s.showAnswer[item.line] = !open; render(); }),
          open && part && h('div', { class: 'md saved' }, renderMarkdown(part)));
      };

      // One card per line with claims: the whole card is the tick box, and a ticked card is outlined and
      // tinted, so it's plain which lines go to Claude. Lines without claims aren't listed.
      const lineCard = item => {
        const on = s.selected.has(item.line);
        const { text, kind } = lineStatus(rec.lines[item.line], lineAnswer(pad, item.line));
        const fields = [...new Set(claimsOf(item).map(c => c.field))];
        const target = lineCodes(item);
        const entryLine = target.codes.length > 0 && h('div', { class: 'sub-block' },
          noteLink(target.codes.length === 2 ? `Compare ${target.codes[0]} with ${target.codes[1]} in Entry Assistant` : `Look up ${target.codes[0]} in Entry Assistant`,
            () => showEntry(target)));
        return h('div', {},
          h('label', { class: `line${on ? ' on' : ''}` },
            h('input', { type: 'checkbox', checked: on, 'aria-label': `Research line ${item.line}: ${item.title}`, onchange: e => toggleLine(item.line, e.target.checked) }),
            h('span', { class: 'line-main' },
              h('span', { class: 'line-name', title: item.title },
                h('strong', { text: `Line ${item.line}` }),
                h('span', { class: 'line-title', text: item.title })),
              h('span', { class: 'line-tags' },
                fields.map(f => h('span', { class: 'tag', text: f })),
                h('span', { class: `chip state ${kind}`, text })))),
          entryLine,
          savedAnswer(item));
      };

      // Documents of the ticked lines plus the order's own; all attached unless unticked, folded away by default
      const docs = [...new Map([...inDispute.filter(i => s.selected.has(i.line)).flatMap(i => i.docs), ...d.orderDocs].map(doc => [doc.name, doc])).values()];
      const attached = docs.filter(doc => s.checked[doc.name]).length;
      const docsBlock = docs.length > 0 && h('details', { class: 'section docs', open: !!s.docsOpen, ontoggle: e => { s.docsOpen = e.currentTarget.open; } },
        h('summary', { text: `Documents to attach: ${attached} of ${docs.length}` }),
        docs.map(doc => h('label', { class: 'doc' },
          h('input', { type: 'checkbox', checked: !!s.checked[doc.name], onchange: e => { s.checked[doc.name] = e.target.checked; render(); } }),
          h('span', { text: doc.name }))));
      // A value claim can only be checked against the price paid, which is usually on the invoice or receipt
      const valueHint = picked.some(i => claimsOf(i).some(c => /value/i.test(c.field)))
        && docs.some(doc => !isImage(doc.name) && !s.checked[doc.name])
        && h('p', { class: 'hint warn', text: 'Value claim: tick the invoice or receipt so Claude can check the price paid.' });

      // Many claims in one chat get shallower research, so suggest splitting big batches
      const batchHint = picked.length > 1 && pickedClaims > 3
        && h('p', { class: 'hint warn', text: `${pickedClaims} claims on ${picked.length} lines in one chat. Claude digs deeper with fewer at a time: untick some lines and research them next.` });
      const noneHint = inDispute.length > 0 && !picked.length
        && h('p', { class: 'hint', text: doneCount === inDispute.length ? 'Every line has a saved answer. Tick a line to research it again.' : 'Tick the lines you want researched.' });

      const storeAnswer = (text, lines) => {
        const verdicts = recordAnswer(d.disputeId, lines, text);
        s.answerOpen = false;
        s.selected = unresearchedLines(d);
        const found = isOrder ? decisionOf(text)?.decision : Object.entries(verdicts).map(([line, v]) => `line ${line}: ${v.verdict}`).join(', ');
        setStatus(found ? `Answer saved for everyone on this ${word} (${found}).`
          : isOrder ? 'Answer saved for everyone on this order, but it has no decision line ("Decision: …").'
          : "Answer saved for everyone on this dispute, but it has no verdict sentence (\"The merchant's claim is …\").", found ? 'ok' : 'warn');
        desk.onAnswer(text, lines, found || '', GM_getValue(AUTHOR_KEY, ''));
        answersChanged();
      };
      const saveAnswer = () => {
        const text = answerInput.value.trim();
        if (!text) return;
        answerInput.value = '';
        storeAnswer(text, isOrder ? [] : picked.length ? picked.map(i => i.line) : inDispute.map(i => i.line));
      };

      // Every saved answer, newest first, folded; open one to read it formatted or copy its Markdown
      const answers = visibleAnswers(pad);

      // Claude's finished answer from the tab Open in Claude opened, kept on this computer until you save
      // or dismiss it. One that's already saved (pasted by hand, say) is let go.
      const replyKey = REPLY_PREFIX + d.disputeId;
      let reply = GM_getValue(replyKey, null);
      if (reply && answers.some(a => a.text === reply.text.trim().slice(0, 30000))) {
        GM_deleteValue(replyKey);
        reply = null;
      }
      s.replyShown = reply?.at || 0;
      const replyLines = reply && (isOrder ? [] : reply.lines.length ? reply.lines : inDispute.map(i => i.line));
      const replyVerdicts = reply && (isOrder ? decisionOf(reply.text)?.decision || '' : Object.entries(parseVerdicts(reply.text, replyLines)).map(([line, v]) => `line ${line}: ${v.verdict}`).join(', '));
      const replyBlock = reply && h('div', { class: 'reply-ready' },
        h('p', { class: 'reply-title', text: `Claude's answer is ready${replyVerdicts ? ` (${replyVerdicts})` : ''}` }),
        h('p', { class: 'hint', style: 'margin:0 0 6px', text: `From the chat opened ${shortDate(reply.at)}. Saving shares it with everyone on this ${word}.` }),
        h('details', { open: !!s.replyPreview, ontoggle: e => { s.replyPreview = e.currentTarget.open; } },
          h('summary', { text: 'Preview' }),
          h('div', { class: 'md saved' }, renderMarkdown(reply.text))),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { class: 'primary', type: 'button', text: 'Save answer', onclick: () => { GM_deleteValue(replyKey); storeAnswer(reply.text, replyLines); } }),
          h('button', { class: 'secondary', type: 'button', text: 'Dismiss', onclick: () => { GM_deleteValue(replyKey); render(); } })));
      const answerCard = a => {
        const verdicts = [...new Set(Object.values(parseVerdicts(a.text, a.lines || [])).map(v => capitalized(v.verdict)))];
        const confirming = s.confirmDelete === a.id;
        const decision = isOrder && decisionOf(a.text);
        const note = isOrder && noteOf(a.text);
        const summary = [
          isOrder ? 'Answer' : a.lines?.length ? `Line${a.lines.length > 1 ? 's' : ''} ${a.lines.join(', ')}` : 'Answer',
          isOrder ? decision?.decision || 'no decision' : verdicts.length ? verdicts.join(' / ') : 'no verdict',
          a.author,
          shortDate(a.createdAt),
          shared && a.pending && 'waiting to sync',
          a.rejected && `not shared: ${a.rejected}`,
        ].filter(Boolean).join(' · ');
        return h('details', { class: `answer-card${a.mine === false ? ' theirs' : ''}`, open: !!s.openAnswers[a.id], ontoggle: e => { s.openAnswers[a.id] = e.currentTarget.open; } },
          h('summary', { text: summary }),
          h('div', { class: 'md saved' }, renderMarkdown(a.text)),
          h('div', { class: 'note-meta' },
            note && noteLink('Copy note', () => copyNote(note)),
            noteLink('Copy Markdown', () => { GM_setClipboard(a.text, 'text'); setStatus('Answer copied as Markdown.', 'ok'); }),
            a.mine !== false && (confirming
              ? [h('span', { text: 'Delete this answer for everyone?' }),
                noteLink('Delete', () => { deleteNote(d.disputeId, a.id); s.confirmDelete = null; answersChanged(); }),
                noteLink('Keep', () => { s.confirmDelete = null; render(); })]
              : noteLink('Delete', () => { s.confirmDelete = a.id; render(); }))));
      };
      // Claude's answer in one sentence, first: the case's "Claude Final Answer" in Notion when it's connected,
      // otherwise the Final answer line of the latest saved answer. The full answer folds away under it.
      const fromNotion = desk.finalAnswer();
      const newest = answers[0];
      const finalText = fromNotion || (newest && finalSentence(newest.text));
      const finalCard = finalText && h('div', { class: 'final-card' },
        h('p', { class: 'final-text', text: finalText }),
        h('p', { class: 'hint', style: 'margin:4px 0 0', text: fromNotion ? 'From the case in Notion' : `From the answer saved ${shortDate(newest.createdAt)}` }));
      const answerSection = (isOrder || inDispute.length > 0) && h('div', { class: 'section' },
        h('p', { class: 'label', text: "Claude's answer" }),
        finalCard,
        syncState,
        replyBlock,
        newest && h('div', { class: 'answers' }, answerCard(newest)),
        s.answerOpen
          ? h('div', {},
              answerInput,
              h('div', { class: 'row', style: 'margin-top:6px' },
                h('button', { class: 'secondary', type: 'button', text: 'Save', onclick: saveAnswer }),
                h('button', { class: 'secondary', type: 'button', text: 'Cancel', onclick: () => { s.answerOpen = false; render(); } })))
          : h('button', { class: 'secondary', type: 'button', text: "Paste Claude's answer", title: `Saved as Markdown and shared with everyone on this ${word}.`, onclick: () => { s.answerOpen = true; render(); answerInput.focus(); } }));

      showSyncState(pad);
      // Redraws happen while lookups finish; if you're typing in a box that gets moved (the website box),
      // put focus and the cursor back where it was
      const active = root.activeElement;
      const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
      const scroll = body.scrollTop;

      // A queue order: what the page asks, the choices, the latest decision with its note, and the codes
      const latest = isOrder && answers.find(a => decisionOf(a.text));
      const latestDecision = latest && decisionOf(latest.text);
      const latestNote = latest && noteOf(latest.text);
      const orderSection = isOrder && h('div', { class: 'section' },
        h('p', { class: 'label', text: d.label }),
        h('div', { class: 'order-card' },
          d.question && h('p', { class: 'order-q', text: d.question }),
          d.summary && h('p', { class: 'hint', style: 'margin:0', text: d.summary }),
          d.choices.length > 0 && h('p', { class: 'hint', text: `Choices on the page: ${d.choices.map(c => c.label).join(' · ')}` }),
          latestDecision && h('p', { class: 'verdict', style: 'margin-top:8px', text: `Claude: ${latestDecision.decision} · ${latest.author} · ${shortDate(latest.createdAt)}` }),
          latestNote && noteLink(`Copy the ${guideFor(d.type).note.toLowerCase()}`, () => copyNote(latestNote))),
        (d.pair.length === 2 || d.codes.length > 0) && h('div', { class: 'order-links' },
          d.pair.length === 2 && h('div', {}, noteLink(`Compare ${d.pair[0]} with ${d.pair[1]} in Entry Assistant`, () => showEntry({ codes: d.pair, from: d.pairFrom }))),
          d.codes.slice(0, 4).map(c => h('div', {}, noteLink(`Look up ${c.code}${c.from ? ` (made in ${regionName(c.from)})` : ''} in Entry Assistant`, () => showEntry({ codes: [c.code], from: c.from }))))),
        !d.hasShipper && /HS_CODE|VALUE|DENIED/.test(d.type) && h('p', { class: 'hint', text: 'Open Parties and Items on the page before you send, so Claude gets the shipper and every line.' }),
        !WORK_ORDER_GUIDES[d.type] && h('p', { class: 'hint warn', text: `No research guide for ${d.label} yet, so Claude gets the page with a general brief.` }));
      const tokenHint = !entryToken() && h('p', { class: 'hint warn' },
        "The HTS lookups for Claude's prompt are off until the Entry Assistant token is saved in ",
        noteLink('Settings', () => setView('settings')), '.');

      desk.setPageData(d);
      const deskCard = desk.card(noteLink);
      if (isOrder) {
        rest.replaceChildren(...[deskCard, orderSection, answerSection, tokenHint].filter(Boolean));
      } else rest.replaceChildren(...[
        deskCard,
        h('div', { class: 'section' },
          h('p', { class: 'label', text: 'Lines to research' }),
          inDispute.length > 0
            ? [h('p', { class: 'hint summary', text: `Ticked lines go to Claude · ${claimCount} ${claimCount === 1 ? 'claim' : 'claims'} on ${inDispute.length} ${inDispute.length === 1 ? 'line' : 'lines'} · ${doneCount} researched` }),
              h('div', { class: 'lines' }, inDispute.map(lineCard)),
              batchHint, noneHint]
            : h('p', { class: 'hint', text: 'No line on this dispute has a claim.' })),
        h('div', { class: 'section' },
          h('p', { class: 'label', text: 'Merchant website' }),
          h('div', { class: 'row' },
            siteInput,
            h('button', { class: 'secondary', type: 'button', text: 'Check site', disabled: s.checking, onclick: () => checkSite() })),
          s.guessed && h('p', { class: 'hint', text: "Guessed from the merchant's email domain. Change it if it's wrong." }),
          siteLine),
        docsBlock,
        valueHint,
        answerSection,
        tokenHint,
      ].filter(Boolean));

      body.scrollTop = scroll;
      if (active && active.isConnected && root.activeElement !== active) {
        active.focus({ preventScroll: true });
        if (caret) active.setSelectionRange(...caret);
      }
    }

    // Re-read the page right before building the prompt, so claims and download links are current,
    // then keep only the ticked lines (plus order-level documents)
    function freshData() {
      if (state.data.kind === 'workOrder') {
        const page = readWorkOrder();
        return page && page.workOrderId === state.data.workOrderId && page.lines.length ? page : state.data;
      }
      const page = extractDispute();
      const d = page && page.disputeId === state.data.disputeId && page.items.length ? page : state.data;
      const items = d.items.filter(i => i.inDispute && state.selected.has(i.line));
      if (!items.length) throw new Error('Tick at least one line to research.');
      return { ...d, items };
    }
    const promptFor = (d, names) => (d.kind === 'workOrder' ? buildWorkOrderPrompt(d, state) : buildPrompt(d, state, names));
    const copyNote = note => {
      GM_setClipboard(note, 'text');
      setStatus(`Note copied. Paste it into the note box on the page: "${note}"`, 'ok');
    };
    const selectedDocs = d => [...d.items.flatMap(i => i.docs), ...d.orderDocs].filter(doc => state.checked[doc.name]);

    async function run(action) {
      if (!state) return;
      ccBtn.disabled = openBtn.disabled = copyBtn.disabled = true;
      try {
        await action();
      } catch (e) {
        setStatus(e.message, 'err');
      } finally {
        ccBtn.disabled = openBtn.disabled = copyBtn.disabled = false;
      }
    }

    // The same prompt as Open in Claude, put on the case in Notion as a task for Claude Code, with the
    // documents as links. Claude Code researches it (web search, Entry Assistant) and writes its answer onto
    // the case page, which this panel picks up and saves with the shared answers.
    // Sent right away: the cloud session runs its own Entry Assistant lookups, so the panel's aren't waited for
    async function sendToClaudeCode({ openTab = true } = {}) {
      const d = freshData();
      const docs = selectedDocs(d);
      const prompt = promptFor(d, docs.map(x => x.name));
      const lines = d.kind === 'workOrder' ? [] : d.items.map(i => i.line);
      setStatus('Sending to Claude Code…');
      const r = await desk.queueResearch({ prompt, docs, lines, label: d.kind === 'workOrder' ? d.label : 'Duty dispute', openTab });
      markSent(d.disputeId, d.items);
      render();
      setStatus(r.dry ? 'Test mode: the research request was not written (see the case card). Tick "Write to Notion in test mode" under Settings (the cog in Tools) to try it for real.'
        : r.session ? 'Sent to Claude Code. Its research session opened in a new tab; the answer shows up here and on the case in Notion when it finishes.'
        : `Sent to Claude Code, but the cloud session didn't start right away${r.fireError ? ` (${r.fireError})` : ''}. The hourly sweep will pick it up; the answer shows up here and on the case in Notion.`, r.dry || !r.session ? 'warn' : 'ok');
      return r;
    }

    // The autopilot's way in: read this page the way opening the panel does, research every disputed line (or the
    // whole work order), and send it to Claude Code without opening a tab. Nothing on the portal is clicked.
    async function autoResearch() {
      await open();
      const path = location.pathname;
      const ok = await waitFor(() => state && state.path === path && state.data, { timeout: 45000 });
      if (!ok) throw new Error("Couldn't read this page (it didn't finish loading).");
      if (state.data.kind !== 'workOrder') state.selected = new Set(state.data.items.filter(i => i.inDispute).map(i => i.line));
      await sleep(1500);   // let the portal's own data arrive, so the snapshot and the prompt carry it
      return sendToClaudeCode({ openTab: false });
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
      GM_setClipboard(promptFor(d, names), 'text');
      markSent(d.disputeId, d.items);
      desk.onSent('prompt copied for Claude', d.kind === 'workOrder' ? [] : d.items.map(i => i.line));
      render();
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
      const prompt = promptFor(d, files.map(f => f.name));
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const lines = d.items.map(i => i.line);
      GM_setValue(HANDOFF_PREFIX + id, { id, createdAt: Date.now(), disputeId: d.disputeId, lines, prompt, files });
      markSent(d.disputeId, d.items);
      desk.onSent('opened in claude.ai', d.kind === 'workOrder' ? [] : lines);
      render();
      // How filling the message box went is reported back when you return here (see claudeTabNews)
      state.lastHandoff = { id, skipped, warning: lookupWarning().trim() };
      GM_openInTab(`https://claude.ai/new#zdr=${id}`, { active: true, insert: true, setParent: true });
      const warning = lookupWarning();
      if (skipped.length) setStatus(`Opened Claude, but couldn't download: ${skipped.join('; ')}.${warning}`, 'warn');
      else setStatus(`Opened Claude in a new tab. The prompt and files go into its message box; nothing is sent until you press Enter there.${warning}`, warning ? 'warn' : 'ok');
    }

    return {
      show() { attach(); if (panel.hidden) launch.hidden = false; placeLauncher(); },
      hide() { stopPolling(); launch.hidden = true; panel.hidden = true; dock(); },
      reset() { stopPolling(); state = null; panel.hidden = true; dock(); setStatus(''); },
      keepAttached() {
        placeLauncher();
        if (!host.isConnected && (!launch.hidden || !panel.hidden)) attach();
        if (!panel.hidden && !dockStyle.isConnected) dock();
        if (!panel.hidden) refreshTools();
        else hideRail(GM_getValue(HIDE_RAIL_KEY, false));
      },
      isOpen: () => !panel.hidden,
      toggle() { if (panel.hidden) open(); else close(); },
      tools() { setView('dispute'); open(); },
      openTool,
      step,
      open,
      showEntry,
      autoResearch,
    };
  }

  function initDashboard() {
    // Shows in DevTools (F12 > Console), so it's easy to confirm the script is running at all
    console.info(`[Dispute Researcher] v${typeof GM_info !== 'undefined' ? GM_info.script.version : '?'} running on ${location.pathname}`);
    purgeOldHandoffs();
    purgeOldRecords();
    purgeOldReports();
    trimStoredAnswers();
    let ui = null;
    let lastPath = null;
    // A way in from the Tampermonkey toolbar menu, in case the button doesn't show
    GM_registerMenuCommand('Open Tools', () => {
      ui = ui || createPanel();
      ui.open();
    });
    // A code on the dispute page (the dashboard's "Look up in the HTS" buttons) opens in the panel's Entry
    // Assistant tab instead of the dashboard's References window, comparing the line's two codes when the
    // merchant claims another one. This runs before the dashboard's own click handler; Alt-click skips it.
    // While the site doesn't allow being shown in the dashboard, the click goes to the dashboard as before.
    window.addEventListener('click', e => {
      const button = e.target?.closest?.('button[title="Look up in the HTS"]');
      if (!button || e.altKey || !isCasePage() || !GM_getValue(ENTRY_CLICKS_KEY, false)) return;
      if (entryFrameCheck?.result === false) {
        entryFrameable(); // asks again if it's been a minute, for the next click
        return;
      }
      const target = clickedCodeTarget(button);
      if (!target) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ui = ui || createPanel();
      ui.showEntry(target);
    }, true);
    // Tools is on every portal page. It stays open as you move from order to order, and the work queue
    // page shows the portal's own queue unless the Tools queue is chosen under Tools.
    let queue = null;
    const onRoute = () => {
      ui?.keepAttached();
      if (GM_getValue(READABLE_KEY, false)) makeReadable();
      fixListLinks();
      showPrograms();
      if (onQueuePage()) { queue = queue || createQueue(); queue.mount(); }
      else queue?.unmount();
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      desk.onRoute();
      if (isCasePage()) entryFrameable(); // known by the time a code is clicked
      ui = ui || createPanel();
      const wasOpen = ui.isOpen();
      ui.reset();
      ui.show();
      if (wasOpen) ui.open();
    };
    // Keys anywhere on the portal, never while typing: \ Tools, Shift+C Classify, Shift+Q Quote, [ ] previous / next order
    window.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.composedPath()[0];
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[role="dialog"]:not([hidden])')) return;
      ui = ui || createPanel();
      const k = e.key;
      if (k === '\\') ui.toggle();
      else if (k === 'C' && e.shiftKey) ui.openTool('classify');
      else if (k === 'Q' && e.shiftKey) ui.openTool('quote');
      else if ((k === '[' || k === ']') && isCasePage()) ui.step(k === ']' ? 1 : -1);
      else return;
      e.preventDefault();
    }, true);   // before the panel, which keeps its keys from the page, so these also work after clicking in it
    if (window.onurlchange === null) window.addEventListener('urlchange', onRoute);
    setInterval(onRoute, 1000); // fallback for client-side navigation, and re-attaches if the app re-renders <body>
    onRoute();

    // The Research Autopilot userscript talks to this one through page events (JSON strings, so they cross
    // script sandboxes): "zdd:ask" { id, cmd, ...args } is answered by "zdd:reply" { id, ok, result | error }.
    // It can only ask for research and read Notion; nothing here clicks or submits anything in the portal.
    const reply = (id, ok, payload) => document.dispatchEvent(new CustomEvent('zdd:reply', { detail: JSON.stringify({ id, ok, ...payload }) }));
    document.addEventListener('zdd:ask', async e => {
      let m;
      try { m = JSON.parse(e.detail); } catch { return; }
      try {
        let result;
        if (m.cmd === 'ping') result = { version: typeof GM_info !== 'undefined' ? GM_info.script.version : '?', notion: desk.enabled(), path: location.pathname };
        else if (m.cmd === 'state') result = await desk.researchState(m.key);
        else if (m.cmd === 'open') result = { open: await desk.openResearch() };
        else if (m.cmd === 'fire') result = await desk.fireResearch(m.taskId, m.pageId, { openTab: false });
        else if (m.cmd === 'research') {
          if (!isCasePage()) throw new Error('Not on a dispute or work order page.');
          ui = ui || createPanel();
          result = await ui.autoResearch();
        } else throw new Error(`Unknown request ${m.cmd}`);
        reply(m.id, true, { result });
      } catch (err) { reply(m.id, false, { error: err.message }); }
    });
  }

  /* -------------------------------------------------- claude.ai: fill the box */

  // Nothing is shown over claude.ai. The tab that Open in Claude opens fills the message box (it never
  // sends), then reports how that went, and later Claude's finished answer, through Tampermonkey storage.
  // The dashboard panel shows both when you come back to it, and saves the answer only when you say so.
  const FILL_PREFIX = 'zdr:fill:'; // per handoff: { id, disputeId, at, files, typed, attached } or { login }
  const REPLY_PREFIX = 'zdr:reply:'; // per dispute: { handoffId, lines, text, at }
  const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  // This tab only (sessionStorage), so signing in to Claude, which drops the #zdr marker, doesn't lose the prompt
  const PENDING_KEY = 'zdr:pendingHandoff';
  const tabPending = {
    get() { try { return sessionStorage.getItem(PENDING_KEY) || ''; } catch { return ''; } },
    set(id) { try { if (id) sessionStorage.setItem(PENDING_KEY, id); else sessionStorage.removeItem(PENDING_KEY); } catch { /* not kept */ } },
  };

  // Fill reports and kept answers go once the dashboard has used them, or after a week
  function purgeOldReports() {
    for (const key of GM_listValues()) {
      if (!key.startsWith(FILL_PREFIX) && !key.startsWith(REPLY_PREFIX)) continue;
      const v = GM_getValue(key, null);
      if (!v || Date.now() - (v.at || 0) > REPORT_TTL_MS) GM_deleteValue(key);
    }
  }

  // Claude's latest reply on the page, as Markdown. claude.ai's markup changes, so several markers are
  // tried, newest message first, and our own prompt is skipped.
  const ANSWER_SELECTORS = ['[data-is-streaming]', '.font-claude-response', '.font-claude-message', '[data-testid="assistant-message"]'];
  function latestAnswer() {
    for (const sel of ANSWER_SELECTORS) {
      const els = document.querySelectorAll(sel);
      for (let i = els.length - 1; i >= 0; i--) {
        const raw = (els[i].textContent || '').trim();
        if (raw.length <= 40 || raw.includes('## How to research') || raw.startsWith("I'm a customs broker at Zonos")) continue;
        return { el: els[i], raw, streaming: !!els[i].closest('[data-is-streaming="true"]') };
      }
    }
    return null;
  }

  // Keeps Claude's newest finished answer that has a verdict sentence, for the panel to offer. A later
  // reply without one (the email to the merchant, say) doesn't replace it. Stops after six hours.
  function keepAnswers(handoff) {
    let lastRaw = '';
    const end = Date.now() + 6 * 60 * 60 * 1000;
    const timer = setInterval(() => {
      if (Date.now() > end) {
        clearInterval(timer);
        return;
      }
      const found = latestAnswer();
      if (!found || found.streaming || found.raw === lastRaw) return;
      lastRaw = found.raw;
      const text = htmlToMarkdown(found.el) || found.raw;
      if (!VERDICT_RE.test(text) && !decisionOf(text)) return;
      GM_setValue(REPLY_PREFIX + handoff.disputeId, { handoffId: handoff.id, lines: handoff.lines || [], text, at: Date.now() });
    }, 3000);
  }
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

  // Fills the message box and attaches the files, then reports how it went. Returns false when Claude
  // wants you to sign in first, so the prompt is kept for after that.
  async function fillFromHandoff(handoff) {
    const report = result => GM_setValue(FILL_PREFIX + handoff.id, { id: handoff.id, disputeId: handoff.disputeId, at: Date.now(), files: handoff.files.map(f => f.name), ...result });
    if (/^\/login/.test(location.pathname)) {
      report({ login: true });
      return false;
    }
    const composer = await waitFor(findComposer, { timeout: 20000 });
    let typed = false;
    let attached = !handoff.files.length;
    if (composer) {
      await sleep(600); // let the editor finish mounting
      const box = findComposer() || composer;
      typed = await insertText(box, handoff.prompt);
      if (handoff.files.length) {
        try {
          attached = attachFiles(handoff.files.map(dataUrlToFile), findComposer() || box);
        } catch { /* reported below */ }
      }
    }
    if (!typed) GM_setClipboard(handoff.prompt, 'text');
    GM_deleteValue(HANDOFF_PREFIX + handoff.id);
    report({ typed, attached });
    return true;
  }

  function initClaude() {
    purgeOldHandoffs();
    purgeOldReports();
    let id = (INITIAL_HASH.match(/zdr=([a-z0-9]+)/i) || [])[1] || '';
    if (id) history.replaceState(history.state, '', location.pathname + location.search);
    else id = tabPending.get();
    const handoff = id ? GM_getValue(HANDOFF_PREFIX + id, null) : null;
    tabPending.set(handoff ? id : '');
    if (!handoff) return;
    fillFromHandoff(handoff).then(done => {
      if (!done) return;
      tabPending.set('');
      if (handoff.disputeId) keepAnswers(handoff);
    });
  }
  onReady(() => {
    if (location.host === DASHBOARD_HOST) initDashboard();
    else if (location.host === 'claude.ai') initClaude();
  });
})();
