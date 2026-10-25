// Behavioral test of player/index.html: drives every UI flow in a headless
// Chromium-family browser over CDP. No dependencies — run with `node test/flows.mjs`
// (Node 22+ for the built-in WebSocket client). Override the browser binary with
// BROWSER_BIN (default: thorium-browser; CI uses the runner's google-chrome).
//
// The stub server plays two roles: static host for the page (a media element on a
// file:// page cannot load from 127.0.0.1) and fake backend, answering both
// rust-acestream-proxy's /video and /audio and go-acestream-engine's
// /streams/content/<id>/video.mp4 and audio.aac. Each sends headers and then holds the
// socket open, so the media element stays in "loading" instead of erroring on a garbage
// payload — except for ERR_CID, which is answered 400 the way either backend refuses a
// stream, to exercise the media error path. The HA webhooks are stubbed in-page: nothing
// leaves the machine.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'player');
const BROWSER_BIN = process.env.BROWSER_BIN || 'thorium-browser';

const CID = 'ab'.repeat(20);
const ERR_CID = 'ee'.repeat(20);

// ---- stub server: page host + fake backend ----------------------------------

const hits = [];
const sockets = new Set();
const stub = createServer((req, res) => {
  if (req.url === '/index.html' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(readFileSync(`${ROOT}/index.html`));
  } else {
    hits.push(req.url);
    if (req.url.includes(ERR_CID)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('could not start stream: engine error: unknown content id\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': /\/audio[.?]/.test(req.url) ? 'audio/aac' : 'video/mp4' });
    // no body, never end: keeps the media element waiting instead of erroring
  }
});
stub.on('connection', s => sockets.add(s));
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const PORT = stub.address().port;

// ---- browser launch + CDP plumbing ------------------------------------------

const profileDir = await mkdtemp(join(tmpdir(), 'player-test-'));
// detached: the browser becomes its own process group, so teardown can signal every
// helper process at once. Killing only the main process left utility processes
// behind, still writing component downloads into the profile dir as it was removed.
const browser = spawn(BROWSER_BIN, [
  '--headless', '--disable-gpu', '--no-sandbox',
  `--user-data-dir=${profileDir}`,
  '--autoplay-policy=no-user-gesture-required',
  // Nothing here should phone home, and nothing should write to the profile once
  // the flows are done.
  '--no-first-run', '--no-default-browser-check', '--disable-component-update',
  '--disable-background-networking', '--disable-sync', '--disable-extensions',
  '--remote-debugging-port=0', 'about:blank',
], { stdio: 'ignore', detached: true });
const killBrowser = signal => { try { process.kill(-browser.pid, signal); } catch {} };
process.on('SIGINT', () => { killBrowser('SIGKILL'); process.exit(130); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Poll until `fn` returns something truthy or `ms` runs out; returns the last value.
const until = async (fn, ms = 6000, step = 100) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() >= deadline) return v;
    await sleep(step);
  }
};

// port 0 avoids collisions; the browser reports the real port via its profile dir
const dbgPort = await until(() => {
  const f = join(profileDir, 'DevToolsActivePort');
  return existsSync(f) ? parseInt(readFileSync(f, 'utf8').split('\n')[0], 10) : null;
}, 15000, 250);
if (!dbgPort) throw new Error(`browser did not start (BROWSER_BIN=${BROWSER_BIN})`);

const page = await until(async () => {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json();
    return targets.find(t => t.type === 'page');
  } catch { return null; }
}, 15000, 250);
if (!page) throw new Error('no page target on the DevTools endpoint');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('could not open the CDP websocket'));
});

