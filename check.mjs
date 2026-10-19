// Runs the Reluduali panel OUTSIDE Lumit: in headless Chrome, against a
// pretend Lumit and a real Demo Database server on this PC. Lumit itself can
// only be checked by a person (lumit/README.md, "What has not been tried");
// this is everything short of that.
//
//   node lumit/check.mjs
//
// The pretend Lumit gives the page `window.lumit` before the page's own
// scripts run, as Lumit does, and answers its calls from OUTSIDE the page, as
// Lumit does: the page posts a message, this script makes the request. It
// lets net.fetch reach https://reluduali.com only, and sends those requests
// to the local server instead. It keeps every request, and the check fails if
// the panel sent anything that is not on this file's own list below, which
// is written from the README's list, not from the panel's code.
//
// Needs Chrome, and the Demo Database server's code (RELUDUALI_SERVER_REPO,
// the folder that holds it). Nothing touches real data: the server runs on a
// free port with an empty data folder in the system's temp folder. Chrome is
// muted and its window is 1280 wide. Screenshots go to RELUDUALI_SHOTS, if set.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PANEL = join(here, 'reluduali');
const SERVER_REPO = process.env.RELUDUALI_SERVER_REPO || '';
const SHOTS = process.env.RELUDUALI_SHOTS || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- what the panel may send: the README's list, written out again here ----
const ALLOWED = [
  ['POST', /^\/api\/auth\/token$/, ['username', 'password']],
  ['POST', /^\/api\/auth\/logout$/, []],
  ['GET', /^\/api\/auth\/me$/],
  ['GET', /^\/api\/contests$/],
  ['GET', /^\/api\/contests\/invitations$/],
  ['GET', /^\/api\/contests\/[\w-]+\/entry$/],
  ['POST', /^\/api\/contests\/[\w-]+\/enter$/, ['partner']],
  ['POST', /^\/api\/contests\/[\w-]+\/join\/[\w-]+$/, []],
  // 0.2.3: asking a friend after entering on your own, and taking it back; friend requests.
  ['POST', /^\/api\/contests\/[\w-]+\/invite$/, ['partner']],
  ['DELETE', /^\/api\/contests\/[\w-]+\/invite$/, ['partner']],
  // 0.3.0: a snapshot's seal, and the snapshots opened at hand-in.
  ['POST', /^\/api\/timer\/windows\/[\w-]+\/snapshot$/, ['n', 'seal']],
  ['POST', /^\/api\/contests\/[\w-]+\/snapshots$/, ['snapshots']],
  ['GET', /^\/api\/friends$/],
  ['GET', /^\/api\/friends\/requests$/],
  ['POST', /^\/api\/friends$/, ['username']],
  ['POST', /^\/api\/friends\/requests\/[\w-]+\/accept$/, []],
  ['POST', /^\/api\/timer\/windows$/, ['contestId']],
  ['GET', /^\/api\/timer\/windows\/[\w-]+$/],
  ['POST', /^\/api\/timer\/windows\/[\w-]+\/beat$/, ['seq', 'nonce', 'segments', 'signature', 'record']],
  ['POST', /^\/api\/timer\/windows\/[\w-]+\/render$/, ['phase', 'renderId', 'sha256', 'bytes']],
  ['GET', /^\/api\/contests\/[\w-]+\/submission$/],
  ['POST', /^\/api\/contests\/[\w-]+\/submission$/, ['youtube', 'hq', 'hqSha256']],
  ['POST', /^\/api\/contests\/[\w-]+\/edit-record$/, ['windows']],
  ['GET', /^\/api\/contests\/[\w-]+\/share$/],
  ['POST', /^\/api\/contests\/[\w-]+\/share$/, ['link']],
  ['DELETE', /^\/api\/contests\/[\w-]+\/share$/],
  ['POST', /^\/api\/contests\/[\w-]+\/console-code$/, []],
  ['DELETE', /^\/api\/contests\/[\w-]+\/console$/],
];

// Contest 1's rules, as the organizer set them on 2026-10-10: in-game work 0.35×, a
// queued recording 0.1× on top of anything else, both timed by the Console.
const RULES = {
  name: 'Lumit cup',
  budgetMinutes: 480,
  idleMinutes: 1,
  submitBy: Date.now() + 2 * 3600_000,
  categories: [
    { name: 'editing', multiplier: 1, processes: ['lumit.exe'] },
    { name: 'rendering', multiplier: 0.1, countsWhileIdle: true, processes: ['lumit.exe'] },
    { name: 'in-game', multiplier: 0.35, console: 'in-game', processes: ['t6mpv43.exe'] },
    { name: 'queued recording', multiplier: 0.1, console: 'queued', countsWhileIdle: true, processes: ['t6mpv43.exe'] },
  ],
};

/** A pretend Reluduali Console: it links with a code, opens its window and checks in, as the contract says. */
function pretendConsole(serverBase) {
  const c = { pass: null, win: null };
  const call = async (path, body, method = 'POST') => {
    const headers = { 'content-type': 'application/json' };
    if (c.pass) headers.authorization = 'Console ' + c.pass;
    const res = await fetch(serverBase + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
  c.link = async (code) => { const r = await call('/api/console/pair', { code }); if (r.status === 200) c.pass = r.data.token; return r; };
  c.open = async () => { const r = await call('/api/console/windows'); if (r.status === 200) c.win = { ...r.data, last: '' }; return r; };
  c.beat = async (segments) => {
    const w = c.win;
    const seq = w.seq + 1;
    const signature = sign(w.key, w.last, seq, w.nonce, segments);
    const r = await call(`/api/console/windows/${w.id}/beat`, { seq, nonce: w.nonce, segments, signature });
    if (r.status === 200) { w.seq = seq; w.nonce = r.data.nonce; w.last = signature; }
    return r;
  };
  return c;
}
const LINK = 'https://lumitlab.com/join#pretend-key-' + 'x'.repeat(40);
const RENDER_PATH = 'C:\\Contest\\renders\\render 1.mp4';

// ---- results ----------------------------------------------------------------
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  ✓ ' + name);
  } catch (e) {
    results.push({ name, ok: false, why: e.message });
    console.log('  ✗ ' + name + '\n      ' + e.message.split('\n').join('\n      '));
  }
}
function expect(cond, why) { if (!cond) throw new Error(why); }

// ---- ports, processes ----------------------------------------------------------
const BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109,
  110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554,
  556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080]);
async function freePort() {
  for (;;) {
    const port = await new Promise((res, rej) => {
      const s = netServer();
      s.on('error', rej);
      s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
    });
    if (!BAD_PORTS.has(port)) return port;
  }
}
async function killTree(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((res) => child.once('exit', res));
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
  await Promise.race([exited, sleep(5000)]);
}
function processesUsing(text) {
  if (process.platform !== 'win32') return 0;
  // Browsers only: this query's own command line holds the same text, and must not count itself.
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'chrome.exe','msedge.exe','chrome-headless-shell.exe' -and $_.CommandLine -and $_.CommandLine.Contains('${text.replace(/'/g, "''")}') }).Count`], { encoding: 'utf8' });
  return Number(out.trim()) || 0;
}

// ---- the Demo Database server, on a scratch folder ----------------------------
async function startDemoDatabase() {
  const entry = join(SERVER_REPO, 'server', 'index.mjs');
  if (!existsSync(entry)) throw new Error(`no Demo Database server at ${entry}: set RELUDUALI_SERVER_REPO`);
  const data = mkdtempSync(join(tmpdir(), 'reluduali-lumit-check-'));
  const port = await freePort();
  // DEMODB_TRUST_PROXY: each pretend person signs up from an address of their own (account() below), since the
  // server lets five accounts a hour come from one, and this run makes more. The panel's own requests carry none.
  const child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: String(port), DEMODB_DATA: data, DEMODB_TRUST_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/login')).ok) return { base, data, child, log: () => log }; } catch {}
    await sleep(120);
  }
  await killTree(child);
  throw new Error('the Demo Database server never came up\n' + log);
}

let accounts = 0;
async function account(base, username) {
  const password = 'test-password-' + username;
  accounts++;
  const r = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.0.' + accounts }, body: JSON.stringify({ username, password }) });
  if (!r.ok) throw new Error(`could not make ${username}: ${await r.text()}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const user = await r.json();
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
  return { user, password, call };
}

// ---- the panel's folder, served as Lumit serves it (and a copy without its first line) ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
async function servePanel() {
  const port = await freePort();
  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = url.pathname;
    const noCsp = p.startsWith('/nocsp/');
    if (noCsp) p = p.slice('/nocsp'.length);
    const file = normalize(join(PANEL, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PANEL) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    let body = readFileSync(file);
    if (noCsp && file.endsWith('index.html')) body = Buffer.from(body.toString().replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${port}`, srv };
}

