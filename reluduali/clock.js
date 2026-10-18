// The clock inside the Reluduali extension for Lumit: what counts, at what
// rate, and the check-ins that tell reluduali.com about it.
//
// Pure. No network, no Lumit, no screen. panel.js feeds it what Lumit
// reports (each edit, Lumit coming to the front or going behind, an export
// starting, moving and ending) and asks it what the next check-in says.
// lumit/clock.test.mjs runs it with made-up times.
//
// What counts, in plain words:
//   - EDITING, at the contest's editing rate: Lumit is in front, the contest
//     project is open, and your last edit was less than the contest's idle
//     time ago (3 minutes, in the example contest). Stop editing and it stops
//     counting when that time runs out; switch to another program and it
//     stops at once.
//   - RENDERING, at the contest's rendering rate: Lumit is exporting. It
//     counts with nobody at the keyboard, because a render should run alone.
//     If Lumit stops reporting the export's progress for 15 seconds (a frozen
//     or sleeping PC), it stops counting until Lumit reports again.
//   - Nothing else. Another program in front, another project, idle: free.
//
// Recording is not here. Lumit cannot see the Reluduali Console, and the
// Console cannot yet tell this panel when it records (README, "What it
// cannot do yet").
(function (root) {
  'use strict';

  /** A program's name against a contest's pattern, as the Reluduali Timer reads its contest file: any case, `*` for anything. */
  function matches(pattern, name) {
    const re = new RegExp('^' + String(pattern).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    return re.test(name);
  }

  /**
   * Which of a contest's categories Lumit's editing and Lumit's exports fall
   * into. Editing: the category that lists lumit.exe. Rendering: the one
   * marked countsWhileIdle, as for the Reluduali Timer. Categories marked
   * "console" are the Reluduali Console's to report, never this panel's.
   * Either may be null: a contest that does not list Lumit does not count it.
   */
  function lumitCategories(rules) {
    const cats = (Array.isArray(rules?.categories) ? rules.categories : []).filter((c) => !c.console);
    const editing = cats.find((c) => !c.countsWhileIdle && (c.processes || []).some((p) => matches(p, 'lumit.exe'))) || null;
    const rendering = cats.find((c) => c.countsWhileIdle) || null;
    return { editing, rendering };
  }

  /** How long an export may go without a word from Lumit before it stops counting. Lumit looks at its export twice a second. */
  const RENDER_STALL_MS = 15000;

  class Ledger {
    constructor(rules) {
      this.rules = rules;
      this.idleMs = rules.idleMinutes * 60000;
      const { editing, rendering } = lumitCategories(rules);
      this.editing = editing;
      this.rendering = rendering;
      this.totals = new Map(rules.categories.map((c) => [c.name, { inFront: 0, charged: 0 }]));
      this.sent = new Map(rules.categories.map((c) => [c.name, { inFront: 0, charged: 0 }]));
      this.t = null;            // everything before this moment is accounted for
      this.focused = true;      // Lumit in front. A person working in the panel is working in Lumit.
      this.inContest = false;   // the contest project is the one open
      this.lastEdit = null;
      this.exporting = false;
      this.lastExportWord = null;
      this.steps = 0;           // edit reports seen (Lumit joins edits closer than 0.4 s into one)
    }

    start(at) { this.t = at; }
    get started() { return this.t !== null; }

    /**
     * A window opened again (the old one stopped taking check-ins) carries on
     * from where things stood: Lumit in front or not, the last edit, an export
     * still running. Never the old window's time, which was the old window's.
     */
    carryOn(old) {
      this.focused = old.focused;
      this.inContest = old.inContest;
      this.lastEdit = old.lastEdit;
      this.exporting = old.exporting;
      this.lastExportWord = old.lastExportWord;
      this.steps = old.steps;
    }

    /**
     * Charges the time from the last moment accounted for up to `now`, at
     * whatever was true at the START of it. Rendering first; editing only
     * where nothing was rendering, so no moment is ever counted twice.
     */
    advance(now) {
      if (this.t === null || now <= this.t) return;
      const t = this.t;
      let renderEnd = t;
      if (this.exporting && this.rendering && this.lastExportWord !== null) {
        renderEnd = Math.min(now, Math.max(t, this.lastExportWord + RENDER_STALL_MS));
      }
      let editEnd = t;
      if (this.focused && this.inContest && this.editing && this.lastEdit !== null) {
        editEnd = Math.min(now, this.lastEdit + this.idleMs);
      }
      const renderMs = Math.max(0, renderEnd - t);
      const editMs = Math.max(0, editEnd - Math.max(t, renderEnd));
      if (renderMs > 0) this.#add(this.rendering, renderMs);
      if (editMs > 0) this.#add(this.editing, editMs);
      this.t = now;
    }

    #add(category, ms) {
      const x = this.totals.get(category.name);
      x.inFront += ms;
      x.charged += ms * category.multiplier;
    }

    /** A moment can only move forward: a report stamped before the last one accounted for counts as now. */
    #at(at) { return this.t === null ? at : Math.max(at, this.t); }

    edit(at) { at = this.#at(at); this.advance(at); this.lastEdit = at; this.steps += 1; }
    focus(focused, at) { at = this.#at(at); this.advance(at); this.focused = !!focused; }
    contestProject(open, at) { at = this.#at(at); this.advance(at); this.inContest = !!open; }
    exportStarted(at) { at = this.#at(at); this.advance(at); this.exporting = true; this.lastExportWord = at; }
    exportProgress(at) { at = this.#at(at); this.advance(at); if (this.exporting) this.lastExportWord = at; }
    exportEnded(at) { at = this.#at(at); this.advance(at); this.exporting = false; }

    /** What the clock is doing at `now`, for the screen. */
    current(now) {
      if (this.t === null) return { what: 'not-started', rate: 0 };
      if (this.exporting && this.rendering && this.lastExportWord !== null && now - this.lastExportWord <= RENDER_STALL_MS) {
        return { what: 'rendering', category: this.rendering.name, rate: this.rendering.multiplier };
      }
      if (!this.inContest) return { what: 'not-contest', rate: 0 };
      if (!this.focused) return { what: 'background', rate: 0 };
      if (this.editing && this.lastEdit !== null && now - this.lastEdit < this.idleMs) {
        return { what: 'editing', category: this.editing.name, rate: this.editing.multiplier };
      }
      return { what: 'idle', rate: 0, idleFor: this.lastEdit === null ? null : now - this.lastEdit };
    }

    /**
     * What the next check-in reports, category by category: what has been
     * added since the last check-in the server accepted. Whole milliseconds,
     * and never a category charged above its own rate in one check-in (the
     * server refuses that); anything left over goes with the next one. The
     * same arithmetic as the Reluduali Timer's BeatBuilder.
     */
    segments() {
      const out = [];
      for (const c of this.rules.categories) {
        const total = this.totals.get(c.name);
        const already = this.sent.get(c.name);
        const inFront = Math.floor(total.inFront) - already.inFront;
        const owed = Math.floor(total.charged) - already.charged;
        const charged = Math.min(owed, Math.floor(inFront * c.multiplier));
        if (inFront > 0 || charged > 0) out.push({ category: c.name, inFrontMs: inFront, chargedMs: Math.max(0, charged) });
      }
      return out;
    }

    /** Call once the server has accepted `segments`. Until then they are sent again, added to. */
    accepted(segments) {
      for (const s of segments) {
        const already = this.sent.get(s.category);
        already.inFront += s.inFrontMs;
        already.charged += s.chargedMs;
      }
    }

    /** Budget spent here that the server has not been told about yet, in milliseconds. */
    unsentCharged() {
      let n = 0;
      for (const [name, total] of this.totals) n += Math.max(0, Math.floor(total.charged) - this.sent.get(name).charged);
      return n;
    }
  }

  // ---- the check-in's signature ------------------------------------------
  // The recipe, word for word as the server and the Reluduali Timer use it:
  //
  //   HMAC-SHA256( the window's key,
  //                previous signature + "\n" + "seq|nonce|category:inFrontMs:chargedMs,…" )
  //
  // in lowercase hex. The previous signature is empty for the first
  // check-in, so every check-in is chained to all the ones before it.

  //
  // A check-in that carries the edit record (below) ends its text with
  // "|record:<steps>:<last fingerprint>", so the record is signed with the rest.

  function beatText(seq, nonce, segments, record = null) {
    const text = `${seq}|${nonce}|` + segments.map((s) => `${s.category}:${s.inFrontMs}:${s.chargedMs}`).join(',');
    return record ? `${text}|record:${record.steps}:${record.last}` : text;
  }

  const hexToBytes = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
  const bytesToHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

  async function sign(keyHex, previous, seq, nonce, segments, record = null) {
    const key = await root.crypto.subtle.importKey('raw', hexToBytes(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await root.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(previous + '\n' + beatText(seq, nonce, segments, record)));
    return bytesToHex(mac);
  }

  // ---- the edit record ---------------------------------------------------
  // Lumit tells the panel each edit's step name and time, never the edit
  // itself. In the contest project, the panel chains them, one fingerprint per
  // step, starting from its window:
  //
  //   start  = SHA-256( "reluduali edit record\n" + window id )
  //   step i = SHA-256( previous + "\n" + i + "|" + at + "|" + name )   i from 1
  //
  // Each check-in carries the length and the newest fingerprint, and the
  // server stamps them with its own clock. At hand-in the steps are sent, and
  // they must rebuild every fingerprint stamped: so each step existed, as
  // named and timed, by the check-in that counted it.

  const STEP_NAME_MAX = 200;
  const sha256 = async (text) => bytesToHex(await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const recordStart = (windowId) => sha256('reluduali edit record\n' + windowId);
  const recordStep = (previous, index, at, name) => sha256(`${previous}\n${index}|${at}|${name}`);

  /** One window's record. `steps` is [[at, name], …], kept as given (so a stored record can carry on). */
  class EditRecord {
    constructor(windowId, steps = []) {
      this.windowId = windowId;
      this.steps = steps;
      this.last = null;
      this.counted = 0; // how many of `steps` the fingerprint covers
      this.chain = recordStart(windowId).then((start) => { this.last = start; return this.#catchUp(); });
    }

    async #catchUp() {
      while (this.counted < this.steps.length) {
        const [at, name] = this.steps[this.counted];
        this.last = await recordStep(this.last, this.counted + 1, at, name);
        this.counted++;
      }
    }

    /** A step, in the order Lumit reported it. */
    add(at, name) {
      this.steps.push([Math.floor(at), String(name ?? '').slice(0, STEP_NAME_MAX)]);
      this.chain = this.chain.then(() => this.#catchUp());
      return this.chain;
    }

    /**
     * What a check-in carries: every step so far, fingerprinted. Each catch-up
     * runs on the one chain, never beside another, so two never hash from the
     * same fingerprint; this waits until no step is still being added.
     */
    async state() {
      let waited;
      do { waited = this.chain; await waited; } while (waited !== this.chain);
      return { steps: this.counted, last: this.last };
    }
  }

  root.RelClock = { Ledger, lumitCategories, matches, beatText, sign, EditRecord, recordStart, recordStep, RENDER_STALL_MS };
})(typeof window !== 'undefined' ? window : globalThis);
