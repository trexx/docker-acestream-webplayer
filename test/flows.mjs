// Behavioral test of player/index.html: drives every UI flow in a headless
// Chromium-family browser over CDP. No dependencies — run with `node test/flows.mjs`
// (Node 22+ for the built-in WebSocket client). Override the browser binary with
// BROWSER_BIN (default: thorium-browser).
//
// The stub server plays two roles: static host for the page (a media element on a
// file:// page cannot load from 127.0.0.1) and fake rust-acestream-proxy, answering
// /video and /audio. Both send headers and then hold the socket open, so the media
// element stays in "loading" instead of erroring on a garbage payload. The HA
// webhooks are stubbed in-page: nothing leaves the machine.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'player');
const BROWSER_BIN = process.env.BROWSER_BIN || 'thorium-browser';

// ---- stub server: page host + fake proxy ------------------------------------

const hits = [];
const sockets = new Set();
const stub = createServer((req, res) => {
  if (req.url === '/index.html' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(readFileSync(`${ROOT}/index.html`));
  } else {
    hits.push(req.url);
    res.writeHead(200, { 'Content-Type': req.url.startsWith('/audio') ? 'audio/aac' : 'video/mp4' });
    // no body, never end: keeps the media element waiting instead of erroring
  }
});
stub.on('connection', s => sockets.add(s));
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const PORT = stub.address().port;

// ---- browser launch + CDP plumbing ------------------------------------------

const profileDir = await mkdtemp(join(tmpdir(), 'player-test-'));
const browser = spawn(BROWSER_BIN, [
  '--headless', '--disable-gpu', '--no-sandbox',
  `--user-data-dir=${profileDir}`,
  '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=0', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// port 0 avoids collisions; the browser reports the real port via its profile dir
let dbgPort = null;
for (let i = 0; i < 60 && !dbgPort; i++) {
  await sleep(250);
  const f = join(profileDir, 'DevToolsActivePort');
  if (existsSync(f)) dbgPort = parseInt(readFileSync(f, 'utf8').split('\n')[0], 10);
}
if (!dbgPort) throw new Error(`browser did not start (BROWSER_BIN=${BROWSER_BIN})`);

let targets;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  try {
    targets = await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json();
    if (targets.length) break;
  } catch {}
}
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);