// ---- Chrome, over the DevTools protocol ---------------------------------------
function findChrome() {
  return [process.env.RELUDUALI_TEST_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
    .filter(Boolean).find((p) => existsSync(p)) || null;
}

async function launchChrome() {
  const exe = findChrome();
  if (!exe) throw new Error('no Chrome found: set RELUDUALI_TEST_CHROME');
  const profile = mkdtempSync(join(tmpdir(), 'reluduali-lumit-chrome-'));
  const port = await freePort();
  const child = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1280,800',
    '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,MediaRouter', 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
    if (!target) await sleep(150);
  }
  if (!target) { await killTree(child); throw new Error('Chrome never came up'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let next = 1;
  const pending = new Map();
  const handlers = new Map();
  const errors = [];
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result);
      return;
    }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    const h = handlers.get(d.method);
    if (h) h(d.params);
  });
  const send = (method, params = {}) => {
    const id = next++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  const page = {
    send, errors, profile,
    on: (method, fn) => handlers.set(method, fn),
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
      return r.result.value;
    },
    async waitFor(expression, timeout = 15000, what = expression) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try { if (await page.eval(expression)) return; } catch {}
        await sleep(100);
      }
      throw new Error('timed out waiting for: ' + what);
    },
    async goto(url) {
      await send('Page.navigate', { url });
      await page.waitFor(`document.readyState === 'complete'`);
    },
    async click(selector) {
      const p = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.offsetParent === null) return null;
        el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!p) throw new Error('nothing visible to click: ' + selector);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      }
      await sleep(120);
    },
    async clickText(selector, text) {
      const p = await page.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent !== null && e.textContent.trim().startsWith(${JSON.stringify(text)}));
        if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!p) throw new Error(`nothing visible to click: ${selector} "${text}"`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      }
      await sleep(120);
    },
    /** A press with something happening while the button is held down: `during` runs between press and release. */
    async pressText(selector, text, during) {
      const p = await page.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent !== null && e.textContent.trim().startsWith(${JSON.stringify(text)}));
        if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!p) throw new Error(`nothing visible to press: ${selector} "${text}"`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
      await during();
      await sleep(150);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(120);
    },
    async type(selector, text) {
      await page.click(selector);
      await page.eval(`document.querySelector(${JSON.stringify(selector)}).value = ''`);
      await send('Input.insertText', { text });
    },
    size: (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
    async shot(name) {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
    },
    async close() {
      try { ws.close(); } catch {}
      await killTree(child);
      for (let i = 0; i < 8; i++) { try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); } }
    },
  };
  await send('Runtime.enable');
  await send('Page.enable');
  return page;
}

// ---- the manifest, read by Lumit's rules (the creator's brief, "The folder"; checked against
// Lumit 0.7.0's own crates/lumit-extensions/src/lib.rs on 2026-10-14: the same rules) ----------
const PERMISSIONS = ['project', 'activity', 'export', 'import', 'share'];
/** Which permission each call needs; the brief's API table. Calls under '' need none. */
const NEEDS = {
  'app.info': '', 'app.notice': '', 'app.status': '', 'app.openExternal': '', 'net.fetch': '',
  'project.info': 'project', 'project.summary': 'project',
  'export.state': 'export', 'export.fingerprint': 'export',
  'import.files': 'import', 'import.watch': 'import', 'import.unwatch': 'import',
  'share.state': 'share', 'share.link': 'share', 'share.start': 'share', 'share.join': 'share', 'share.stop': 'share',
};
function readManifest() {
  const path = join(PANEL, 'extension.json');
  if (!existsSync(path)) throw new Error('no extension.json: Lumit could not install this folder');
  const bytes = readFileSync(path);
  // PowerShell 5.1's "Set-Content -Encoding utf8" puts one at the front, invisibly; a JSON reader refuses it.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('extension.json starts with a byte-order mark: save it as UTF-8 without one');
  const m = JSON.parse(bytes.toString('utf8'));
  const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  expect(m.format === 1, 'format must be 1');
  expect(typeof m.id === 'string' && /^[a-z0-9-]{1,64}$/.test(m.id), 'id: lower-case letters, digits and hyphens, 1 to 64');
  expect(text(m.name, 64), 'name: required, at most 64');
  expect(text(m.version, 32), 'version: required, at most 32');
  for (const [k, max] of [['summary', 300], ['author', 64], ['homepage', 200]]) expect(m[k] === undefined || text(m[k], max), `${k}: at most ${max}`);
  // Extensions came in Lumit 0.7.0 (12 Oct 2026), but there a partner's edits in a shared project fire
  // activity.edit on both PCs, so a team was charged twice. 0.7.1 (Lumi's #319, 15 Oct) reports only
  // this PC's own edits, and adds app.status and the project id: the panel needs 0.7.1.
  const version = (v) => { const p = String(v).trim().split(/[.+-]/); return [Number(p[0]), Number(p[1]), Number(p[2] || 0)]; };
  expect(m.requires === undefined || (/^\d+\.\d+(\.\d+)?$/.test(m.requires) && version(m.requires).join('.') === '0.7.1'), `requires: 0.7.1, the first Lumit that counts only this PC's own edits (it is ${m.requires})`);
  expect(typeof m.entry === 'string' && !/[\\:]/.test(m.entry) && existsSync(normalize(join(PANEL, m.entry))) && normalize(join(PANEL, m.entry)).startsWith(PANEL), 'entry: a page inside the folder');
  expect(Array.isArray(m.permissions) && m.permissions.every((p) => PERMISSIONS.includes(p)), 'permissions: an unknown word makes the manifest unreadable');
  expect(Array.isArray(m.hosts) && m.hosts.length <= 16 && m.hosts.every((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)), 'hosts: up to 16 bare site names');
  return m;
}
const onHosts = (hostname, hosts) => hosts.some((h) => hostname === h || hostname.endsWith('.' + h));

// ---- the pretend Lumit -----------------------------------------------------------
// The page side: window.lumit with call() and on(). call() posts to the
// binding, as Lumit's page posts to WebView2; nothing in here can reach the
// network, and the page's own rules (its first line) still apply to it.
const PAGE_SIDE = `(() => {
  const pending = new Map(); let next = 1; const listeners = new Map();
  window.__lumitReply = (id, ok, payload) => { const p = pending.get(id); if (!p) return; pending.delete(id);
    if (ok) p.res(payload); else { const e = new Error(payload.message); e.code = payload.code; p.rej(e); } };
  window.__lumitEmit = (event, data) => { for (const fn of listeners.get(event) || []) { try { fn(data); } catch (e) { console.error(e); } } };
  const lumit = {
    call(method, params) { const id = next++; return new Promise((res, rej) => { pending.set(id, { res, rej }); window.__lumitHost(JSON.stringify({ id, method, params: params ?? null })); }); },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); return () => listeners.get(event).delete(fn); },
  };
  Object.defineProperty(window, 'lumit', { value: Object.freeze(lumit) });
})();`;

