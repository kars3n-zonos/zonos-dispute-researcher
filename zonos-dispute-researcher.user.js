// ==UserScript==
// @name         Zonos Dispute Researcher
// @namespace    zonos-brokerage
// @version      0.23.0
// @description  Adds a "Research" panel to duty dispute pages: merchant research handed to Claude on claude.ai, Claude's answers saved and shared for each dispute, and the Entry Assistant site for looking up and comparing HTS codes. Never changes anything on the dashboard, and never sends a message on claude.ai.
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
// @connect      prod-zonos-brokerage.s3.us-east-2.amazonaws.com
// @connect      entry.kars3n.com
// @connect      notes.kars3n.com
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
  const NOTES_API = 'https://notes.kars3n.com/api/v1';
  const NOTES_KEY = 'zdr:notesKey'; // pasted by hand
  const NOTES_JOIN = 'zdr:notesJoin'; // { key, name, expiresAt } from joining, plus { failedAt, error } after a failed try
  const SESSION_ISSUER = 'https://clerk.zonos.com';
  const JOIN_RETRY_MS = 2 * 60 * 1000;
  const JOIN_RENEW_MS = 3 * 24 * 60 * 60 * 1000;
  const manualNotesKey = () => GM_getValue(NOTES_KEY, '');
  const joinRecord = () => GM_getValue(NOTES_JOIN, null) || {};
  const sharedNotesOn = () => !!(manualNotesKey() || joinRecord().key) || location.host === DASHBOARD_HOST;

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

  function changeNotes(id, change) {
    const pad = loadNotes(id);
    change(pad);
    pad.updatedAt = Date.now();
    GM_setValue(NOTES_PREFIX + id, pad);
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
        method: 'POST', url: `${NOTES_API}/register`, timeout: 15000,
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
        method, url: `${NOTES_API}${path}`, timeout: 15000,
        headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        data: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw apiError('unreachable', /too long/.test(e.message) ? 'The notes server took too long to respond.' : "Couldn't reach the notes server.");
    }
    let json = null;
    try { json = JSON.parse(r.responseText); } catch { /* handled by status below */ }
    if (r.status === 401) {
      if (manualNotesKey()) throw apiError('bad-token', 'The notes server rejected your key. Check it under Settings.');
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

  /* ------------------------------------------ dashboard: Entry Assistant site */

  // The Entry Assistant website, shown in the panel's second tab. Its address picks the page: one code
  // (?code=) or two compared (?compare=current,claimed), for goods made in `from`; embed=1 asks for its
  // compact layout. The site itself needs no token.
  const ENTRY_SITE = 'https://entry.kars3n.com/';

  function entryLink({ codes = [], from = '' } = {}, embed = false) {
    const url = new URL(ENTRY_SITE);
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
      check.promise = gmRequest({ url: ENTRY_SITE, headers: { Accept: 'text/html' }, timeout: 15000 })
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
    const code = tidyCode(button.textContent);
    if (!code) return null;
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

  // What counts as evidence for each kind of claim
  const CLAIM_CHECKS = [
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
    };
    // Claims about what the item is, where it's from or which duties apply get the full product research
    kinds.product = kinds.hs || kinds.description || kinds.origin || kinds.s232 || kinds.tariff;
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
    items.forEach((item, i) => L.push('', ...replyBlock(item, s, { platformUnknown: platformUnknown && i === 0 })));
    return L.filter(line => line !== false).join('\n');
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
      platformUnknown && "- **Platform:** <what the merchant's site runs on>",
      '',
      '**Ask the merchant for**',
      '1. <a specific document or fact> — <what it would prove; or "Nothing: the research settles it">',
      '',
      "**Verdict:** The merchant's claim is <substantiated | somewhat substantiated | not substantiated> because <the proof: what the evidence shows, where it comes from, and the rule it meets or fails>.",
    ];
  }

  /* ------------------------------------------------- dashboard: the panel */

  const PANEL_CSS = `
    :host { all: initial; --bg:#ffffff; --fg:#18181b; --muted:#71717a; --line:#e4e4e7; --soft:#f4f4f5; --tint:#fff7ed; --accent:#b45309; --accent-fg:#ffffff; --ok:#15803d; --warn:#b45309; --err:#b91c1c; }
    :host([data-theme="dark"]) { --bg:#0c0c0d; --fg:#f4f4f5; --muted:#a1a1aa; --line:#27272a; --soft:#18181b; --tint:#2a1d0a; --accent:#f59e0b; --accent-fg:#111111; --ok:#4ade80; --warn:#fbbf24; --err:#f87171; }
    * { box-sizing: border-box; }
    .wrap { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); }
    button { font: inherit; cursor: pointer; }
    button:disabled { opacity: .55; cursor: default; }
    button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .launch { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 999px; padding: 10px 16px; font-weight: 600; box-shadow: 0 6px 20px rgba(0,0,0,.35); }
    .panel { position: fixed; top: 0; right: 0; height: 100vh; width: min(var(--w, 480px), 100vw); z-index: 2147483001; display: flex; flex-direction: column; background: var(--bg); color: var(--fg); border-left: 1px solid var(--line); box-shadow: -10px 0 30px rgba(0,0,0,.3); }
    .panel.docked { box-shadow: none; }
    .panel.resizing { user-select: none; }
    .panel.resizing iframe { pointer-events: none; }
    [hidden] { display: none !important; }
    .grip { position: absolute; top: 0; bottom: 0; left: -4px; width: 8px; cursor: col-resize; z-index: 2; }
    .grip::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: transparent; }
    .grip:hover::after, .grip:focus-visible::after, .resizing .grip::after { background: var(--accent); }
    .grip:focus-visible { outline: none; }
    header { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; padding: 6px 8px 0 10px; border-bottom: 1px solid var(--line); }
    .tabs { display: flex; gap: 2px; min-width: 0; }
    .tab { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--muted); padding: 9px 8px 8px; font-weight: 600; white-space: nowrap; }
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
  `;

  function createPanel() {
    const host = h('div', { id: 'zdr-host' });
    const root = host.attachShadow({ mode: 'open' });
    // Keep the dashboard's keyboard shortcuts from firing while typing in the panel
    for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, e => e.stopPropagation());

    const body = h('div', { class: 'body' });
    const status = h('div', { class: 'status', role: 'status' });
    const openBtn = h('button', { class: 'primary', type: 'button', text: 'Open in Claude', onclick: () => run(handoff) });
    const copyBtn = h('button', { class: 'secondary', type: 'button', text: 'Copy prompt', onclick: () => run(copyPrompt) });
    const launch = h('button', { class: 'launch', type: 'button', text: 'Research', hidden: true, onclick: () => open() });
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
      if (manualNotesKey()) setNotesKeyNote('Using the notes key you pasted. To join through your dashboard sign-in instead, empty the box and click Save.');
      else if (rec.key) setNotesKeyNote(`Shared answers: joined through your dashboard sign-in as ${rec.name}.`, 'ok');
      else if (rec.error) setNotesKeyNote(rec.error, 'err');
      else setNotesKeyNote('Shared answers: you join on your own through your dashboard sign-in.');
    }
    async function testNotesKey() {
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
    const settingsBody = h('div', { class: 'body' },
      h('div', { class: 'group' },
        h('p', { class: 'label', text: 'Your name' }),
        h('div', { class: 'row' }, authorInput)),
      h('div', { class: 'group' },
        h('p', { class: 'label', text: 'Shared answers' }),
        h('div', { class: 'row' },
          notesKeyInput,
          h('button', { class: 'secondary', type: 'button', text: 'Save', onclick: () => saveNotesKey() }),
          h('button', { class: 'secondary', type: 'button', text: 'Test', onclick: () => testNotesKey() })),
        notesKeyNote),
      h('div', { class: 'group' },
        h('p', { class: 'label', text: 'Entry Assistant token' }),
        h('p', { class: 'hint', style: 'margin:0 0 6px', text: "For the HTS lookups that go into Claude's prompt. The Entry Assistant tab doesn't need it." }),
        h('div', { class: 'row' },
          tokenInput,
          h('button', { class: 'secondary', type: 'button', text: 'Save', onclick: () => saveToken() }),
          h('button', { class: 'secondary', type: 'button', text: 'Test', onclick: () => testConnection() })),
        tokenNote),
      h('p', { class: 'fine', text: "The panel only reads the dispute page and never changes anything on the dashboard. Once the Entry Assistant site allows being shown here, clicking a code on the page opens it in the Entry Assistant tab instead of the dashboard's References window (Alt-click for theirs). Claude won't send anything until you press Enter there." }),
      h('p', { class: 'fine', text: 'Drag the panel\'s left edge to make it wider or narrower; double-click the edge for the default width.' }));

    // The Entry Assistant site, in a frame that's kept while you switch tabs
    const entryCaption = h('span', { class: 'entry-caption' });
    const entryNewTab = h('a', { target: '_blank', rel: 'noreferrer', text: 'Open in a new tab ↗' });
    const entryFrame = h('iframe', { class: 'entry-frame', title: 'Entry Assistant', referrerpolicy: 'no-referrer', allow: 'clipboard-write', hidden: true });
    const entryBlockedLink = h('a', { class: 'primary', target: '_blank', rel: 'noreferrer', text: 'Open Entry Assistant ↗' });
    const entryBlocked = h('div', { class: 'entry-blocked', hidden: true },
      h('p', { text: "The Entry Assistant site doesn't allow being shown inside the dashboard yet, so it opens in its own tab for now." }),
      entryBlockedLink);

    const views = {
      dispute: h('section', { class: 'view' }, body,
        h('footer', {},
          h('div', { class: 'actions' }, openBtn, copyBtn),
          status)),
      entry: h('section', { class: 'view', hidden: true },
        h('div', { class: 'entry-bar' }, entryCaption, entryNewTab),
        entryBlocked, entryFrame),
      settings: h('section', { class: 'view', hidden: true }, settingsBody),
    };
    const tab = (name, text) => h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'false', text, onclick: () => setView(name) });
    const tabs = { dispute: tab('dispute', 'Research'), entry: tab('entry', 'Entry Assistant') };
    const gear = h('button', { class: 'icon', type: 'button', 'aria-label': 'Settings', title: 'Settings', 'aria-pressed': 'false', text: '⚙︎', onclick: () => setView(view === 'settings' ? lastView : 'settings') });
    const grip = h('div', { class: 'grip', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': 'Resize panel', title: 'Drag to resize. Double-click for the default width.' });
    const panel = h('aside', { class: 'panel', hidden: true, 'aria-label': 'Research' },
      grip,
      h('header', {},
        h('nav', { class: 'tabs', role: 'tablist' }, tabs.dispute, tabs.entry),
        h('div', { class: 'header-actions' },
          gear,
          h('button', { class: 'icon', type: 'button', 'aria-label': 'Close panel', title: 'Close', text: '×', onclick: () => close() }))),
      views.dispute, views.entry, views.settings);
    root.append(h('style', { text: PANEL_CSS }), h('div', { class: 'wrap' }, launch, panel));

    let view = 'dispute';
    let lastView = 'dispute';
    function setView(name) {
      view = name;
      if (name !== 'settings') lastView = name;
      for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
      for (const [k, el] of Object.entries(tabs)) el.setAttribute('aria-selected', String(k === name));
      gear.setAttribute('aria-pressed', String(name === 'settings'));
      if (name === 'entry') showEntryPage();
      if (name === 'settings') refreshNotesKeyNote();
    }
    setView('dispute');

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

    // While the panel is open the page is narrowed beside it rather than covered, unless the window is
    // too narrow for both; the width is yours to drag and is remembered
    const DEFAULT_WIDTH = 480;
    const MIN_WIDTH = 380;
    const MIN_PAGE = 640;
    let width = GM_getValue(PANEL_WIDTH_KEY, 0) || DEFAULT_WIDTH;
    const panelWidth = () => Math.round(Math.max(MIN_WIDTH, Math.min(width, innerWidth - 320, 1400)));
    const dockStyle = h('style', { id: 'zdr-dock' });
    function dock() {
      const w = panelWidth();
      host.style.setProperty('--w', `${w}px`);
      const docked = !panel.hidden && innerWidth - w >= MIN_PAGE;
      panel.classList.toggle('docked', docked);
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
      const move = ev => { width = innerWidth - ev.clientX; dock(); };
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
        if (state && !panel.hidden && document.visibilityState === 'visible') syncNow();
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

    // Claude's answer may have been saved from the claude.ai tab while this one was in the background
    window.addEventListener('focus', () => { if (state && !panel.hidden) render(); });

    const setStatus = (text, kind = '') => { status.textContent = text; status.className = `status ${kind}`; };

    const setTokenNote = (text, kind = '') => { tokenNote.textContent = text; tokenNote.className = `hint ${kind}`; };

    // Without a token, the Research tab also says so (see render)
    function refreshTokenNote() {
      const saved = !!GM_getValue(TOKEN_KEY, '');
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
        state.factsPromise = loadFacts();
        render();
      }
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
      dock();
      if (state && state.path === location.pathname) {
        reopenSync();
        return;
      }
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
      state.factsPromise = loadFacts();
      if (state.website) checkSite();
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

      const saveAnswer = () => {
        const text = answerInput.value.trim();
        if (!text) return;
        const lines = picked.length ? picked.map(i => i.line) : inDispute.map(i => i.line);
        const verdicts = recordAnswer(d.disputeId, lines, text);
        answerInput.value = '';
        s.answerOpen = false;
        s.selected = unresearchedLines(d);
        const found = Object.entries(verdicts).map(([line, v]) => `line ${line}: ${v.verdict}`).join(', ');
        setStatus(found ? `Answer saved for everyone on this dispute (${found}).` : "Answer saved for everyone on this dispute, but it has no verdict sentence (\"The merchant's claim is …\").", found ? 'ok' : 'warn');
        answersChanged();
      };

      // Every saved answer, newest first, folded; open one to read it formatted or copy its Markdown
      const answers = visibleAnswers(pad);
      const answerCard = a => {
        const verdicts = [...new Set(Object.values(parseVerdicts(a.text, a.lines || [])).map(v => capitalized(v.verdict)))];
        const confirming = s.confirmDelete === a.id;
        const summary = [
          a.lines?.length ? `Line${a.lines.length > 1 ? 's' : ''} ${a.lines.join(', ')}` : 'Answer',
          verdicts.length ? verdicts.join(' / ') : 'no verdict',
          a.author,
          shortDate(a.createdAt),
          shared && a.pending && 'waiting to sync',
          a.rejected && `not shared: ${a.rejected}`,
        ].filter(Boolean).join(' · ');
        return h('details', { class: `answer-card${a.mine === false ? ' theirs' : ''}`, open: !!s.openAnswers[a.id], ontoggle: e => { s.openAnswers[a.id] = e.currentTarget.open; } },
          h('summary', { text: summary }),
          h('div', { class: 'md saved' }, renderMarkdown(a.text)),
          h('div', { class: 'note-meta' },
            noteLink('Copy Markdown', () => { GM_setClipboard(a.text, 'text'); setStatus('Answer copied as Markdown.', 'ok'); }),
            a.mine !== false && (confirming
              ? [h('span', { text: 'Delete this answer for everyone?' }),
                noteLink('Delete', () => { deleteNote(d.disputeId, a.id); s.confirmDelete = null; answersChanged(); }),
                noteLink('Keep', () => { s.confirmDelete = null; render(); })]
              : noteLink('Delete', () => { s.confirmDelete = a.id; render(); }))));
      };
      const answerSection = inDispute.length > 0 && h('div', { class: 'section' },
        h('p', { class: 'label', text: answers.length ? `Claude's answers (${answers.length})` : "Claude's answers" }),
        syncState,
        answers.length > 0 && h('div', { class: 'answers' }, answers.map(answerCard)),
        s.answerOpen
          ? h('div', {},
              answerInput,
              h('div', { class: 'row', style: 'margin-top:6px' },
                h('button', { class: 'secondary', type: 'button', text: 'Save', onclick: saveAnswer }),
                h('button', { class: 'secondary', type: 'button', text: 'Cancel', onclick: () => { s.answerOpen = false; render(); } })))
          : h('button', { class: 'secondary', type: 'button', text: "Paste Claude's answer", title: 'Saved as Markdown and shared with everyone on this dispute. On claude.ai, Save answer to dispute does the same.', onclick: () => { s.answerOpen = true; render(); answerInput.focus(); } }));

      showSyncState(pad);
      // Redraws happen while lookups finish; if you're typing in a box that gets moved (the website box),
      // put focus and the cursor back where it was
      const active = root.activeElement;
      const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
      const scroll = body.scrollTop;

      rest.replaceChildren(...[
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
        !GM_getValue(TOKEN_KEY, '') && h('p', { class: 'hint warn' },
          "The HTS lookups for Claude's prompt are off until the Entry Assistant token is saved in ",
          noteLink('Settings', () => setView('settings')), '.'),
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
      const page = extractDispute();
      const d = page && page.disputeId === state.data.disputeId && page.items.length ? page : state.data;
      const items = d.items.filter(i => i.inDispute && state.selected.has(i.line));
      if (!items.length) throw new Error('Tick at least one line to research.');
      return { ...d, items };
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
      markSent(d.disputeId, d.items);
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
      const prompt = buildPrompt(d, state, files.map(f => f.name));
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const lines = d.items.map(i => i.line);
      GM_setValue(HANDOFF_PREFIX + id, { id, createdAt: Date.now(), disputeId: d.disputeId, lines, prompt, files });
      markSent(d.disputeId, d.items);
      render();
      GM_openInTab(`https://claude.ai/new#zdr=${id}`, { active: true, insert: true, setParent: true });
      const warning = lookupWarning();
      if (skipped.length) setStatus(`Opened Claude, but couldn't attach: ${skipped.join('; ')}.${warning}`, 'warn');
      else setStatus(`Opened Claude in a new tab. Check the message there, then press Enter to send.${warning}`, warning ? 'warn' : 'ok');
    }

    return {
      show() { attach(); if (panel.hidden) launch.hidden = false; },
      hide() { stopPolling(); launch.hidden = true; panel.hidden = true; dock(); },
      reset() { stopPolling(); state = null; panel.hidden = true; dock(); setStatus(''); },
      keepAttached() {
        if (!host.isConnected && (!launch.hidden || !panel.hidden)) attach();
        if (!panel.hidden && !dockStyle.isConnected) dock();
      },
      open,
      showEntry,
    };
  }

  function initDashboard() {
    // Shows in DevTools (F12 > Console), so it's easy to confirm the script is running at all
    console.info(`[Dispute Researcher] v${typeof GM_info !== 'undefined' ? GM_info.script.version : '?'} running on ${location.pathname}`);
    purgeOldHandoffs();
    purgeOldRecords();
    let ui = null;
    let lastPath = null;
    // A way in from the Tampermonkey toolbar menu, in case the button doesn't show
    GM_registerMenuCommand('Open Research', () => {
      ui = ui || createPanel();
      ui.open();
    });
    // A code on the dispute page (the dashboard's "Look up in the HTS" buttons) opens in the panel's Entry
    // Assistant tab instead of the dashboard's References window, comparing the line's two codes when the
    // merchant claims another one. This runs before the dashboard's own click handler; Alt-click skips it.
    // While the site doesn't allow being shown in the dashboard, the click goes to the dashboard as before.
    window.addEventListener('click', e => {
      const button = e.target?.closest?.('button[title="Look up in the HTS"]');
      if (!button || e.altKey || !DISPUTE_PATH.test(location.pathname)) return;
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
    const onRoute = () => {
      ui?.keepAttached();
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      if (DISPUTE_PATH.test(location.pathname)) {
        entryFrameable(); // known by the time a code is clicked
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
    .actions { grid-column: 1; display: flex; flex-wrap: wrap; gap: 8px; } .actions:empty { display: none; }
    textarea.paste { flex-basis: 100%; min-height: 90px; font: inherit; color: #f5f5f4; background: #292524; border: 1px solid #57534e; border-radius: 6px; padding: 6px 8px; resize: vertical; }
    button { font: inherit; cursor: pointer; border-radius: 6px; padding: 5px 10px; border: 1px solid #57534e; background: transparent; color: inherit; }
    button.primary { background: #f59e0b; border-color: #f59e0b; color: #111; font-weight: 600; }
    .close { grid-column: 2; grid-row: 1 / span 2; align-self: start; border: 0; font-size: 18px; line-height: 1; padding: 2px 6px; color: #a8a29e; }
    button:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; }
  `;

  function createBanner() {
    const host = h('div', { id: 'zdr-banner' });
    const root = host.attachShadow({ mode: 'open' });
    // Keep claude.ai's keyboard shortcuts from firing while typing in the paste box
    for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, e => e.stopPropagation());
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

  // Claude's latest reply on the page. claude.ai's markup changes, so several markers are tried,
  // and anything that is our own prompt is skipped.
  const ANSWER_SELECTORS = ['[data-is-streaming]', '.font-claude-response', '.font-claude-message', '[data-testid="assistant-message"]'];
  function latestAnswer() {
    for (const sel of ANSWER_SELECTORS) {
      const found = [...document.querySelectorAll(sel)]
        .map(el => ({ el, text: (el.innerText || '').trim() }))
        .filter(x => x.text.length > 40 && !x.text.includes('## How to research'));
      if (found.length) {
        const last = found[found.length - 1];
        // Kept as Markdown so headings, bold, lists, links and tables survive
        return { text: htmlToMarkdown(last.el) || last.text, streaming: !!last.el.closest('[data-is-streaming="true"]') };
      }
    }
    return null;
  }

  // Saves Claude's answer into the dispute's record, so the dashboard shows each line's verdict
  function saveButtons(handoff, banner, copyAgain) {
    return [bannerButton('Save answer to dispute', () => saveAnswerFromPage(handoff, banner, copyAgain), true), copyAgain];
  }

  // Saves the answer with the dispute's notes and sends it to the notes server straight away, so
  // coworkers see it; if that can't happen now, the dashboard sends it the next time the dispute is open
  async function storeAnswer(handoff, banner, text, copyAgain) {
    const verdicts = recordAnswer(handoff.disputeId, handoff.lines || [], text);
    const found = Object.entries(verdicts).map(([line, v]) => `line ${line}: ${v.verdict}`).join(', ');
    const what = found ? `(${found})` : '(no verdict sentence found: "The merchant\'s claim is …")';
    banner.set(`Saved to ${handoff.disputeId} ${what}. Sharing it with your team…`, found ? 'ok' : 'warn', saveButtons(handoff, banner, copyAgain));
    const sync = await syncNotes(handoff.disputeId);
    banner.set(sync.ok
      ? `Saved to ${handoff.disputeId} ${what} and shared with your team.`
      : `Saved to ${handoff.disputeId} ${what} on this computer. It will be shared the next time you open the dispute${sync.error ? ` (${sync.error.replace(/\.$/, '')})` : ''}.`,
    found && sync.ok ? 'ok' : 'warn', saveButtons(handoff, banner, copyAgain));
  }

  function saveAnswerFromPage(handoff, banner, copyAgain) {
    const found = latestAnswer();
    if (found?.streaming) {
      banner.set("Claude is still writing. Click Save answer to dispute again when it's finished.", 'warn', saveButtons(handoff, banner, copyAgain));
      return;
    }
    if (found && VERDICT_RE.test(found.text)) {
      storeAnswer(handoff, banner, found.text, copyAgain);
      return;
    }
    const box = h('textarea', { class: 'paste', rows: 5, placeholder: "Paste Claude's whole answer here", 'aria-label': "Claude's answer", onpaste: pasteAsMarkdown });
    banner.set("Couldn't read Claude's answer from the page. Copy it with the copy button under the answer, then paste it here:", 'warn', [
      box,
      bannerButton('Save', () => { if (box.value.trim()) storeAnswer(handoff, banner, box.value.trim(), copyAgain); }, true),
      copyAgain,
    ]);
    box.focus();
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
    banner.set(`${lead}${filesNote} Nothing has been sent: review it, then press Enter. When Claude has answered, click Save answer to dispute.`, typed ? 'ok' : 'warn',
      handoff.disputeId ? saveButtons(handoff, banner, copyAgain) : [copyAgain]);
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