let mid = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown')
    pageErrors.push(m.params.exceptionDetails.exception?.description || JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise(res => {
  const i = ++mid;
  pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evl = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};
const waitHit = async substr => {
  for (let i = 0; i < 30; i++) {
    const h = hits.find(u => u.includes(substr));
    if (h) return h;
    await sleep(200);
  }
  return null;
};

// ---- the flows ---------------------------------------------------------------

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(1500);

const CID = 'ab'.repeat(20);
await evl(`
  idEl.value = ${JSON.stringify(CID)};
  hostEl.value = '127.0.0.1:${PORT}';
  window.__haCalls = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    if (String(url).includes('hass.apps.pixelman.me')) {
      window.__haCalls.push({ url: String(url), body: JSON.parse(opts.body) });
      return Promise.resolve(new Response('', { status: 200 }));
    }
    return realFetch(url, opts);
  };
  'ready';
`);

const VIDEO_URL = `http://127.0.0.1:${PORT}/video?id=${CID}`;
const AUDIO_URL = `http://127.0.0.1:${PORT}/audio?id=${CID}`;

// --- Stream ---
await evl(`document.getElementById('btnPreview').click(); 'ok'`);
check('Stream: status shows the proxy /video URL', await evl(`statusEl.textContent === ${JSON.stringify('Streaming: ' + VIDEO_URL)}`), await evl(`statusEl.textContent`));
const videoHit = await waitHit('/video');
check('Stream: proxy got the video request', !!videoHit);
check('Stream: request carries the id and nothing else (no pid)', videoHit === `/video?id=${CID}`, videoHit ?? '');
check('Stream: element src points at the proxy', await evl(`video.src === ${JSON.stringify(VIDEO_URL)}`));
check('Stream: not in audio mode', await evl(`!document.body.classList.contains('audio-mode')`));

// --- Listen ---
hits.length = 0;
await evl(`document.getElementById('btnListen').click(); 'ok'`);
const audioHit = await waitHit('/audio');
check('Listen: proxy got the audio request', !!audioHit);
check('Listen: audio request carries the id', audioHit === `/audio?id=${CID}`, audioHit ?? '');
check('Listen: element src swapped to /audio', await evl(`video.src === ${JSON.stringify(AUDIO_URL)}`));
check('Listen: audio mode on, panel shown', await evl(`document.body.classList.contains('audio-mode') && !audioPanel.hidden`));
check('Listen: now-playing title is the id', await evl(`npTitle.textContent === ${JSON.stringify(CID)}`));

// --- Show video (exit audio mode) ---
await evl(`document.getElementById('btnExitAudio').click(); 'ok'`);
check('Exit audio: class removed, panel hidden', await evl(`!document.body.classList.contains('audio-mode') && audioPanel.hidden`));

// --- Stream again while the audio stream is active (teardown branch) ---
hits.length = 0;
await evl(`document.getElementById('btnPreview').click(); 'ok'`);
check('Restream: src swapped back to /video', await evl(`video.src === ${JSON.stringify(VIDEO_URL)}`));
check('Restream: proxy hit again', !!(await waitHit('/video')));

// --- Cast ---
await evl(`document.getElementById('btnCast').click(); 'ok'`);
await sleep(300);
const castCall = await evl(`window.__haCalls[0] ?? null`);
check('Cast: webhook called once', !!castCall && await evl(`window.__haCalls.length === 1`));
check('Cast: payload is {url, device}, url is the proxy /video', !!castCall
  && castCall.body.url === VIDEO_URL
  && castCall.body.device === 'basement-tv'
  && Object.keys(castCall.body).length === 2,
  JSON.stringify(castCall?.body));
check('Cast: accepted status shown', await evl(`statusEl.textContent.includes('Cast request accepted (basement-tv)')`));

// --- Cast to an audio-only target ---
await evl(`
  deviceEl.value = 'amp';
  deviceEl.dispatchEvent(new Event('change'));
  document.getElementById('btnCast').click();
  'ok'
`);
await sleep(300);
const audioCast = await evl(`window.__haCalls[1] ?? null`);
check('Cast: audio-only device is sent /audio', !!audioCast
  && audioCast.body.url === AUDIO_URL
  && audioCast.body.device === 'amp',
  JSON.stringify(audioCast?.body));

// --- Stop cast ---
await evl(`document.getElementById('btnStop').click(); 'ok'`);
await sleep(300);
const stopCall = await evl(`window.__haCalls[2] ?? null`);
check('Stop: payload is {device}', !!stopCall && stopCall.body.device === 'amp' && Object.keys(stopCall.body).length === 1, JSON.stringify(stopCall?.body));

// --- Persistence ---
check('Persist: id/host saved', await evl(`
  localStorage.getItem('acestreamId') === ${JSON.stringify(CID)} &&
  localStorage.getItem('engineHost') === '127.0.0.1:${PORT}'
`));
await evl(`deviceEl.value = 'living-room-tv'; deviceEl.dispatchEvent(new Event('change')); 'ok'`);
check('Persist: cast device saved on change', await evl(`localStorage.getItem('castDevice') === 'living-room-tv'`));

// --- Reload restores settings (incl. device select needing options first) ---
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(1200);
check('Reload: inputs + device restored', await evl(`
  idEl.value === ${JSON.stringify(CID)} && hostEl.value === '127.0.0.1:${PORT}' &&
  deviceEl.value === 'living-room-tv'
`));

const realErrors = pageErrors.filter(t => !/MediaError/i.test(t));
check('No unexpected page exceptions', realErrors.length === 0, JSON.stringify(realErrors));

// ---- teardown ------------------------------------------------------------------

browser.kill();
await new Promise(r => browser.once('exit', r)); // profile dir is busy until the browser is gone
for (const s of sockets) s.destroy();
stub.close();
// The browser can still be flushing its profile as it exits; a leftover temp dir must
// not turn a passing run into a failing one.
try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
catch (e) { console.log(`(left ${profileDir} behind: ${e.code})`); }
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