function pretendLumit(page, serverBase, manifest) {
  const host = {
    // A new project, never saved: Lumit 0.7.1 gives it an id all the same.
    project: { open: true, name: null, id: 'p-contest', saved: false, dirty: true },
    lumitVersion: '0.7.1',
    status: null,
    statusCalls: 0,
    share: { role: 'none', away: false, open: false, people: [] },
    exportState: { state: 'idle' },
    lastExport: null,
    picked: null,
    requests: [],
    notices: [],
    shareCalls: [],
    opened: [],
  };
  const refuse = (code, message) => ({ ok: false, payload: { code, message } });
  async function answer(method, params) {
    // As Lumit does: a call the manifest did not ask permission for is refused.
    if (!(method in NEEDS)) return refuse('unknown-method', method);
    if (method === 'app.status' && host.lumitVersion === '0.7.0') { host.statusCalls++; return refuse('unknown-method', 'Lumit has no app.status'); }
    if (NEEDS[method] && !manifest.permissions.includes(NEEDS[method])) return refuse('not-allowed', `the manifest did not ask for '${NEEDS[method]}'`);
    switch (method) {
      case 'app.info': return { ok: true, payload: { api: 1, lumit: host.lumitVersion + ' (pretend)', extension: { id: manifest.id, version: manifest.version }, permissions: manifest.permissions, hosts: manifest.hosts } };
      case 'app.notice': host.notices.push(params?.text); return { ok: true, payload: null };
      case 'app.status': {
        host.statusCalls++;
        const t = params ? params.text : null;
        if (t !== null && t !== undefined && typeof t !== 'string') return refuse('bad-params', 'text is not a string');
        host.status = t || null;
        return { ok: true, payload: null };
      }
      case 'app.openExternal': {
        const u = new URL(params?.url);
        if (u.protocol !== 'https:' || !onHosts(u.hostname, manifest.hosts)) return refuse('not-allowed', 'not one of its hosts');
        host.opened.push(params.url);
        return { ok: true, payload: null };
      }
      case 'net.fetch': {
        let u;
        try { u = new URL(params?.url); } catch { return refuse('bad-params', 'no url'); }
        if (u.protocol !== 'https:' || !onHosts(u.hostname, manifest.hosts)) return refuse('not-allowed', 'not one of its hosts');
        const rec = { method: params.method || 'GET', path: u.pathname, search: u.search, headers: params.headers || {}, body: params.body ?? null };
        host.requests.push(rec);
        if (host.offlineUntil && Date.now() < host.offlineUntil) return refuse('failed', 'the site could not be reached');
        try {
          const res = await fetch(serverBase + u.pathname + u.search, { method: params.method || 'GET', headers: params.headers || {}, body: params.body ?? undefined, redirect: 'manual' });
          const body = await res.text();
          rec.answer = res.status;   // for a failing step to say what came back
          if (res.status >= 400) rec.answerBody = body.slice(0, 200);
          // The request arrived, and only its answer is lost on the way back.
          if (host.dropNextBeatAnswer && u.pathname.endsWith('/beat')) { host.dropNextBeatAnswer = false; return refuse('failed', 'the answer was lost'); }
          return { ok: true, payload: { status: res.status, headers: Object.fromEntries(res.headers), body } };
        } catch (e) {
          return refuse('failed', e.message);
        }
      }
      // Lumit 0.7.0 has no project id.
      case 'project.info': return { ok: true, payload: host.lumitVersion === '0.7.0' ? { ...host.project, id: undefined } : host.project };
      case 'export.state': return { ok: true, payload: host.exportState };
      // Lumit has no project.summary yet (asked of its creator, 2026-10-18). A step gives one when it wants Lumit's.
      case 'project.summary': return host.summary ? { ok: true, payload: host.summary } : refuse('unknown-method', method);
      case 'export.fingerprint': return host.lastExport ? { ok: true, payload: host.lastExport } : refuse('failed', 'no export has finished since the panel opened');
      case 'import.watch':
        if (params && params.folder) return params.folder === host.picked ? { ok: true, payload: { folder: params.folder } } : refuse('not-allowed', 'not a folder the person picked');
        host.picked = 'C:\\Contest\\footage';
        return { ok: true, payload: { folder: host.picked } };
      case 'import.unwatch': return { ok: true, payload: null };
      case 'share.state': return { ok: true, payload: host.share };
      case 'share.link': return { ok: true, payload: host.share.role === 'host' ? LINK : null };
      case 'share.start': host.shareCalls.push(['start', params]); return { ok: true, payload: null };
      case 'share.join': host.shareCalls.push(['join', params]); return { ok: true, payload: null };
      case 'share.stop': host.shareCalls.push(['stop']); return { ok: true, payload: null };
      default: return refuse('unknown-method', method);
    }
  }
  page.on('Runtime.bindingCalled', async (p) => {
    if (p.name !== '__lumitHost') return;
    const { id, method, params } = JSON.parse(p.payload);
    const { ok, payload } = await answer(method, params);
    page.send('Runtime.evaluate', { expression: `window.__lumitReply(${id}, ${ok}, ${JSON.stringify(payload)})` }).catch(() => {});
  });
  host.emit = (event, data) => page.eval(`window.__lumitEmit(${JSON.stringify(event)}, ${JSON.stringify(data)})`);
  return host;
}

/** A request as a report may show it: the sign-in token blanked, since a report gets pasted into conversations. */
const shown = (r) => JSON.stringify({ ...r, headers: { ...r.headers, ...(r.headers.authorization ? { authorization: 'Bearer …' } : {}) } });

const sign = (keyHex, previous, seq, nonce, segments) => createHmac('sha256', Buffer.from(keyHex, 'hex'))
  .update(previous + '\n' + `${seq}|${nonce}|` + segments.map((s) => `${s.category}:${s.inFrontMs}:${s.chargedMs}`).join(',')).digest('hex');

// ---- the run --------------------------------------------------------------------
console.log('\nThe Reluduali panel, against a pretend Lumit and a scratch Demo Database server\n');
let manifest;
await step('the folder installs as Lumit reads it: extension.json by Lumit 0.7.0\'s rules, one host, needing 0.7.1', async () => {
  manifest = readManifest();
  expect(JSON.stringify(manifest.hosts) === '["reluduali.com"]', `hosts are ${JSON.stringify(manifest.hosts)}, not reluduali.com alone`);
  const server = readFileSync(join(PANEL, 'server.js'), 'utf8').match(/const SERVER = '(https:\/\/[^']+)'/);
  expect(server && onHosts(new URL(server[1]).hostname, manifest.hosts), 'server.js talks to a site the manifest does not name');
});
if (!manifest) { console.log('\nran 1 of 1 · 0 passed · 1 failed · Lumit would not install this folder'); process.exit(1); }