let mid = 0;
const pending = new Map();
const pageErrors = [];
const waiting = new Map(); // CDP event method -> resolvers for its next occurrence
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown')
    pageErrors.push(m.params.exceptionDetails.exception?.description || JSON.stringify(m.params.exceptionDetails));
  if (m.method && waiting.has(m.method)) {
    for (const r of waiting.get(m.method)) r(m);
    waiting.delete(m.method);
  }
};
const send = (method, params = {}) => new Promise(res => {
  const i = ++mid;
  pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const nextEvent = method => new Promise(r => waiting.set(method, [...(waiting.get(method) ?? []), r]));
const evl = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
// Wait for the load event rather than a fixed delay, so a slow runner isn't a failure.
const navigate = async url => {
  const loaded = nextEvent('Page.loadEventFired');
  await send('Page.navigate', { url });
  await loaded;
};
const untilPage = (expr, ms) => until(() => evl(expr), ms);

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};
const waitHit = (substr, ms = 6000) => until(() => hits.find(u => u.includes(substr)) ?? null, ms, 200);
const click = id => evl(`document.getElementById(${JSON.stringify(id)}).click(); 'ok'`);

// ---- the flows ---------------------------------------------------------------

await send('Runtime.enable');
await send('Page.enable');
await navigate(`http://127.0.0.1:${PORT}/index.html`);

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

const PAGE_URL = `http://127.0.0.1:${PORT}/index.html`;
// What each backend is asked for: the request path the stub sees, and the full URL the page
// builds from it.
const PATHS = {
  proxy: { video: `/video?id=${CID}`, audio: `/audio?id=${CID}` },
  engine: { video: `/streams/content/${CID}/video.mp4`, audio: `/streams/content/${CID}/audio.aac` },
};
const urls = backend => ({
  video: `http://127.0.0.1:${PORT}${PATHS[backend].video}`,
  audio: `http://127.0.0.1:${PORT}${PATHS[backend].audio}`,
});
const VIDEO_URL = urls('proxy').video;

check('Backend: the proxy is the default', await evl(`backendEl.value === 'proxy'`), await evl(`backendEl.value`));

// Stream, Listen, Show video, Stream again, Cast to a video and an audio target, Stop: the
// same flows against whichever backend is selected. Leaves the cast device on 'amp'.
async function streamFlows(backend) {
  const P = PATHS[backend], U = urls(backend), tag = `[${backend}]`;
  await evl(`window.__haCalls = []; deviceEl.value = 'basement-tv'; deviceEl.dispatchEvent(new Event('change')); 'ok'`);

  // --- Stream ---
  hits.length = 0;
  await click('btnPreview');
  check(`${tag} Stream: status shows the video URL`, await evl(`statusEl.textContent === ${JSON.stringify('Streaming: ' + U.video)}`), await evl(`statusEl.textContent`));
  const videoHit = await waitHit(P.video);
  check(`${tag} Stream: backend got the video request`, !!videoHit);
  check(`${tag} Stream: request carries the id and nothing else (no pid)`, videoHit === P.video, videoHit ?? '');
  check(`${tag} Stream: element src points at the backend`, await evl(`video.src === ${JSON.stringify(U.video)}`));
  check(`${tag} Stream: not in audio mode`, await evl(`!document.body.classList.contains('audio-mode')`));

  // --- Listen ---
  hits.length = 0;
  await click('btnListen');
  const audioHit = await waitHit(P.audio);
  check(`${tag} Listen: backend got the audio request`, !!audioHit);
  check(`${tag} Listen: audio request carries the id`, audioHit === P.audio, audioHit ?? '');
  check(`${tag} Listen: element src swapped to audio`, await evl(`video.src === ${JSON.stringify(U.audio)}`));
  check(`${tag} Listen: audio mode on, panel shown`, await evl(`document.body.classList.contains('audio-mode') && !audioPanel.hidden`));
  check(`${tag} Listen: now-playing title is the id`, await evl(`npTitle.textContent === ${JSON.stringify(CID)}`));

  // --- Show video (exit audio mode) ---
  await click('btnExitAudio');
  check(`${tag} Exit audio: class removed, panel hidden`, await evl(`!document.body.classList.contains('audio-mode') && audioPanel.hidden`));
  check(`${tag} Exit audio: media session metadata cleared`, await evl(`!('mediaSession' in navigator) || navigator.mediaSession.metadata === null`));

  // --- Stream again while the audio stream is active (teardown branch) ---
  hits.length = 0;
  await click('btnPreview');
  check(`${tag} Restream: src swapped back to video`, await evl(`video.src === ${JSON.stringify(U.video)}`));
  check(`${tag} Restream: backend hit again`, !!(await waitHit(P.video)));

  // --- Cast ---
  await click('btnCast');
  const castCall = await untilPage(`window.__haCalls[0] ?? null`);
  check(`${tag} Cast: webhook called once`, !!castCall && await evl(`window.__haCalls.length === 1`));
  check(`${tag} Cast: payload is {url, device}, url is the video URL`, !!castCall
    && castCall.body.url === U.video
    && castCall.body.device === 'basement-tv'
    && Object.keys(castCall.body).length === 2,
    JSON.stringify(castCall?.body));
  check(`${tag} Cast: accepted status shown`, await untilPage(`statusEl.textContent.includes('Cast request accepted (basement-tv)')`));

  // --- Cast to an audio-only target ---
  await evl(`deviceEl.value = 'amp'; deviceEl.dispatchEvent(new Event('change')); 'ok'`);
  await click('btnCast');
  const audioCast = await untilPage(`window.__haCalls[1] ?? null`);
  check(`${tag} Cast: audio-only device is sent the audio URL`, !!audioCast
    && audioCast.body.url === U.audio
    && audioCast.body.device === 'amp',
    JSON.stringify(audioCast?.body));

  // --- Stop cast ---
  await click('btnStop');
  const stopCall = await untilPage(`window.__haCalls[2] ?? null`);
  check(`${tag} Stop: payload is {device}`, !!stopCall && stopCall.body.device === 'amp' && Object.keys(stopCall.body).length === 1, JSON.stringify(stopCall?.body));
}

// Switching backends saves the choice and swaps the host field to that backend's own
// saved host and default.
async function selectBackend(value) {
  await evl(`backendEl.value = ${JSON.stringify(value)}; backendEl.dispatchEvent(new Event('change')); 'ok'`);
}

await streamFlows('proxy');

// --- Switch to go-acestream-engine ---
await selectBackend('engine');
check('Backend: choice saved on change', await evl(`localStorage.getItem('backend') === 'engine'`));
check('Backend: engine host starts empty, placeholder is its default',
  await evl(`hostEl.value === '' && hostEl.placeholder === BACKENDS.engine.defaultHost && BACKENDS.engine.defaultHost !== BACKENDS.proxy.defaultHost`),
  await evl(`JSON.stringify([hostEl.value, hostEl.placeholder])`));
// With no host typed the URL goes to the default host; the stub can't answer that, so only
// the URL the page builds is checked, not a request.
check('Backend: an empty host means the engine default',
  await evl(`videoUrl(settings.target()) === 'http://' + BACKENDS.engine.defaultHost + ${JSON.stringify(PATHS.engine.video)}`),
  await evl(`videoUrl(settings.target())`));
await evl(`hostEl.value = '127.0.0.1:${PORT}'; 'ok'`);
await streamFlows('engine');
check('Backend: engine host saved under its own key, proxy host untouched', await evl(`
  localStorage.getItem('goEngineHost') === '127.0.0.1:${PORT}' &&
  localStorage.getItem('engineHost') === '127.0.0.1:${PORT}'
`));

// --- Switching back restores the proxy's host; the engine's survives a different one ---
await selectBackend('proxy');
await evl(`hostEl.value = 'proxy.example:1'; settings.target(); 'ok'`);
await selectBackend('engine');
check('Backend: switching shows the selected backend\'s saved host', await evl(`hostEl.value === '127.0.0.1:${PORT}'`), await evl(`hostEl.value`));
await selectBackend('proxy');
check('Backend: switching back restores the other one', await evl(`hostEl.value === 'proxy.example:1' && hostEl.placeholder === BACKENDS.proxy.defaultHost`), await evl(`hostEl.value`));
await evl(`hostEl.value = '127.0.0.1:${PORT}'; settings.target(); 'ok'`);

// --- Persistence ---
check('Persist: id/host saved', await evl(`
  localStorage.getItem('acestreamId') === ${JSON.stringify(CID)} &&
  localStorage.getItem('engineHost') === '127.0.0.1:${PORT}'
`));
await evl(`deviceEl.value = 'living-room-tv'; deviceEl.dispatchEvent(new Event('change')); 'ok'`);
check('Persist: cast device saved on change', await evl(`localStorage.getItem('castDevice') === 'living-room-tv'`));
await evl(`wakeEl.checked = true; wakeEl.dispatchEvent(new Event('change')); 'ok'`);
check('Persist: keep-screen-on saved on change', await evl(`localStorage.getItem('keepScreenOn') === 'true'`));

// --- Ids a backend would refuse never reach it ---
for (const [label, bad] of [['empty', ''], ['non-hex', 'zz'.repeat(20)], ['39 chars', 'a'.repeat(39)]]) {
  hits.length = 0;
  await evl(`idEl.value = ${JSON.stringify(bad)}; 'ok'`);
  for (const btn of ['btnPreview', 'btnListen', 'btnCast']) {
    await click(btn);
    await sleep(50);
  }
  const want = bad === '' ? 'Enter an AceStream ID first.' : 'AceStream ID must be 40 hex characters.';
  check(`Bad id (${label}): refused with a hint`, await evl(`statusEl.textContent === ${JSON.stringify(want)}`), await evl(`statusEl.textContent`));
  check(`Bad id (${label}): backend and HA not contacted`, hits.length === 0 && await evl(`window.__haCalls.length === 3`), JSON.stringify(hits));
  check(`Bad id (${label}): saved id untouched`, await evl(`localStorage.getItem('acestreamId') === ${JSON.stringify(CID)}`));
}
await evl(`idEl.value = ${JSON.stringify(CID)}; 'ok'`);

// --- Reload restores settings (incl. device select needing options first) ---
await navigate(`http://127.0.0.1:${PORT}/index.html`);
check('Reload: inputs + device + wake + backend restored', await evl(`
  idEl.value === ${JSON.stringify(CID)} && hostEl.value === '127.0.0.1:${PORT}' &&
  deviceEl.value === 'living-room-tv' && wakeEl.checked === true && backendEl.value === 'proxy'
`));
check('Reload: host placeholder is the default proxy host', await evl(`hostEl.placeholder === BACKENDS.proxy.defaultHost && BACKENDS.proxy.defaultHost.length > 0`));
// A saved backend the page no longer knows falls back to the default instead of a blank select.
await evl(`localStorage.setItem('backend', 'gone'); 'ok'`);
await navigate(PAGE_URL);
check('Reload: an unknown saved backend falls back to the proxy', await evl(`backendEl.value === 'proxy' && hostEl.placeholder === BACKENDS.proxy.defaultHost`), await evl(`backendEl.value`));

// --- Wake lock: overlapping triggers take one lock, not one each ---
// A stub whose request resolves late, so the second trigger lands while the first is
// still in flight — the window in which both used to see no lock and both request one.
const wake = await evl(`(async () => {
  wakeEl.checked = false;
  applyWakeLock();
  await wakeLockQueue;
  let requests = 0;
  const stubLock = () => Object.assign(new EventTarget(), { release: async () => {} });
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
    request: () => { requests++; return new Promise(r => setTimeout(() => r(stubLock()), 50)); },
  } });
  wakeEl.checked = true;
  wakeEl.dispatchEvent(new Event('change'));
  document.dispatchEvent(new Event('visibilitychange'));
  await wakeLockQueue;
  const held = wakeLock !== null;
  wakeEl.checked = false;
  applyWakeLock();
  await wakeLockQueue;
  return { requests, held, releasedAfter: wakeLock === null };
})()`);
check('Wake lock: overlapping triggers request one lock', wake.requests === 1 && wake.held, JSON.stringify(wake));
check('Wake lock: unchecking releases it', wake.releasedAfter, JSON.stringify(wake));

// --- A refused stream surfaces as a media error, not silence ---
await evl(`idEl.value = ${JSON.stringify(ERR_CID)}; 'ok'`);
await click('btnPreview');
check('Refused stream: proxy asked', !!(await waitHit(ERR_CID)));
check('Refused stream: reported as refused, not as a play() rejection',
  await untilPage(`statusEl.textContent.startsWith('Stream refused or not playable (')`) && await evl(`statusEl.textContent.includes('proxy log')`),
  await evl(`statusEl.textContent`));
console.log('      status was: ' + await evl(`statusEl.textContent`));
// The same refusal from the engine points at the engine's log.
hits.length = 0;
await selectBackend('engine');
await click('btnPreview');
check('Refused stream: engine asked on its own path', (await waitHit(ERR_CID)) === `/streams/content/${ERR_CID}/video.mp4`, JSON.stringify(hits));
check('Refused stream: engine refusal points at the engine log',
  await untilPage(`statusEl.textContent.startsWith('Stream refused or not playable (') && statusEl.textContent.includes('engine log')`),
  await evl(`statusEl.textContent`));
await selectBackend('proxy');

// --- Open in VLC: offered only on iPhone/iPad ---
check('VLC: button hidden on a desktop browser', await evl(`document.getElementById('btnVlc').hidden`));

// An iPad asking for the desktop site: a Mac user agent with touch points.
await send('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
});
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await navigate(PAGE_URL);
check('VLC: button shown on an iPad', await evl(`!document.getElementById('btnVlc').hidden`));

