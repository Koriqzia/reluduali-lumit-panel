// The Lumit panel's clock, with made-up times: what counts, at what rate, and
// the check-in's signature.
//
//   node --test lumit/clock.test.mjs
//
// The signature is computed here from its written recipe with Node's own
// HMAC, not with the panel's code: a test that borrows the code it checks
// agrees with it by construction (HORUS XF-0068).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = { crypto: globalThis.crypto, TextEncoder };
sandbox.globalThis = sandbox;
vm.runInNewContext(readFileSync(join(here, 'reluduali', 'clock.js'), 'utf8'), sandbox);
const { Ledger, lumitCategories, sign, EditRecord, RENDER_STALL_MS } = sandbox.RelClock;

// The example contest's categories, as the Reluduali Timer's contest.json has them.
const RULES = {
  name: 'Example contest',
  budgetMinutes: 480,
  idleMinutes: 3,
  categories: [
    { name: 'recording', multiplier: 0.5, processes: ['t6mpv43.exe', 'Bo2DemoRipper2026.exe'] },
    { name: 'editing', multiplier: 1.0, processes: ['AfterFX.exe', 'vegas*.exe', 'lumit.exe'] },
    { name: 'scripting', multiplier: 1.0, processes: ['python.exe'] },
    { name: 'rendering', multiplier: 0.1, countsWhileIdle: true, processes: ['aerender.exe'] },
  ],
};
const S = 1000;
const MIN = 60 * S;
const T0 = 1_760_000_000_000;

function fresh(rules = RULES) {
  const l = new Ledger(rules);
  l.start(T0);
  l.contestProject(true, T0);
  return l;
}
const total = (l, name) => l.totals.get(name);

test("Lumit's editing is the category that lists lumit.exe; rendering is the one that counts while idle", () => {
  const { editing, rendering } = lumitCategories(RULES);
  assert.equal(editing.name, 'editing');
  assert.equal(rendering.name, 'rendering');
  const upper = lumitCategories({ ...RULES, categories: [{ name: 'cut', multiplier: 1, processes: ['LUMIT.EXE'] }] });
  assert.equal(upper.editing.name, 'cut', 'any case, as Windows names programs');
  const without = lumitCategories({ ...RULES, categories: [{ name: 'editing', multiplier: 1, processes: ['AfterFX.exe'] }] });
  assert.equal(without.editing, null, 'a contest that does not list Lumit does not count it');
  const lumitContest = lumitCategories({ ...RULES, categories: [
    { name: 'queued recording', multiplier: 0.1, countsWhileIdle: true, console: 'queued', processes: ['lumit.exe'] },
    { name: 'editing', multiplier: 1, processes: ['lumit.exe'] },
    { name: 'rendering', multiplier: 0.1, countsWhileIdle: true, processes: ['lumit.exe'] },
  ] });
  assert.equal(lumitContest.rendering.name, 'rendering', "a Console's category is never the panel's, even listed first");
  assert.equal(lumitContest.editing.name, 'editing');
});

test('editing counts from an edit until the idle time runs out, and no further', () => {
  const l = fresh();
  l.edit(T0 + 10 * S);
  l.advance(T0 + 10 * S + 5 * MIN);
  assert.equal(total(l, 'editing').inFront, 3 * MIN, 'three minutes after the last edit, then nothing');
  assert.equal(total(l, 'editing').charged, 3 * MIN);
  assert.equal(l.current(T0 + 10 * S + 5 * MIN).what, 'idle');
});

test('each edit keeps it counting; the time before the first edit is free', () => {
  const l = fresh();
  for (let i = 0; i < 10; i++) l.edit(T0 + MIN + i * 30 * S);
  l.advance(T0 + MIN + 9 * 30 * S + 10 * S);
  assert.equal(total(l, 'editing').inFront, 9 * 30 * S + 10 * S);
});