const db = await startDemoDatabase();
const panel = await servePanel();
const page = await launchChrome();
const profile = page.profile;
const lumit = pretendLumit(page, db.base, manifest);
await page.send('Runtime.addBinding', { name: '__lumitHost' });
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SIDE });
await page.size(1280, 800);
const screen = () => page.eval(`document.getElementById('app').dataset.screen`);
const text = (sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
/** Another project open in Lumit, or this one saved: what project.info answers from now on, and the event. */
const projectIs = async (p) => { lumit.project = p; await lumit.emit('project.changed', p); };

let organizer, alice, bob, dave, erin, fay, contest;

try {
  organizer = await account(db.base, 'organizer');
  alice = await account(db.base, 'alice');
  bob = await account(db.base, 'bob');
  await alice.call('/api/friends', 'POST', { username: 'bob' });
  await bob.call(`/api/friends/requests/${alice.user.id}/accept`, 'POST');
  contest = (await organizer.call('/api/contests', 'POST', RULES)).data;

  await page.goto(`${panel.base}/index.html?beat=2000`);

  await step('it starts at the sign-in, with nothing stored', async () => {
    await page.waitFor(`document.getElementById('app').dataset.screen === 'signin'`);
    await page.shot('1-sign-in');
  });

  await step('the page itself cannot open a connection: only Lumit can', async () => {
    // 'no-cors', so nothing but the page's first line can stop it: another
    // site's rules about who may read its answers do not apply to sending.
    const r = await page.eval(`fetch(${JSON.stringify(db.base + '/api/contests')}, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')`);
    expect(r === 'blocked', `the page reached the server on its own (${r})`);
  });

  await step('a wrong password is refused, and the password field is emptied either way', async () => {
    await page.type('#signin-name', 'alice');
    await page.type('#signin-pass', 'not-the-password');
    await page.click('#signin-go');
    await page.waitFor(`!document.getElementById('signin-error').hidden`, 10000, 'the refusal');
    expect(/wrong username or password/.test(await text('#signin-error')), await text('#signin-error'));
    expect((await page.eval(`document.getElementById('signin-pass').value`)) === '', 'the password stayed in the field');
  });

  await step('signing in keeps a token, never the password', async () => {
    await page.type('#signin-pass', alice.password);
    await page.click('#signin-go');
    await page.waitFor(`document.getElementById('app').dataset.screen === 'contest'`, 15000, 'the contest page');
    const stored = await page.eval(`JSON.stringify(Object.entries(localStorage))`);
    expect(/[0-9a-f]{64}/.test(stored), 'no token stored');
    expect(!stored.includes(alice.password), 'the password was stored');
  });

  await step('choosing the contest shows its rates; entering with a friend invites them, though Lumit\'s focus changes while each button is held down', async () => {
    // In real Lumit (2026-10-14) pressing in the panel moves the focus, and Lumit says
    // so to the page in the middle of the press. A panel that redraws then loses the click: Choose,
    // Enter and Open my window did nothing.
    const focusFlicker = async () => { await lumit.emit('activity.focus', { focused: false }); await lumit.emit('activity.focus', { focused: true }); };
    await page.pressText('#ct-list button', 'Choose', focusFlicker);
    await page.waitFor(`!document.getElementById('ct-detail').hidden`);
    expect(/Editing\s*1\.0×/.test(await text('#ct-rates')), await text('#ct-rates'));
    expect(/lumit|Lumit/.test(await text('#ct-lumit')), 'no word about Lumit');
    await page.clickText('#ct-enter-body button.opt', 'With a friend');
    await page.pressText('#ct-enter-body button', 'Enter', focusFlicker);
    await page.waitFor(`/entered with bob\\. Waiting for them/.test(document.getElementById('ct-enter-body').textContent)`, 10000, 'the waiting invitation');
    const inv = (await bob.call('/api/contests/invitations')).data.find((i) => i.contestId === contest.id);
    expect(inv, 'bob has no invitation');
    expect((await bob.call(`/api/contests/${contest.id}/join/${inv.entryId}`, 'POST')).status === 200, 'bob could not accept');
    await page.shot('2-contest');
  });

  await step('the window opens on a new project never saved, which waits for the first touch; the clock is on Lumit\'s bottom strip', async () => {
    await page.clickText('#ct-enter-body button', 'Open my window');
    await page.waitFor(`document.getElementById('app').dataset.screen === 'overview'`, 10000, 'the timer');
    expect(/The project you edit first is the contest's/.test(await text('#oc-project')), await text('#oc-project'));
    // The contest's own clock, plain time to its close (two hours from the start of this run), above the weighted one.
    expect(/^closes in 1:5\d:\d\d$/.test(await text('#oc-ends')), `the contest's clock says ${JSON.stringify(await text('#oc-ends'))}`);
    // It ticks. Redraws wait up to 1.5 s after a press, so it is given 3 s.
    const ends = await text('#oc-ends');
    for (let i = 0; i < 30 && (await text('#oc-ends')) === ends; i++) await sleep(100);
    expect(await text('#oc-ends') !== ends, "the contest's clock does not tick");
    expect(/AS SOON AS YOU TOUCH, the timer starts/.test(await text('#oc-me .what')), await text('#oc-me .what'));
    for (let i = 0; i < 30 && !/left · AS SOON AS YOU TOUCH/.test(lumit.status || ''); i++) await sleep(100);
    expect(/^8:00:00 left · AS SOON AS YOU TOUCH, the timer starts$/.test(lumit.status || ''), `the bottom strip says ${JSON.stringify(lumit.status)}`);
  });

  await step('editing in Lumit is charged, and the server witnesses it; saving the new project keeps it the contest\'s', async () => {
    await lumit.emit('activity.focus', { focused: true });
    for (let i = 0; i < 6; i++) { await lumit.emit('activity.edit', { step: 'Move', at: Date.now() }); await sleep(400); }
    await page.waitFor(`/Counting: your new project \\(not saved yet\\)/.test(document.getElementById('oc-project').textContent)`, 5000, 'the unsaved project counted');
    const strip = lumit.status || '';
    expect(/^7:5\d:\d\d left · editing at 1\.0×$/.test(strip), `the bottom strip says ${JSON.stringify(strip)}`);
    await sleep(1200);
    expect(lumit.status !== strip, 'the bottom strip did not tick');
    await projectIs({ open: true, name: 'contest edit.lum', id: 'p-contest', saved: true, dirty: false });
    for (let i = 0; i < 6; i++) { await lumit.emit('activity.edit', { step: 'Move', at: Date.now() }); await sleep(400); }
    await page.waitFor(`/Counting: contest edit\\.lum/.test(document.getElementById('oc-project').textContent)`, 5000, 'the saved project counted');
    await page.waitFor(`/check-in/.test(document.getElementById('ow-list').textContent)`, 10000, 'a check-in');
    await sleep(2500);
    const e = (await alice.call(`/api/contests/${contest.id}/entry`)).data;
    expect(e.workedBy.editing >= 4000, `the server counted ${e.workedBy.editing} ms of editing`);
    expect(e.spentBy.editing === e.workedBy.editing, 'editing is charged at 1.0×');
    expect(/Editing in Lumit/.test(await text('#oc-me .what')), await text('#oc-me .what'));
    await page.waitFor(`/Edit record: 12 steps · last fingerprint [0-9a-f]{4} [0-9a-f]{4}…/.test(document.getElementById('ow-record').textContent)`, 10000, 'the edit record on the overview');
    await page.shot('3-overview-editing');
  });

  await step("another project's edits are not counted, nor even noted", async () => {
    await projectIs({ open: true, name: 'something else.lum', id: 'p-other', saved: true, dirty: false });
    await sleep(4500); // two check-ins, so what came before has been reported
    const before = (await alice.call(`/api/contests/${contest.id}/entry`)).data.workedBy.editing;
    for (let i = 0; i < 10; i++) { await lumit.emit('activity.edit', { step: 'Elsewhere', at: Date.now() }); await sleep(400); }
    await sleep(4500);
    const after = (await alice.call(`/api/contests/${contest.id}/entry`)).data.workedBy.editing;
    expect(after === before, `editing went from ${before} to ${after} in another project`);
    expect(/Another project is open/.test(await text('#oc-me .what')), await text('#oc-me .what'));
    expect(/ left · another project is open, not counting$/.test(lumit.status || ''), `the bottom strip says ${JSON.stringify(lumit.status)}`);
    await projectIs({ open: true, name: 'contest edit.lum', id: 'p-contest', saved: true, dirty: false });
  });

  await step('a Save As under a new version\'s name keeps counting, since Lumit\'s project id is followed; a same-named file of another project does not count', async () => {
    // His words to Lumi, 2026-10-16: "if a user version numbers their projects, the id remains so that the timer still counts properly."
    await projectIs({ open: true, name: 'contest edit o2.lum', id: 'p-contest', saved: true, dirty: false });
    await sleep(4500);
    const before = (await alice.call(`/api/contests/${contest.id}/entry`)).data.workedBy.editing;
    for (let i = 0; i < 8; i++) { await lumit.emit('activity.edit', { step: 'Cut', at: Date.now() }); await sleep(400); }
    await sleep(4500);
    const after = (await alice.call(`/api/contests/${contest.id}/entry`)).data.workedBy.editing;
    expect(after > before, `editing stayed at ${before} after the Save As`);
    expect(/Counting: contest edit o2\.lum/.test(await text('#oc-project')), await text('#oc-project'));
    expect(await page.eval(`document.getElementById('oc-fix-project').hidden`), '"Count this project instead" is offered for the same project');
    await projectIs({ open: true, name: 'contest edit o2.lum', id: 'p-impostor', saved: true, dirty: false });
    await page.waitFor(`/Another project is open/.test(document.querySelector('#oc-me .what').textContent)`, 5000, 'the other project with the same name refused');
    await projectIs({ open: true, name: 'contest edit o2.lum', id: 'p-contest', saved: true, dirty: false });
    await page.waitFor(`/Counting: contest edit o2\\.lum/.test(document.getElementById('oc-project').textContent)`, 5000, 'back on the contest project');
  });

  await step("the partner's activity shows: bob's queued recording, from his own Console", async () => {
    const code = (await bob.call(`/api/contests/${contest.id}/console-code`, 'POST')).data.code;
    const bobsConsole = pretendConsole(db.base);
    expect((await bobsConsole.link(code)).status === 200, "bob's Console could not link");
    expect((await bobsConsole.open()).status === 200, "bob's Console could not open its window");
    await sleep(1200);
    const b = await bobsConsole.beat([{ category: 'queued recording', inFrontMs: 1000, chargedMs: 100 }]);
    expect(b.status === 200, JSON.stringify(b.data));
    await page.waitFor(`/bob has a queued recording running/.test(document.querySelector('#oc-partner .what').textContent)`, 10000, "bob's queued recording");
  });

  await step('linking the Console: the panel shows a code, the Console types it in, and both are charged at once', async () => {
    await page.eval(`document.querySelector('.nav[data-go="record"]').click()`);
    await page.click('#rc-link');
    await page.waitFor(`!document.getElementById('rc-code-box').hidden`, 10000, 'the code');
    const code = await text('#rc-code');
    expect(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code), `the code reads "${code}"`);
    await page.shot('10-record-code');
    const mine = pretendConsole(db.base);
    expect((await mine.link(code)).status === 200, 'the Console could not link with the code shown');
    await page.waitFor(`document.getElementById('rc-code-box').hidden && /Linked/.test(document.getElementById('rc-state').textContent)`, 10000, 'the panel seeing the link');
    expect((await mine.open()).status === 200, 'the Console could not open its window');
    const before = (await alice.call(`/api/contests/${contest.id}/entry`)).data.spentBy;
    for (let i = 0; i < 8; i++) { await lumit.emit('activity.edit', { step: 'Slide', at: Date.now() }); await sleep(400); }
    const b = await mine.beat([{ category: 'queued recording', inFrontMs: 3000, chargedMs: 300 }]);
    expect(b.status === 200, JSON.stringify(b.data));
    await page.eval(`document.querySelector('.nav[data-go="overview"]').click()`);
    await page.waitFor(`!document.getElementById('oc-console').hidden && /Queued recording/.test(document.querySelector('#oc-console .what').textContent)`, 10000, 'the Console on the clock');
    await sleep(2500);
    const after = (await alice.call(`/api/contests/${contest.id}/entry`)).data.spentBy;
    expect(after['queued recording'] - before['queued recording'] === 300, `the queue was charged ${after['queued recording'] - before['queued recording']}`);
    expect(after.editing > before.editing, 'and editing was charged in the same moments');
    await page.shot('11-overview-console');
    await page.eval(`document.querySelector('.nav[data-go="record"]').click()`);
    await page.click('#rc-unlink');
    await page.waitFor(`/Not linked yet/.test(document.getElementById('rc-state').textContent)`, 10000, 'unlinked');
    expect((await mine.beat([])).status === 401, 'the Console could still check in after it was unlinked');
  });

  await step('a render is witnessed: its fingerprint and size go to the server, never its name or place', async () => {
    await lumit.emit('export.started', { state: 'running', frame: 0, total: 100 });
    for (let f = 10; f <= 100; f += 10) { await sleep(200); await lumit.emit('export.progress', { state: 'running', frame: f, total: 100 }); }
    await page.eval(`document.querySelector('[data-go="render"]').click()`);
    await page.shot('4-render-running');
    lumit.lastExport = { path: RENDER_PATH, bytes: 1234567, sha256: 'ab'.repeat(32) };
    await lumit.emit('export.finished', { state: 'done', path: RENDER_PATH });
    await page.waitFor(`/abab abab/.test(document.getElementById('rd-list').textContent)`, 10000, 'the render in the list');
    for (const r of lumit.requests) expect(!JSON.stringify(r).includes('render 1.mp4') && !JSON.stringify(r).includes('Contest\\\\'), 'a request carried the file\'s name or place: ' + shown(r));
    await page.shot('5-render-done');
  });

  await step('handing in ties the entry to the witnessed render', async () => {
    await page.eval(`document.querySelector('.nav[data-go="handin"]').click()`);
    await page.type('#hi-yt', 'https://youtu.be/dQw4w9WgXcQ');
    await page.type('#hi-hq', 'https://drive.google.com/file/d/pretend/view');
    await page.click('#hi-go');
    await page.waitFor(`/fingerprint matches a render the server timed/.test(document.getElementById('hi-checks').textContent)`, 10000, 'the witnessed check');
    const s = (await bob.call(`/api/contests/${contest.id}/submission`)).data;
    expect(s.hqSha256 === 'ab'.repeat(32), `handed in ${s.hqSha256}`);
    expect(s.witnessed && s.witnessed.bytes === 1234567, 'not witnessed');
    // The edit record went with it: 12 moves, 8 cuts after the Save As and 8 slides,
    // and not one of the ten steps made in the other project.
    await page.waitFor(`/Your edit record: 28 steps, matching all [0-9]+ fingerprints the server stamped/.test(document.getElementById('hi-checks').textContent)`, 10000, 'the edit record checked');
    const mine = (await alice.call(`/api/contests/${contest.id}/entry`)).data.members.find((m) => m.username === 'alice');
    expect(mine.record && mine.record.ok && mine.record.steps === 28 && mine.record.stamps >= 2, 'the server kept ' + JSON.stringify(mine.record));
    await page.shot('6-hand-in');
  });

  await step('"render and replace" puts the next render in its place', async () => {
    await lumit.emit('export.started', { state: 'running', frame: 0, total: 50 });
    await sleep(300);
    lumit.lastExport = { path: 'C:\\Contest\\renders\\render 2.mp4', bytes: 2222, sha256: 'cd'.repeat(32) };
    await lumit.emit('export.finished', { state: 'done', path: lumit.lastExport.path });
    await sleep(1500);
    const s = (await alice.call(`/api/contests/${contest.id}/submission`)).data;
    expect(s.hqSha256 === 'cd'.repeat(32), `still ${s.hqSha256}`);
    expect(s.youtube === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'the YouTube link changed');
  });

  await step('sharing the project hands the invite link to bob, and only through the server', async () => {
    await page.eval(`document.querySelector('.nav[data-go="partner"]').click()`);
    await page.clickText('#pt-actions button', 'Share this project');
    expect(lumit.shareCalls.some(([c]) => c === 'start'), 'Lumit was not asked to open its Share window');
    // The person presses Start sharing in Lumit's own window.
    lumit.share = { role: 'host', away: false, open: true, people: [{ id: 0, name: 'alice', me: true }] };
    await lumit.emit('share.changed', lumit.share);
    await sleep(1500);
    const got = await bob.call(`/api/contests/${contest.id}/share`);
    expect(got.status === 200 && got.data.link === LINK, `bob got ${got.status} ${JSON.stringify(got.data)}`);
    await page.shot('7-partner-hosting');
    lumit.share = { role: 'none', away: false, open: false, people: [] };
    await lumit.emit('share.changed', lumit.share);
    await sleep(1500);
    expect((await bob.call(`/api/contests/${contest.id}/share`)).status === 404, 'the link stayed after sharing stopped');
  });

  await step('docked small, it is the timer: no menu down the side', async () => {
    await page.size(300, 560);
    await page.eval(`document.querySelector('[data-go="overview"]').click()`);
    await sleep(400);
    const layout = await page.eval(`({ side: getComputedStyle(document.querySelector('.side')).display, quick: getComputedStyle(document.querySelector('.quick')).display, wide: document.documentElement.scrollWidth })`);
    expect(layout.side === 'none' && layout.quick === 'flex', JSON.stringify(layout));
    expect(layout.wide <= 300, `wider than the panel: ${layout.wide} px`);
    await page.shot('8-docked');
    await page.size(1280, 800);
  });

  await step('closed and opened again, the panel signs itself in and opens a new window', async () => {
    const before = (await alice.call(`/api/contests/${contest.id}/entry`)).data;
    await page.goto(`${panel.base}/index.html?beat=2000`);
    await page.waitFor(`document.getElementById('app').dataset.screen === 'overview' && /window opened again/.test(document.getElementById('oc-project').textContent)`, 15000, 'the reopened window');
    const after = (await alice.call(`/api/contests/${contest.id}/entry`)).data;
    expect(after.chargedMs >= before.chargedMs, 'time was lost from the entry');
  });

  await step('offline, it says the time is not witnessed, and carries on when the server is back', async () => {
    await lumit.emit('activity.edit', { step: 'Cut', at: Date.now() });
    lumit.offlineUntil = Date.now() + 5000;
    await page.waitFor(`/Not reaching the server/.test(document.getElementById('oc-witness').textContent)`, 10000, 'the offline line');
    await page.shot('9-offline');
    await page.waitFor(`/Witnessed by the server/.test(document.getElementById('oc-witness').textContent)`, 15000, 'back online');
  });

  await step('a check-in whose answer is lost: it opens a new window and timing carries on', async () => {
    const before = (await alice.call(`/api/contests/${contest.id}/entry`)).data.chargedMs;
    lumit.dropNextBeatAnswer = true;
    for (let i = 0; i < 20; i++) { await lumit.emit('activity.edit', { step: 'Trim', at: Date.now() }); await sleep(400); }
    await page.waitFor(`/opened again/.test(document.getElementById('ow-list').textContent)`, 15000, 'the window opened again');
    await sleep(4500);
    const after = (await alice.call(`/api/contests/${contest.id}/entry`)).data.chargedMs;
    expect(after > before, `charged stayed at ${before}`);
  });

  await step('another timer takes over: it stops, says so, and sends no more check-ins', async () => {
    const opened = await alice.call('/api/timer/windows', 'POST', { contestId: contest.id });
    expect(opened.status === 200, 'could not open the other window');
    await page.waitFor(`/Another timer took over/.test(document.querySelector('#oc-me .what').textContent)`, 10000, 'the stop');
    const n = lumit.requests.filter((r) => r.path.endsWith('/beat')).length;
    await sleep(5000);
    expect(lumit.requests.filter((r) => r.path.endsWith('/beat')).length === n, 'it kept checking in');
  });

  // 2026-10-17, his test on two PCs: a partner who had signed in before the invitation never saw it, and a contest
  // made after signing in never showed, until the panel signed in again.
  await step('a contest and an invitation made after signing in show without signing in again: on opening the Contest screen, and on Refresh', async () => {
    const later = (await organizer.call('/api/contests', 'POST', { ...RULES, name: 'Later cup' })).data;
    expect(later && later.id, 'the organizer could not make Later cup');
    await page.eval(`document.querySelector('.nav[data-go="overview"]').click()`);
    await sleep(300);
    await page.eval(`document.querySelector('.nav[data-go="contest"]').click()`);
    await page.waitFor(`[...document.querySelectorAll('#ct-list li')].some((li) => li.textContent.includes('Later cup'))`, 5000, 'Later cup in the list on opening the Contest screen');
    const asked = await bob.call(`/api/contests/${later.id}/enter`, 'POST', { partner: 'alice' });
    expect(asked.status === 200, 'bob could not invite alice: ' + JSON.stringify(asked.data));
    expect(!/invited you/.test(await text('#ct-list')), 'the invitation showed before anything was read again');
    await page.click('#ct-refresh');
    await page.waitFor(`[...document.querySelectorAll('#ct-list li')].some((li) => li.textContent.includes('Later cup') && /bob invited you to edit this one together/.test(li.textContent))`, 5000, "bob's invitation after Refresh");
    expect(await text('#ct-refresh') === 'Refresh', 'the button did not come back');
  });

  await step('in Lumit 0.7.0, which has no app.status and no project id, the panel still runs and asks for the bottom strip once', async () => {
    lumit.lumitVersion = '0.7.0';
    lumit.statusCalls = 0;
    await page.goto(`${panel.base}/index.html?beat=2000`);
    await page.waitFor(`document.getElementById('app').dataset.screen === 'overview'`, 15000, 'the overview');
    // A window open, so the line would change every second if the panel kept asking.
    if (!(await page.eval(`document.getElementById('oc-open').hidden`))) await page.click('#oc-open');
    await page.waitFor(`/Counting: contest edit o2\\.lum/.test(document.getElementById('oc-project').textContent)`, 10000, 'the project known by its name alone');
    await lumit.emit('activity.edit', { step: 'Trim', at: Date.now() });
    await page.waitFor(`/Editing in Lumit/.test(document.querySelector('#oc-me .what').textContent)`, 5000, 'editing counted by the name');
    await sleep(3500);
    expect(lumit.statusCalls === 1, `app.status was asked ${lumit.statusCalls} times`);
    lumit.lumitVersion = '0.7.1';
  });

  await step('a timed contest (a 3HC): no window before it opens; then its own clock is the big one, and the weighted one small', async () => {
    // The organizer, 2026-10-16: "a 3HC (Static Timer)", with the weighted timer "muted (in tone, color and size)".
    const opensAt = Date.now() + 6000;
    const timed = (await organizer.call('/api/contests', 'POST', { ...RULES, name: 'Timed cup', budgetMinutes: 180, staticClock: true,
      opensAt: new Date(opensAt).toISOString(), submitBy: new Date(opensAt + 3600_000).toISOString() })).data;
    expect(timed && timed.staticClock === true, 'the server did not keep the timed contest: ' + JSON.stringify(timed));
    expect((await alice.call(`/api/contests/${timed.id}/enter`, 'POST', {})).status === 200, 'alice could not enter');
    await page.goto(`${panel.base}/index.html?beat=2000`);
    await page.waitFor(`['overview', 'contest'].includes(document.getElementById('app').dataset.screen)`, 15000, 'the panel');
    await page.eval(`document.querySelector('.nav[data-go="contest"]').click()`);
    await page.waitFor(`[...document.querySelectorAll('#ct-list li')].some((li) => li.textContent.includes('Timed cup'))`, 10000, 'the timed contest in the list');
    await page.eval(`[...document.querySelectorAll('#ct-list li')].find((li) => li.textContent.includes('Timed cup')).querySelector('button').click()`);
    await page.waitFor(`/The contest opens/.test(document.getElementById('ct-enter-body').textContent)`, 10000, 'the wait for the opening');
    expect(!/Open my window/.test(await text('#ct-enter-body')), 'Open my window is offered before the contest opens');
    await page.eval(`document.querySelector('.nav[data-go="overview"]').click()`);
    await page.waitFor(`/until it opens/.test(document.getElementById('oc-of').textContent)`, 5000, 'the big clock counting to the opening');
    expect(/^0:00:0\d$/.test(await text('#oc-clock')), `the big clock says ${await text('#oc-clock')}`);
    await sleep(Math.max(0, opensAt - Date.now() + 300));
    await page.waitFor(`!document.getElementById('oc-open').hidden`, 5000, 'Open my window once it opens');
    await page.click('#oc-open');
    await page.waitFor(`/left in the contest/.test(document.getElementById('oc-of').textContent)`, 10000, 'the contest clock running');
    expect(/^0:59:5\d$/.test(await text('#oc-clock')), `the big clock says ${await text('#oc-clock')}`);
    expect(/^weighted 3:00:00 of 3:00:00$/.test(await text('#oc-ends')), `the small clock says ${await text('#oc-ends')}`);
    expect(await page.eval(`document.getElementById('clockcard').classList.contains('timed')`), 'the clock card is not marked timed');
    for (let i = 0; i < 30 && !/left in the contest/.test(lumit.status || ''); i++) await sleep(100);
    expect(/^0:59:5\d left in the contest · /.test(lumit.status || ''), `the bottom strip says ${JSON.stringify(lumit.status)}`);
  });

  // 2026-10-18, the organizer: "I couldnt join my partner after I had started so I essentially had to make a entirely new
  // Reluduali account and then make sure friend was added on the website before I logged into the panel."
  await step("entered on your own, a friend's invitation still shows; joining says what it does, asks once more, and the time used joins the team's", async () => {
    const cup = (await organizer.call('/api/contests', 'POST', { ...RULES, name: 'Join cup' })).data;
    expect(cup && cup.id, 'the organizer could not make Join cup');
    dave = await account(db.base, 'dave');
    await dave.call('/api/friends', 'POST', { username: 'alice' });
    await alice.call(`/api/friends/requests/${dave.user.id}/accept`, 'POST');
    await page.eval(`document.querySelector('.nav[data-go="contest"]').click()`);
    await page.waitFor(`[...document.querySelectorAll('#ct-list li')].some((li) => li.textContent.includes('Join cup'))`, 5000, 'Join cup in the list');
    await page.eval(`[...document.querySelectorAll('#ct-list li')].find((li) => li.textContent.includes('Join cup')).querySelector('button').click()`);
    await page.waitFor(`/On my own/.test(document.getElementById('ct-enter-body').textContent)`, 10000, 'the choice of how to enter');
    await page.clickText('#ct-enter-body button', 'Enter');
    await page.waitFor(`/Open my window/.test(document.getElementById('ct-enter-body').textContent)`, 10000, 'entered alone');
    await page.clickText('#ct-enter-body button', 'Open my window');
    await page.waitFor(`document.getElementById('app').dataset.screen === 'overview'`, 10000, 'the timer');
    await lumit.emit('activity.focus', { focused: true });
    for (let i = 0; i < 8; i++) { await lumit.emit('activity.edit', { step: 'Cut', at: Date.now() }); await sleep(400); }
    await sleep(2500);
    const alone = (await alice.call(`/api/contests/${cup.id}/entry`)).data;
    expect(alone.members.length === 1 && alone.chargedMs > 0, `alone: ${alone.members.length} member(s), ${alone.chargedMs} ms charged`);
    // Dave asks her now. Before 0.2.3 she never saw it, and the server would not have let her say yes.
    const asked = await dave.call(`/api/contests/${cup.id}/enter`, 'POST', { partner: 'alice' });
    expect(asked.status === 200, 'dave could not ask alice, who had entered alone: ' + JSON.stringify(asked.data));
    await page.eval(`document.querySelector('.nav[data-go="contest"]').click()`);
    await page.waitFor(`/dave invited you to edit this contest together\\. You entered on your own/.test(document.getElementById('ct-enter-body').textContent)`, 10000, "dave's invitation, though alice has entered");
    const offer = await text('#ct-enter-body');
    expect(/The \d:\d\d:\d\d of contest time you have used so far joins the team's/.test(offer), offer);
    expect(/Your window closes and opens again at once/.test(offer), offer);
    await page.shot('12-join-offer');
    const before = (await alice.call(`/api/contests/${cup.id}/entry`)).data.chargedMs;
    await page.clickText('#ct-enter-body button', 'Join dave');
    await page.waitFor(`[...document.querySelectorAll('#ct-enter-body button')].some((b) => b.textContent === 'Yes, join dave')`, 5000, 'the second press');
    expect((await alice.call(`/api/contests/${cup.id}/entry`)).data.members.length === 1, 'it joined on the first press');
    await page.clickText('#ct-enter-body button', 'Yes, join dave');
    await page.waitFor(`/Joined\\. The \\d:\\d\\d:\\d\\d you had used joins the team's time/.test(document.getElementById('ct-enter-body').textContent)`, 10000, 'what joined, in words');
    const team = (await dave.call(`/api/contests/${cup.id}/entry`)).data;
    expect(JSON.stringify(team.members.map((m) => [m.username, m.accepted])) === '[["dave",true],["alice",true]]', 'the team is ' + JSON.stringify(team.members.map((m) => [m.username, m.accepted])));
    expect(team.chargedMs >= before && team.workedBy.editing >= alone.workedBy.editing, `the team has ${team.chargedMs} ms, alice had ${before}`);
    expect((await organizer.call('/api/contests')).data.find((c) => c.id === cup.id).entries === 1, 'two entries, not one');
    await page.shot('13-joined');
    // Her window opened again, on the team's entry: its check-ins charge the team.
    for (let i = 0; i < 8; i++) { await lumit.emit('activity.edit', { step: 'Cut', at: Date.now() }); await sleep(400); }
    await sleep(2500);
    const after = (await dave.call(`/api/contests/${cup.id}/entry`)).data;
    expect(after.chargedMs > team.chargedMs, `the team's time stayed at ${team.chargedMs} ms`);
  });

  await step('a friend request from the Partner page, said yes to on reluduali.com, shows without signing out; one sent to you is accepted there', async () => {
    erin = await account(db.base, 'erin');
    fay = await account(db.base, 'fay');
    await page.eval(`document.querySelector('.nav[data-go="partner"]').click()`);
    await page.type('#pt-add-name', 'erin');
    await page.click('#pt-add-go');
    await page.waitFor(`/Friend request sent to erin/.test(document.getElementById('pt-add-note').textContent)`, 10000, 'the request sent');
    expect(/erin\s*asked · waiting/.test(await text('#pt-requests')), await text('#pt-requests'));
    expect((await erin.call('/api/friends/requests')).data.incoming.some((u) => u.username === 'alice'), 'erin has no request from alice');
    expect((await erin.call(`/api/friends/requests/${alice.user.id}/accept`, 'POST')).status === 200, 'erin could not say yes');
    // Opening the Partner page again reads the lists again: no signing out.
    const reopen = async () => {
      await page.eval(`document.querySelector('.nav[data-go="overview"]').click()`);
      await sleep(200);
      await page.eval(`document.querySelector('.nav[data-go="partner"]').click()`);
    };
    await reopen();
    await page.waitFor(`[...document.querySelectorAll('#pt-friends li')].some((li) => li.textContent.includes('erin'))`, 5000, 'erin among the friends');
    await fay.call('/api/friends', 'POST', { username: 'alice' });
    await reopen();
    await page.waitFor(`/fay\\s*wants to be your Reluduali friend/.test(document.getElementById('pt-requests').textContent)`, 5000, "fay's request");
    await page.shot('14-partner-requests');
    await page.clickText('#pt-requests button', 'Accept');
    await page.waitFor(`[...document.querySelectorAll('#pt-friends li')].some((li) => li.textContent.includes('fay'))`, 5000, 'fay among the friends');
    expect((await fay.call('/api/friends')).data.some((u) => u.username === 'alice'), 'fay and alice are not friends on the server');
    expect(/You and fay are friends now/.test(await text('#pt-add-note')), await text('#pt-add-note'));
  });

  await step('a friend asked from the Partner page after entering on your own, and the invitation taken back', async () => {
    const cup = (await organizer.call('/api/contests', 'POST', { ...RULES, name: 'Ask cup' })).data;
    expect((await alice.call(`/api/contests/${cup.id}/enter`, 'POST', {})).status === 200, 'alice could not enter Ask cup');
    await page.eval(`document.querySelector('.nav[data-go="contest"]').click()`);
    await page.waitFor(`[...document.querySelectorAll('#ct-list li')].some((li) => li.textContent.includes('Ask cup'))`, 5000, 'Ask cup in the list');
    await page.eval(`[...document.querySelectorAll('#ct-list li')].find((li) => li.textContent.includes('Ask cup')).querySelector('button').click()`);
    await page.waitFor(`/Open my window/.test(document.getElementById('ct-enter-body').textContent)`, 10000, 'Ask cup chosen, entered');
    await page.eval(`document.querySelector('.nav[data-go="partner"]').click()`);
    await page.waitFor(`/You entered on your own\\. You can still ask a friend/.test(document.getElementById('pt-note').textContent)`, 5000, 'the offer to ask');
    await page.eval(`[...document.querySelectorAll('#pt-friends li')].find((li) => li.textContent.includes('erin')).querySelector('button').click()`);
    await page.waitFor(`/You asked erin/.test(document.getElementById('pt-share-status').textContent)`, 5000, 'erin asked');
    const asked = await alice.call(`/api/contests/${cup.id}/entry`);
    expect(JSON.stringify(asked.data.members.map((m) => [m.username, m.accepted])) === '[["alice",true],["erin",false]]', JSON.stringify(asked.data.members));
    await page.clickText('#pt-actions button', 'Take back the invitation');
    await page.waitFor(`/You entered on your own\\. You can still ask a friend/.test(document.getElementById('pt-note').textContent)`, 5000, 'taken back');
    expect((await alice.call(`/api/contests/${cup.id}/entry`)).data.members.length === 1, 'the invitation is still on the server');
  });

  // 0.3.0 (the organizer, 2026-10-18: "There can be up to 4 People in a Group entering a Contest."): a team of three from the
  // Partner page. Two friends asked at once, one invitation taken back by name, asked again; both say yes on
  // reluduali.com; the Partner page and the clock show the three of them.
  await step('a team of up to four: two friends asked from the Partner page, one taken back by name; both join; the clock shows the team', async () => {
    const cup = (await organizer.call('/api/contests', 'POST', { ...RULES, name: 'Trio cup' })).data;
    expect((await alice.call(`/api/contests/${cup.id}/enter`, 'POST', {})).status === 200, 'alice could not enter Trio cup');
    await page.eval(`document.querySelector('.nav[data-go="contest"]').click()`);
    await page.waitFor(`[...document.querySelectorAll('#ct-list li')].some((li) => li.textContent.includes('Trio cup'))`, 5000, 'Trio cup in the list');
    await page.eval(`[...document.querySelectorAll('#ct-list li')].find((li) => li.textContent.includes('Trio cup')).querySelector('button').click()`);
    // Until the panel has the new contest, the Contest page still shows the last one's words: wait for its name.
    await page.waitFor(`document.getElementById('ct-name').textContent.includes('Trio cup') && /Open my window/.test(document.getElementById('ct-enter-body').textContent)`, 10000, 'Trio cup chosen, entered');
    await page.eval(`document.querySelector('.nav[data-go="partner"]').click()`);
    await page.waitFor(`!document.getElementById('s-partner').hidden && document.getElementById('pt-names').textContent === 'Just you' && /You entered on your own\\. You can still ask a friend/.test(document.getElementById('pt-note').textContent)`, 5000, 'the offer to ask');
    const ask = async (name) => {
      await page.eval(`[...document.querySelectorAll('#pt-friends li')].find((li) => li.textContent.includes(${JSON.stringify(name)})).querySelector('button').click()`);
      try {
        await page.waitFor(`/You asked [^.]*${name}/.test(document.getElementById('pt-share-status').textContent)`, 5000, `${name} asked`);
      } catch (e) {
        throw new Error(`${e.message}; the page says: ${JSON.stringify({ status: await text('#pt-share-status'), note: await text('#pt-note'), error: await text('#pt-error'), names: await text('#pt-names') })}`
          + `; its last requests: ${JSON.stringify(lumit.requests.slice(-4).map((r) => `${r.method} ${r.path} ${r.answer ?? ''} ${r.answerBody ?? ''}`))}`
          + `; the server has: ${JSON.stringify((await alice.call(`/api/contests/${cup.id}/entry`)).data?.members?.map((m) => [m.username, m.accepted]))}`
          + `; the invite sent: ${JSON.stringify(lumit.requests.filter((r) => r.path.endsWith('/invite')).slice(-1).map((r) => r.body))}`
          + `; the screen: ${await page.eval(`document.getElementById('app')?.dataset.screen + ' / partner hidden: ' + document.getElementById('s-partner').hidden`)}`
          + `; page errors: ${JSON.stringify(page.errors.slice(-3))}`);
      }
    };
    await ask('erin');
    await ask('fay');
    expect(/You asked erin and fay\. Until each says yes, you can take their invitation back\./.test(await text('#pt-share-status')), await text('#pt-share-status'));
    expect(/asked, waiting for them to accept: erin and fay · you can ask one more friend/.test(await text('#pt-note')), await text('#pt-note'));
    await page.clickText('#pt-actions button', 'Take back the invitation to fay');
    await page.waitFor(`/You asked erin\. Until they say yes/.test(document.getElementById('pt-share-status').textContent)`, 5000, "fay's invitation taken back");
    const left = await alice.call(`/api/contests/${cup.id}/entry`);
    expect(JSON.stringify(left.data.members.map((m) => [m.username, m.accepted])) === '[["alice",true],["erin",false]]', JSON.stringify(left.data.members));
    await ask('fay');
    for (const [u, name] of [[erin, 'erin'], [fay, 'fay']]) {
      const inv = (await u.call('/api/contests/invitations')).data.find((i) => i.contestId === cup.id);
      expect(inv && inv.from.username === 'alice', `${name} has no invitation from alice`);
      expect((await u.call(`/api/contests/${cup.id}/join/${inv.entryId}`, 'POST')).status === 200, `${name} could not say yes`);
    }
    await page.eval(`document.querySelector('.nav[data-go="overview"]').click()`);
    await sleep(200);
    await page.eval(`document.querySelector('.nav[data-go="partner"]').click()`);
    // Their names show while they are only asked, too: wait until the panel has read that both said yes.
    await page.waitFor(`document.getElementById('pt-names').textContent === 'You, erin and fay' && document.getElementById('pt-note').textContent.startsWith('in your team: erin and fay')`, 5000, 'the three of them');
    expect(/^in your team: erin and fay · you can ask one more friend$/.test(await text('#pt-note')), await text('#pt-note'));
    expect(/All 3 editing/.test(await text('#pt-rates')), await text('#pt-rates'));
    expect(/One of you hosts the project; the others join it/.test(await text('#pt-share-status')), await text('#pt-share-status'));
    await page.shot('15-team-of-three');
    await page.eval(`document.querySelector('.nav[data-go="overview"]').click()`);
    await page.waitFor(`/Trio cup · team of 3/.test(document.getElementById('oc-title').textContent)`, 5000, 'the clock says team of 3');
    expect(await text('#oc-partner .lbl') === 'erin', await text('#oc-partner .lbl'));
    expect(await page.eval(`[...document.querySelectorAll('#oc-team-more .person .lbl')].map((e) => e.textContent).join()`) === 'fay', 'fay is not on the clock');
  });

  // 0.3.0: sealed snapshots at random moments (on reluduali.com's side, docs/contests/SNAPSHOTS.md). A timed contest 50
  // minutes into its 55: every moment, drawn between 10% and 90% of its hours, has come, so the first check-ins ask.
  await step('sealed snapshots: asked on check-ins, sealed with a stand-in and then with Lumit\'s summary, opened at hand-in, all matching', async () => {
    const now = Date.now();
    const cup = (await organizer.call('/api/contests', 'POST', { ...RULES, name: 'Snap cup', staticClock: true, opensAt: now - 50 * 60000, submitBy: now + 5 * 60000 })).data;
    expect(cup && cup.id, 'no Snap cup: ' + JSON.stringify(cup));
    expect((await alice.call(`/api/contests/${cup.id}/enter`, 'POST', {})).status === 200, 'alice could not enter Snap cup');
    lumit.summary = null;       // a Lumit without project.summary: the panel seals its stand-in
    await page.eval(`document.querySelector('.nav[data-go="contest"]').click()`);
    await page.waitFor(`[...document.querySelectorAll('#ct-list li')].some((li) => li.textContent.includes('Snap cup'))`, 5000, 'Snap cup in the list');
    await page.eval(`[...document.querySelectorAll('#ct-list li')].find((li) => li.textContent.includes('Snap cup')).querySelector('button').click()`);
    await page.waitFor(`document.getElementById('ct-name').textContent.includes('Snap cup') && /Open my window/.test(document.getElementById('ct-enter-body').textContent)`, 10000, 'Snap cup chosen, entered');
    await page.clickText('#ct-enter-body button', 'Open my window');
    await page.waitFor(`document.getElementById('app').dataset.screen === 'overview'`, 10000, 'the timer');
    const sealed = async (k) => {
      for (let i = 0; i < 60; i++) {
        const people = (await organizer.call(`/api/contests/${cup.id}/snapshots`)).data.people;
        const a = people.find((x) => x.username === 'alice');
        if (a && a.snapshots.filter((x) => x.sealedAt).length >= k) return a;
        await sleep(500);
      }
      throw new Error(`fewer than ${k} snapshots sealed`);
    };
    await sealed(2);
    lumit.summary = { id: 'proj-1', duration: 42.5, fps: 60, width: 1920, height: 1080, tracks: [{ kind: 'video', clips: 3 }],
      clips: [0, 1, 2].map((i) => ({ track: 0, kind: 'video', start: i * 14, duration: 14, sourceStart: 3, speed: 1, effects: i ? ['Glow'] : [], keyframes: i * 4, media: 0 })),
      media: [{ kind: 'video', duration: 95.2, width: 1920, height: 1080, sha256: 'ef'.repeat(32) }], steps: 30 };
    const three = await sealed(3);
    expect(three.snapshots.map((x) => x.state).join() === 'sealed, not opened,sealed, not opened,sealed, not opened', JSON.stringify(three.snapshots.map((x) => x.state)));
    // Handed in through the panel: the seals are opened with it.
    await page.eval(`document.querySelector('.nav[data-go="handin"]').click()`);
    await page.eval(`document.getElementById('hi-yt').value = ''; document.getElementById('hi-hq').value = ''; 1`);
    await page.type('#hi-yt', 'https://youtu.be/dQw4w9WgXcQ');
    await page.type('#hi-hq', 'https://drive.google.com/file/d/pretend-snap/view');
    await page.click('#hi-go');
    await page.waitFor(`/Your snapshots: 3 of 3 opened and matching their seals/.test(document.getElementById('hi-checks').textContent)`, 15000, 'the snapshots opened');
    const opened = (await organizer.call(`/api/contests/${cup.id}/snapshots`)).data.people.find((x) => x.username === 'alice');
    expect(opened.snapshots.map((x) => x.state).join() === 'matches,matches,matches', JSON.stringify(opened.snapshots.map((x) => x.state)));
    const briefs = opened.snapshots.map((x) => x.summary);
    expect(briefs[0].standIn === true && briefs[1].standIn === true && briefs[2].standIn === false && briefs[2].clips === 3 && briefs[2].effects === 1, JSON.stringify(briefs));
    await page.shot('16-snapshots-opened');
    // The Account page names the version Lumit installed.
    await page.eval(`document.querySelector('.nav[data-go="account"]').click()`);
    await page.waitFor(`document.getElementById('ac-versions').textContent.startsWith(${JSON.stringify('Reluduali panel ' + manifest.version)})`, 5000, 'the installed version');
  });

  await step('everything the panel sent is on the list, to reluduali.com only, with a bearer token and no cookie', async () => {
    expect(lumit.requests.length > 10, `only ${lumit.requests.length} requests`);
    let sentRecord = false;
    for (const r of lumit.requests) {
      const rule = ALLOWED.find(([m, re]) => m === r.method && re.test(r.path));
      expect(rule, `not on the list: ${r.method} ${r.path}`);
      expect(!r.search, `a query string: ${r.method} ${r.path}${r.search}`);
      const keys = r.body ? Object.keys(JSON.parse(r.body)) : [];
      const allowed = rule[2] || [];
      for (const k of keys) expect(allowed.includes(k), `${r.method} ${r.path} carried '${k}'`);
      if (r.path.endsWith('/beat')) for (const s of JSON.parse(r.body).segments) expect(Object.keys(s).sort().join() === 'category,chargedMs,inFrontMs', 'a check-in segment carried more: ' + JSON.stringify(s));
      if (r.path.endsWith('/beat') && JSON.parse(r.body).record) {
        const rec = JSON.parse(r.body).record;
        expect(Object.keys(rec).sort().join() === 'last,steps' && Number.isInteger(rec.steps) && /^[0-9a-f]{64}$/.test(rec.last), "a check-in's record carried more: " + JSON.stringify(rec));
      }
      if (r.path.endsWith('/edit-record')) {
        sentRecord = true;
        for (const w of JSON.parse(r.body).windows) {
          expect(Object.keys(w).sort().join() === 'id,steps', 'a window of the record carried more: ' + Object.keys(w));
          for (const st of w.steps) {
            expect(Array.isArray(st) && st.length === 2 && Number.isInteger(st[0]) && typeof st[1] === 'string', 'a step carried more: ' + JSON.stringify(st));
            expect(['Move', 'Slide', 'Cut', 'Trim'].includes(st[1]), `a step named ${JSON.stringify(st[1])} left the PC`);
          }
        }
      }
      for (const h of Object.keys(r.headers)) expect(['content-type', 'authorization'].includes(h.toLowerCase()), `header ${h}`);
      if (r.headers.authorization) expect(/^Bearer [0-9a-f]{64}$/.test(r.headers.authorization), 'an odd authorization');
      if (!r.path.startsWith('/api/auth/token')) expect(!r.body || !r.body.includes(alice.password), 'the password went somewhere else');
    }
    expect(sentRecord, 'no edit record was sent, so the checks on it saw nothing');
    expect(!lumit.requests.some((r) => (r.body || '').includes('Elsewhere')), "a step from another project left the PC");
  });

  await step('the page threw nothing and logged no error', async () => {
    expect(page.errors.length === 0, page.errors.join('\n'));
  });

  await step('and the check above can fail: without its first line, the page does reach the server', async () => {
    await page.goto(`${panel.base}/nocsp/index.html?beat=2000`);
    const r = await page.eval(`fetch(${JSON.stringify(db.base + '/api/contests')}, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')`);
    expect(r === 'reached', `blocked even without the line (${r}), so the first check proves nothing`);
  });
} catch (e) {
  results.push({ name: 'the run itself', ok: false, why: e.stack || e.message });
  console.log('  ✗ the run stopped: ' + (e.stack || e.message));
} finally {
  await page.close();
  panel.srv.close();
  await killTree(db.child);
  await sleep(300);
  for (let i = 0; i < 8; i++) { try { rmSync(db.data, { recursive: true, force: true }); break; } catch { await sleep(300); } }
}

// A browser that has been killed has not necessarily gone (HORUS XF-0107): wait for it, up to ten seconds.
let left = processesUsing(profile);
for (let i = 0; i < 20 && left; i++) { await sleep(500); left = processesUsing(profile); }
const failed = results.filter((r) => !r.ok);
console.log(`\nran ${results.length} of ${results.length} · ${results.length - failed.length} passed · ${failed.length} failed · ${left} browser processes left`);
if (left) failed.push({ name: 'browser processes left behind' });
process.exit(failed.length ? 1 : 0);
