import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const source = readFileSync(new URL('../zonos-dispute-researcher.user.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('  function entryLink('), source.indexOf('  const sameCode ='));
const panel = source.slice(source.indexOf('    let entryReady = false;'), source.indexOf('    // While the panel is open'));
function setup() {
  let message; let request; const loads = [], sent = [], timers = new Map();
  const frameWindow = { postMessage: (data, origin) => sent.push({ data, origin }) };
  const frame = { hidden: true, contentWindow: frameWindow, setAttribute: (key, value) => loads.push(value) };
  const context = vm.createContext({ URL, Date, entrySite: () => 'https://entry.kars3n.com/', regionName: x => x,
    entryFrame: frame, entryCaption: {}, entryNewTab: {}, entryBlockedLink: {}, entryBlocked: {},
    headerMap: headers => ({ 'content-security-policy': headers }), location: { hostname: 'brokerage.dashboard.zonos.com' },
    gmRequest: () => new Promise(resolve => { request = resolve }),
    setTimeout: fn => { const id = timers.size + 1; timers.set(id, fn); return id }, clearTimeout: id => timers.delete(id),
    window: { addEventListener: (_name, fn) => { message = fn } }
  });
  vm.runInContext('let entryTarget=null;' + functions + panel, context);
  return { context, frame, loads, sent, timers,
    target: codes => vm.runInContext(`entryTarget=${JSON.stringify({ codes, from: 'CN' })};showEntryPage()`, context),
    message: (type, data = {}, origin = 'https://entry.kars3n.com', source = frameWindow) => message({ source, origin, data: { type, ...data } }),
    finishProbe: async allowed => { request({ responseHeaders: `frame-ancestors ${allowed ? 'https://brokerage.dashboard.zonos.com' : "'none'"}` }); for (let i = 0; i < 5; i++) await Promise.resolve() }
  };
}
test('starts the iframe immediately while the framing probe remains pending', () => {
  const t = setup(); t.target(['7318.15.2065']);
  assert.equal(t.loads.length, 1); assert.equal(t.frame.hidden, false);
});
test('reuses the ready app for a new code and Compare, acknowledging navigation without reloading', () => {
  const t = setup(); t.target(['7318.15.2065']); t.message('entry:ready');
  t.target(['8471.50']); assert.equal(t.loads.length, 1); assert.equal(t.sent.length, 1);
  assert.match(t.sent[0].data.url, /code=8471.50/); assert.equal(t.sent[0].origin, 'https://entry.kars3n.com');
  t.message('entry:navigated', { id: t.sent[0].data.id }); assert.equal(t.timers.size, 0);
  t.target(['8471.50', '8471.41']); assert.equal(t.loads.length, 1); assert.match(t.sent[1].data.url, /compare=/);
});
test('skips an identical target and retains a reload fallback for old site versions', () => {
  const t = setup(); t.target(['7318']); t.target(['7318']); assert.equal(t.loads.length, 1);
  t.target(['8471']); assert.equal(t.loads.length, 2);
  t.message('entry:ready'); t.target(['0902']); assert.equal(t.loads.length, 2);
  for (const run of [...t.timers.values()]) run(); assert.equal(t.loads.length, 3);
});
test('ignores readiness from a different frame or origin', () => {
  const t = setup(); t.target(['7318']); t.message('entry:ready', {}, 'https://other.example');
  t.target(['8471']); assert.equal(t.loads.length, 2); assert.equal(t.sent.length, 0);
  t.message('entry:ready', {}, 'https://entry.kars3n.com', {}); t.target(['0902']); assert.equal(t.loads.length, 3);
});
test('keeps a blocked-frame fallback without delaying the first navigation', async () => {
  const t = setup(); t.target(['7318']); assert.equal(t.loads.length, 1);
  await t.finishProbe(false); assert.equal(t.frame.hidden, true);
  assert.equal(vm.runInContext('entryBlocked.hidden', t.context), false);
});
