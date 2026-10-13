// Gives zonos-dispute-researcher.user.js the GM_* functions it gets from Tampermonkey, backed by Chrome
// extension APIs, so the same script file runs as a Tampermonkey script and as this extension.
// Loaded just before the script, as a content script on the dashboard and on claude.ai.
(() => {
  'use strict';

  // GM_getValue is synchronous, so everything in storage is loaded up front; the script waits for this
  const cache = {};
  globalThis.__ZDR_READY = chrome.storage.local.get(null).then(items => { Object.assign(cache, items); });

  // Keeps this tab in step with values saved from other tabs, like the token or a handoff
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (newValue === undefined) delete cache[key];
      else cache[key] = newValue;
    }
  });

  let pendingWrites = Promise.resolve();
  const write = op => {
    pendingWrites = pendingWrites.then(op).catch(e => console.warn('[Dispute Researcher] storage', e));
    return pendingWrites;
  };

  globalThis.GM_getValue = (key, fallback) => (key in cache ? cache[key] : fallback);
  globalThis.GM_setValue = (key, value) => {
    cache[key] = value;
    write(() => chrome.storage.local.set({ [key]: value }));
  };
  globalThis.GM_deleteValue = key => {
    delete cache[key];
    write(() => chrome.storage.local.remove(key));
  };
  globalThis.GM_listValues = () => Object.keys(cache);

  globalThis.GM_info = { script: { version: chrome.runtime.getManifest().version } };

  function base64ToBlob(b64, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || '' });
  }

  // Same shape as Tampermonkey's: content scripts can't make cross-site requests, so the service worker does
  globalThis.GM_xmlhttpRequest = details => {
    const { url, method = 'GET', headers = {}, timeout = 0, responseType, onload, onerror, ontimeout } = details;
    chrome.runtime.sendMessage({ type: 'zdr:fetch', url, method, headers, timeout, responseType })
      .then(res => {
        if (!res || !res.ok) return res && res.timedOut ? ontimeout?.() : onerror?.(res);
        const response = res.base64 != null ? base64ToBlob(res.base64, res.contentType) : res.responseText;
        onload?.({ status: res.status, finalUrl: res.finalUrl, responseHeaders: res.responseHeaders, responseText: res.responseText || '', response });
      })
      .catch(err => onerror?.({ error: String(err) }));
  };

  // Waits for pending storage writes, so the new claude.ai tab can read the handoff it's opened for
  globalThis.GM_openInTab = (url, options = {}) => {
    pendingWrites.then(() => chrome.runtime.sendMessage({ type: 'zdr:openTab', url, active: options.active !== false }));
  };

  globalThis.GM_setClipboard = text => {
    navigator.clipboard.writeText(text).catch(() => {
      const box = document.createElement('textarea');
      box.value = text;
      box.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.documentElement.append(box);
      box.select();
      document.execCommand('copy');
      box.remove();
    });
  };

  // The extension's toolbar button stands in for Tampermonkey's menu
  const commands = [];
  globalThis.GM_registerMenuCommand = (name, fn) => { commands.push(fn); };
  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'zdr:action' && commands.length) commands[0]();
  });
})();