// The refused id above was saved, so the reload brought it back: a stream that fails here
// is what Safari does to every /video, and the way out it should offer is VLC.
await click('btnPreview');
check('VLC: a failed stream on an iPad points at VLC, not the proxy log',
  await untilPage(`statusEl.textContent.startsWith('Safari cannot play this stream (') && statusEl.textContent.endsWith('try Open in VLC.')`),
  await evl(`statusEl.textContent`));

await evl(`idEl.value = ${JSON.stringify(CID)}; 'ok'`);
const vlcHref = await evl(`vlcUrl(videoUrl(settings.target()))`);
check('VLC: x-callback URL carries the encoded /video URL and a way back',
  vlcHref === 'vlc-x-callback://x-callback-url/stream'
    + `?url=${encodeURIComponent(VIDEO_URL)}&x-success=${encodeURIComponent(PAGE_URL)}`,
  vlcHref);

// Hand-off stops in-page playback first, so the iPad doesn't pull the stream twice. The
// browser has no handler for the scheme, so the page stays put.
hits.length = 0;
await click('btnPreview');
check('VLC: in-page stream started first', await waitHit(`/video?id=${CID}`) === `/video?id=${CID}`);
await click('btnVlc');
check('VLC: in-page playback stopped', await untilPage(`!video.getAttribute('src')`), await evl(`video.src`));
check('VLC: status says where the stream went', await untilPage(`statusEl.textContent.startsWith(${JSON.stringify('Opening in VLC: ' + VIDEO_URL)})`), await evl(`statusEl.textContent`));
// Give a stale play() rejection from the stopped stream time to land; it must not
// overwrite the hand-off message.
await sleep(500);
check('VLC: hand-off status survives the stopped stream', await evl(`statusEl.textContent.startsWith('Opening in VLC: ')`), await evl(`statusEl.textContent`));

// On the engine VLC is handed the engine's video URL.
await selectBackend('engine');
const engineVlc = await evl(`vlcUrl(videoUrl(settings.target()))`);
check('VLC: on the engine the x-callback URL carries the engine video URL',
  engineVlc === 'vlc-x-callback://x-callback-url/stream'
    + `?url=${encodeURIComponent(urls('engine').video)}&x-success=${encodeURIComponent(PAGE_URL)}`,
  engineVlc);
await selectBackend('proxy');
await send('Emulation.setTouchEmulationEnabled', { enabled: false });

const realErrors = pageErrors.filter(t => !/MediaError/i.test(t));
check('No unexpected page exceptions', realErrors.length === 0, JSON.stringify(realErrors));

// ---- teardown ------------------------------------------------------------------

const exited = new Promise(r => browser.once('exit', r));
killBrowser('SIGTERM');
if (!(await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]))) {
  killBrowser('SIGKILL');
  await exited;
}
for (const s of sockets) s.destroy();
stub.close();
// Helper processes can outlive the main one by a moment and recreate directories
// under the profile while it is being removed; keep going until it is really gone.
const gone = await until(() => {
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  return !existsSync(profileDir);
}, 10000, 200);
if (!gone) console.log(`(left ${profileDir} behind)`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
