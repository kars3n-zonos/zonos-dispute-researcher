// Service worker for the extension: makes the cross-site requests the content script asks for
// (merchant sites, the Entry Assistant API, dispute documents), opens tabs, and handles the toolbar button.

const DISPUTES_URL = 'https://brokerage.dashboard.zonos.com/duty-disputes';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg) return false;
  if (msg.type === 'zdr:fetch') {
    doFetch(msg).then(sendResponse);
    return true; // answer arrives asynchronously
  }
  if (msg.type === 'zdr:openTab' && /^https:\/\//i.test(msg.url || '')) {
    const tab = sender.tab;
    chrome.tabs.create({ url: msg.url, active: msg.active !== false, openerTabId: tab?.id, index: tab ? tab.index + 1 : undefined });
    sendResponse(true);
  }
  return false;
});

// A short how-to the first time the extension is installed (not on updates)
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('extension/welcome.html') });
});

// On a dashboard tab the button opens the panel; anywhere else it opens the dispute list
chrome.action.onClicked.addListener(tab => {
  chrome.tabs.sendMessage(tab.id, { type: 'zdr:action' }).catch(() => chrome.tabs.create({ url: DISPUTES_URL }));
});

async function doFetch({ url, method = 'GET', headers = {}, body, timeout = 0, responseType }) {
  if (!/^https?:\/\//i.test(url || '')) return { ok: false, error: 'Only web addresses can be fetched' };
  const controller = new AbortController();
  const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    // Never send the user's cookies to merchant sites or anywhere else
    const r = await fetch(url, { method, headers, body, credentials: 'omit', redirect: 'follow', signal: controller.signal });
    const responseHeaders = [...r.headers].map(([k, v]) => `${k}: ${v}`).join('\r\n');
    const base = { ok: true, status: r.status, finalUrl: r.url, responseHeaders };
    if (responseType === 'blob') {
      return { ...base, base64: toBase64(await r.arrayBuffer()), contentType: r.headers.get('content-type') || '' };
    }
    return { ...base, responseText: await r.text() };
  } catch (e) {
    return { ok: false, timedOut: e.name === 'AbortError', error: String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