test('another program in front stops it at once, and Lumit in front again does not restart it without an edit', () => {
  const l = fresh();
  l.edit(T0);
  l.focus(false, T0 + 20 * S);
  l.advance(T0 + 2 * MIN);
  assert.equal(total(l, 'editing').inFront, 20 * S);
  assert.equal(l.current(T0 + 2 * MIN).what, 'background');
  l.focus(true, T0 + 2 * MIN);
  l.advance(T0 + 2 * MIN + 30 * S);
  assert.equal(total(l, 'editing').inFront, 20 * S + 30 * S, 'the last edit was under three minutes ago, so it counts again');
  l.advance(T0 + 10 * MIN);
  assert.equal(total(l, 'editing').inFront, 80 * S, 'until three minutes after that edit: 20 s, 30 s, then 30 s more');
});

test('another project open: nothing counts, and its edits are not noted', () => {
  const l = fresh();
  l.contestProject(false, T0);
  l.edit(T0 + S); // the panel does not even pass these on; if it did, they still would not count
  l.advance(T0 + MIN);
  assert.equal(total(l, 'editing').inFront, 0);
  assert.equal(l.current(T0 + MIN).what, 'not-contest');
});

test('a render counts at its own rate with nobody at the keyboard, and stops when Lumit stops reporting it', () => {
  const l = fresh();
  l.focus(false, T0);
  l.exportStarted(T0);
  for (let s = 1; s <= 60; s++) l.exportProgress(T0 + s * S);
  l.advance(T0 + 60 * S);
  assert.equal(total(l, 'rendering').inFront, 60 * S);
  assert.equal(total(l, 'rendering').charged, 6 * S, '0.1×');
  l.advance(T0 + 10 * MIN); // no word from Lumit: a frozen or sleeping PC
  assert.equal(total(l, 'rendering').inFront, 60 * S + RENDER_STALL_MS);
  l.exportEnded(T0 + 10 * MIN);
  assert.equal(l.current(T0 + 10 * MIN).what, 'background');
});

test('no moment is ever counted twice: an edit during a render counts as rendering', () => {
  const l = fresh();
  l.edit(T0);
  l.exportStarted(T0 + 30 * S);
  l.exportProgress(T0 + 40 * S);
  l.exportEnded(T0 + 50 * S);
  l.advance(T0 + 60 * S);
  const editing = total(l, 'editing').inFront;
  const rendering = total(l, 'rendering').inFront;
  assert.equal(rendering, 20 * S);
  assert.equal(editing, 40 * S);
  assert.equal(editing + rendering, 60 * S, 'together, never more than the time that passed');
});

test('a report stamped before the time already counted counts as now', () => {
  const l = fresh();
  l.advance(T0 + MIN);
  l.edit(T0 + 10 * S); // arrived late
  l.advance(T0 + MIN + 30 * S);
  assert.equal(total(l, 'editing').inFront, 30 * S);
});

test("a check-in reports only what is new, in whole milliseconds, never above a category's rate", () => {
  const rules = { ...RULES, categories: [{ name: 'editing', multiplier: 1 / 3, processes: ['lumit.exe'] }] };
  const l = fresh(rules);
  l.edit(T0);
  l.advance(T0 + 1000);
  const first = l.segments();
  assert.deepEqual(JSON.parse(JSON.stringify(first)), [{ category: 'editing', inFrontMs: 1000, chargedMs: 333 }]);
  assert.equal(l.unsentCharged(), 333);
  l.accepted(first);
  assert.equal(l.segments().length, 0, 'nothing new');
  assert.equal(l.unsentCharged(), 0);
  l.advance(T0 + 2000);
  const second = l.segments();
  assert.equal(second[0].inFrontMs, 1000);
  assert.ok(second[0].chargedMs <= Math.floor(1000 / 3) + 1, 'the server refuses more than the rate allows');
});

test('a check-in that was not accepted is sent again, added to', () => {
  const l = fresh();
  l.edit(T0);
  l.advance(T0 + 10 * S);
  const lost = l.segments();
  l.advance(T0 + 20 * S);
  assert.equal(l.segments()[0].inFrontMs, 20 * S, 'the lost ten seconds and ten more');
  assert.equal(lost[0].inFrontMs, 10 * S);
});

test('a window opened again carries on from where things stood, not with the old time', () => {
  const old = fresh();
  old.edit(T0);
  old.exportStarted(T0 + S);
  old.advance(T0 + 2 * S);
  const next = new Ledger(RULES);
  next.start(T0 + 2 * S);
  next.carryOn(old);
  next.exportProgress(T0 + 3 * S);
  next.advance(T0 + 4 * S);
  assert.equal(total(next, 'rendering').inFront, 2 * S, 'the export still running counts in the new window');
  assert.equal(total(next, 'editing').inFront, 0);
});

test("the check-in's signature is the recipe the server checks", async () => {
  const key = 'ab'.repeat(32);
  const cases = [
    ['', 1, 'f00d', []],
    ['', 1, 'n0nce', [{ category: 'editing', inFrontMs: 59000, chargedMs: 59000 }, { category: 'rendering', inFrontMs: 1000, chargedMs: 100 }]],
    ['9'.repeat(64), 7, 'beef', [{ category: 'scripting', inFrontMs: 1, chargedMs: 1 }]],
  ];
  for (const [previous, seq, nonce, segments] of cases) {
    const text = `${seq}|${nonce}|` + segments.map((s) => `${s.category}:${s.inFrontMs}:${s.chargedMs}`).join(',');
    const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(previous + '\n' + text).digest('hex');
    assert.equal(await sign(key, previous, seq, nonce, segments), expected);
  }
});

test('a check-in that carries the edit record signs it with the rest', async () => {
  const key = 'cd'.repeat(32);
  const record = { steps: 12, last: 'e'.repeat(64) };
  const segments = [{ category: 'editing', inFrontMs: 60000, chargedMs: 60000 }];
  const text = '3|n0nce|editing:60000:60000|record:12:' + 'e'.repeat(64);
  const expected = createHmac('sha256', Buffer.from(key, 'hex')).update('prev\n' + text).digest('hex');
  assert.equal(await sign(key, 'prev', 3, 'n0nce', segments, record), expected);
  assert.notEqual(await sign(key, 'prev', 3, 'n0nce', segments), expected, 'without the record it is another signature');
});

// The edit record's recipe, written out from lumit/README.md with Node's own SHA-256.
const sha = (t) => createHash('sha256').update(t).digest('hex');
function chain(windowId, steps) {
  let last = sha('reluduali edit record\n' + windowId);
  steps.forEach(([at, name], i) => { last = sha(`${last}\n${i + 1}|${at}|${name}`); });
  return last;
}

test('the edit record chains each step to the one before, from its window', async () => {
  const steps = [[1000, 'Add layer'], [1900, 'Set keyframe'], [2500, 'Trim | clip'], [9000, 'Ünïcode step']];
  const r = new EditRecord('win-1', []);
  const empty = await r.state(); // from the sandbox's realm: compared field by field
  assert.equal(empty.steps, 0);
  assert.equal(empty.last, chain('win-1', []));
  for (const [at, name] of steps) r.add(at, name);
  const s = await r.state();
  assert.equal(s.steps, 4);
  assert.equal(s.last, chain('win-1', steps));
  assert.notEqual(chain('win-2', steps), s.last, 'another window, another chain');
});

test('steps arriving faster than they are fingerprinted keep their order, and none is skipped', async () => {
  const r = new EditRecord('w', []);
  const steps = Array.from({ length: 300 }, (_, i) => [5000 + i, 'step ' + i]);
  // As in the panel: steps keep arriving while a check-in waits for the
  // record, so a step is added while another is still being fingerprinted.
  const seen = [];
  const tick = () => new Promise((done) => setImmediate(done));
  for (let i = 0; i < steps.length; i++) {
    r.add(...steps[i]);
    if (i % 5 === 0) seen.push(r.state());
    if (i % 3 === 0) await tick();
  }
  for (const x of await Promise.all(seen)) assert.equal(x.last, chain('w', steps.slice(0, x.steps)), `at ${x.steps} steps`);
  const s = await r.state();
  assert.equal(s.steps, 300);
  assert.equal(s.last, chain('w', steps));
});

test('a stored record carries on where it stopped; names are cut to 200 characters', async () => {
  const stored = [[10, 'a'], [20, 'b']];
  const r = new EditRecord('w9', stored.map((x) => [...x]));
  r.add(30.7, 'x'.repeat(250));
  const s = await r.state();
  assert.equal(s.steps, 3);
  assert.equal(s.last, chain('w9', [...stored, [30, 'x'.repeat(200)]]));
});
