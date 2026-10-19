// The Reluduali extension for Lumit: what it shows, and what it does when
// Lumit tells it something. The clock is clock.js; everything it sends is
// in server.js. This file connects the two to Lumit and to the screen.
//
// Every piece of text it shows is set with textContent, never as HTML, so
// nothing a server or a file name says can become part of the page.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  // About once a minute, as for the Reluduali Timer. Only whoever loads this
  // page can change it (lumit/check.mjs does, to run in seconds): Lumit
  // loads it as plain index.html.
  const BEAT_MS = Math.max(1000, Number(new URLSearchParams(location.search).get('beat')) || 60000);
  const VERSION = '0.3.0';
  const KEY = {
    token: 'reluduali.token',
    contest: 'reluduali.contest',
    window: 'reluduali.window',
    watched: 'reluduali.watched',
    whenDone: 'reluduali.whenDone',
    renders: (contestId) => 'reluduali.renders.' + contestId,
    records: (contestId) => 'reluduali.records.' + contestId,
    snapshots: (contestId) => 'reluduali.snapshots.' + contestId,
  };

  // The page's own storage, which Lumit keeps for this extension alone. It
  // holds the sign-in's token (never the password), which contest you chose,
  // whether a window was open, the folder you watch, your renders'
  // fingerprints, and your edit record (each step's name and time, window by
  // window). The README lists it.
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
    json(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  };

  const S = {
    info: null,
    token: null, user: null,
    contests: [], contestId: null, contest: null, entry: null, invitations: [], friends: [], submission: null,
    requests: { incoming: [], outgoing: [] }, // friend requests: sent to you, and sent by you
    joinArmed: null, joined: null, // an invitation pressed once, waiting for the second press; what the last join brought
    friendNote: null,                // what the last friend request did, in words
    win: null, ledger: null, contestProject: null, reopened: false, closedElsewhere: false,
    witnessed: [], lastBeatOk: null, lastBeatTry: 0, offlineSince: null, beating: false, beatTimer: null,
    records: [], record: null, recordCheck: null, // the edit record: every window's steps, this window's chain, the server's check
    project: { open: false, name: null, saved: false, dirty: false },
    share: { role: 'none', away: false, open: false, people: [] },
    wantShare: false, linkSent: false,
    exportState: { state: 'idle' }, rendering: null, renders: [], whenDone: 'replace',
    watched: null, imported: [],
    consoleCode: null, codeWatch: null,
    sent: [],
    told: new Set(),   // notices already shown on Lumit's bottom strip
    screen: 'loading', signOutArmed: false,
  };

  // ---------------------------------------------------------------------------
  // Little helpers
  // ---------------------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, '0');
  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }
  /** Time until a moment: "2:14:05", or "6 d 4:12:00" beyond a day. */
  function countdown(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    return d ? `${d} d ${clock((s % 86400) * 1000)}` : clock(s * 1000);
  }
  /** A rate as the concept boards write it: 1.0×, 0.5×, 0.35×, 1.1×. */
  function rate(m) {
    if (!m) return 'free';
    const r = Math.round(m * 100) / 100;
    return `${Number.isInteger(Math.round(r * 1000) / 100) ? r.toFixed(1) : String(r)}×`;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  /** A budget in words: "8 hours", "1 hour", "1 h 30 min". */
  function span(ms) {
    const m = Math.round(ms / 60000);
    if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  // A 24-hour clock, as on the concept boards.
  const minutes = (n) => (n === 1 ? '1 minute' : `${n} minutes`);
  const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const hm = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
  }
  const short = (sha) => (sha ? `${sha.slice(0, 4)} ${sha.slice(4, 8)}…` : '—');
  /** A category's colour on the boards: the Console's kinds of time, and anything named for recording, are recording's blue. */
  function colourOf(name) {
    const c = S.contest && S.contest.categories.find((x) => x.name === name);
    if (c && c.console) return 'rec';
    return /record/i.test(name) ? 'rec' : /edit/i.test(name) ? 'edit' : /render/i.test(name) ? 'rend' : 'other';
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function button(text, cls, onClick) {
    const b = el('button', cls || 'btn', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function say(id, text) { const e = $(id); e.textContent = text || ''; e.hidden = !text; }
  function setText(id, text) { $(id).textContent = text; }
  function clear(node) { while (node.firstChild) node.firstChild.remove(); return node; }

  /** Lumit's bottom strip, once per thing worth saying: seen even when this panel is tabbed away. */
  function notice(key, text) {
    if (S.told.has(key)) return;
    S.told.add(key);
    window.lumit.call('app.notice', { text }).catch(() => {});
  }

  /**
   * The clock on Lumit's bottom strip (`app.status`, Lumit 0.7.1): one line that stays, so the time
   * left shows with this panel tabbed away too. Lumit puts "Reluduali:" in front, shows the latest
   * line at most four times a second, and hides it while one of its notices is up. Lumit 0.7.0 has
   * no such call: refused once, it is not asked again.
   */
  let statusSent, statusWorks = true;
  function setStatus(text) {
    if (!statusWorks || text === statusSent) return;
    statusSent = text;
    window.lumit.call('app.status', { text }).catch((e) => { if (e && e.code === 'unknown-method') statusWorks = false; });
  }

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------

  function go(screen) {
    if (screen !== S.screen) { S.friendNote = null; S.joinArmed = null; } // a word about the last press, until you go elsewhere
    S.screen = screen;
    app.dataset.screen = screen;
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== 's-' + screen;
    for (const n of document.querySelectorAll('.nav[data-go]')) {
      if (n.dataset.go === screen) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
    }
    $('more').hidden = true;
    $('more-open').setAttribute('aria-expanded', 'false');
    render();
    window.scrollTo(0, 0);
    if (listsShown()) readLists();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-go]');
    if (t) { ev.preventDefault(); go(t.dataset.go); }
  });
  $('more-open').addEventListener('click', () => {
    const open = $('more').hidden;
    $('more').hidden = !open;
    $('more-open').setAttribute('aria-expanded', String(open));
  });

  // ---------------------------------------------------------------------------
  // Signing in and out
  // ---------------------------------------------------------------------------

  $('signin-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const username = $('signin-name').value.trim();
    const password = $('signin-pass').value;
    $('signin-pass').value = ''; // off the page at once, whatever happens next
    if (!username || !password) return say('signin-error', 'Type your name and your password.');
    say('signin-error', '');
    $('signin-go').disabled = true;
    try {
      const r = await RelServer.signIn(username, password);
      S.token = r.token;
      S.user = r.user;
      store.set(KEY.token, r.token);
      await afterSignIn();
    } catch (e) {
      say('signin-error', e.offline ? 'reluduali.com could not be reached. Check the internet connection, then try again.' : e.message);
    } finally {
      $('signin-go').disabled = false;
    }
  });
  // A friend request from the Partner page (0.2.3): to the name typed, and only that.
  $('pt-add').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = $('pt-add-name').value.trim();
    if (!name) return say('pt-error', 'Type your friend\'s Reluduali username.');
    askFriend(name);
  });
  $('signin-make').addEventListener('click', () => {
    window.lumit.call('app.openExternal', { url: 'https://reluduali.com/login' }).catch(() => {});
  });

  $('ac-signout').addEventListener('click', async () => {
    if (S.win && !S.signOutArmed) {
      S.signOutArmed = true;
      $('ac-signout').textContent = 'Sign out and stop timing';
      return;
    }
    const token = S.token;
    forgetSignIn();
    if (token) RelServer.signOut(token).catch(() => {});
  });

  function forgetSignIn(reason) {
    stopWindow();
    store.del(KEY.token);
    store.del(KEY.window);
    Object.assign(S, { token: null, user: null, contest: null, entry: null, submission: null, invitations: [], friends: [], requests: { incoming: [], outgoing: [] }, joinArmed: null, joined: null, signOutArmed: false });
    $('ac-signout').textContent = 'Sign out';
    go('signin');
    say('signin-error', reason || '');
  }

  /** Any answer of 401 means the sign-in has ended (signed out elsewhere, or thirty days passed). */
  async function guarded(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e.status === 401 && S.token) forgetSignIn('Your sign-in has ended. Sign in again to carry on.');
      throw e;
    }
  }

  async function afterSignIn() {
    S.whenDone = store.get(KEY.whenDone) === 'just' ? 'just' : 'replace';
    const [contests, friends, invitations, requests] = await Promise.all([
      guarded(() => RelServer.contests(S.token)),
      guarded(() => RelServer.friends(S.token)).catch(() => []),
      guarded(() => RelServer.invitations(S.token)).catch(() => []),
      guarded(() => RelServer.friendRequests(S.token)).catch(() => null),
    ]);
    S.contests = contests || [];
    S.friends = friends || [];
    S.invitations = invitations || [];
    S.requests = requests || { incoming: [], outgoing: [] };
    const remembered = store.get(KEY.contest);
    if (remembered && S.contests.some((c) => c.id === remembered)) await chooseContest(remembered, { quiet: true });
    // A window that was open when this panel last closed is opened again: the
    // contest's window cannot be paused, and idle time is free anyway.
    const note = store.json(KEY.window);
    if (note && note.contestId === S.contestId && S.entry && !deadlinePassed()) {
      // A note left by the panel before 0.2.0 holds the name alone.
      S.contestProject = typeof note.project === 'string' ? { id: null, name: note.project } : (note.project || null);
      try { await openWindow({ onStart: true }); } catch {}
    }
    go(S.entry ? 'overview' : 'contest');
  }

  // ---------------------------------------------------------------------------
  // The contest, your entry, your partner
  // ---------------------------------------------------------------------------

  const deadlinePassed = () => !!(S.contest && S.contest.submitBy && Date.now() > S.contest.submitBy);
  const notOpenYet = () => !!(S.contest && S.contest.opensAt && Date.now() < S.contest.opensAt);
  // A team is up to four (0.3.0; the organizer, 2026-10-18: "There can be up to 4 People in a Group entering a Contest."),
  // counting the friends asked who have not said yes yet, as reluduali.com counts it.
  const TEAM_MAX = 4;
  /** Everyone else in your entry, in the order they came in: up to three. */
  const teammatesOf = (entry) => (entry && S.user ? entry.members.filter((m) => m.id !== S.user.id) : []);
  const partnerOf = (entry) => teammatesOf(entry)[0] || null;
  /** Whether anyone else in the team has said yes: then the project can be shared. */
  const teamReady = () => teammatesOf(S.entry).some((m) => m.accepted);
  /** Names as a person writes them: "a", "a and b", "a, b and c". */
  const inWords = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0] || '');
  const namesOf = (people) => inWords(people.map((m) => m.username));
  /** Who asked, for an invitation: everyone in the team that asked (reluduali.com's `team`), or the one who did. */
  const askersOf = (inv) => (inv && inv.team && inv.team.length ? namesOf(inv.team) : inv && inv.from ? inv.from.username : 'A friend');
  const meIn = (entry) => (entry && S.user ? entry.members.find((m) => m.id === S.user.id) || null : null);
  /** The contest's categories the Reluduali Console times itself, never this panel. */
  const consoleCats = () => (S.contest ? S.contest.categories.filter((c) => c.console) : []);

  /** What someone giving time to `name` is doing, in words. */
  function activityWords(name) {
    const c = S.contest && S.contest.categories.find((x) => x.name === name);
    if (c && c.console === 'in-game') return 'is in the game';
    if (c && c.console === 'queued') return 'has a queued recording running';
    return /record/i.test(name) ? 'is recording' : /edit/i.test(name) ? 'is editing' : /render/i.test(name) ? 'is rendering' : `is ${name}`;
  }

  async function chooseContest(id, { quiet = false } = {}) {
    if (S.win && S.contestId !== id) stopWindow();
    S.contestId = id;
    S.contest = S.contests.find((c) => c.id === id) || null;
    store.set(KEY.contest, id);
    S.renders = store.json(KEY.renders(id)) || [];
    S.records = store.json(KEY.records(id)) || [];
    S.recordCheck = null;
    S.snapshotCheck = null;
    S.entry = await guarded(() => RelServer.entry(S.token, id)).catch((e) => { if (e.status !== 404) throw e; return null; });
    S.submission = S.entry ? await guarded(() => RelServer.submission(S.token, id)).catch(() => null) : null;
    if (!quiet) render();
  }

  /**
   * What reluduali.com says now: contests, friends, friend requests, invitations and your entry. Read at sign-in, and again whenever
   * the Contest or Partner screen opens, every minute while one of them shows, and on Refresh. (2026-10-17: a partner
   * who had signed in before the invitation was sent never saw it, and a contest made after signing in never showed.)
   */
  let reading = null;
  function readLists() {
    if (!S.token || !S.user) return Promise.resolve();
    if (reading) return reading;
    reading = (async () => {
      try {
        const [contests, friends, invitations, requests] = await Promise.all([
          guarded(() => RelServer.contests(S.token)),
          guarded(() => RelServer.friends(S.token)).catch(() => S.friends),
          guarded(() => RelServer.invitations(S.token)).catch(() => S.invitations),
          guarded(() => RelServer.friendRequests(S.token)).catch(() => S.requests),
        ]);
        S.contests = contests || S.contests;
        S.friends = friends || [];
        S.invitations = invitations || [];
        S.requests = requests || { incoming: [], outgoing: [] };
        // An open window keeps the rules it opened with; otherwise the contest is as the server has it now.
        if (S.contestId && !S.win) S.contest = S.contests.find((c) => c.id === S.contestId) || S.contest;
        if (S.contestId) await refreshEntry();
        say('ct-pick-error', '');
      } catch (e) {
        say('ct-pick-error', e.offline ? 'reluduali.com could not be reached. The list is as it was.' : e.message);
      } finally {
        reading = null;
      }
      render();
    })();
    return reading;
  }
  const listsShown = () => S.screen === 'contest' || S.screen === 'partner';

  async function refreshEntry() {
    if (!S.contestId) return;
    try {
      S.entry = await guarded(() => RelServer.entry(S.token, S.contestId));
      S.submission = await guarded(() => RelServer.submission(S.token, S.contestId)).catch(() => null);
    } catch (e) {
      if (e.status === 404) S.entry = null;
    }
    render();
  }

  async function enter(partner) {
    say('ct-error', '');
    try {
      S.entry = await guarded(() => RelServer.enter(S.token, S.contestId, partner || null));
      S.contests = await guarded(() => RelServer.contests(S.token)).catch(() => S.contests);
      S.contest = S.contests.find((c) => c.id === S.contestId) || S.contest;
    } catch (e) {
      say('ct-error', e.offline ? 'reluduali.com could not be reached.' : e.message);
    }
    render();
  }

  /**
   * Saying yes to a friend's invitation. Entered on your own already, your entry joins theirs (0.2.3; before it, someone
   * who had entered could not join a partner at all): reluduali.com moves your time into the team's and ends your
   * window, so the time counted since the last check-in is sent first, and a window open here opens again, on the
   * team's entry.
   */
  async function accept(invitation) {
    say('ct-error', '');
    S.joinArmed = null;
    const hadWindow = !!S.win && S.contestId === invitation.contestId;
    try {
      // The last check-in for this entry, and none while the entry moves: it would land in a window that has ended.
      if (hadWindow) { await beat(); clearTimeout(S.beatTimer); }
      const r = await guarded(() => RelServer.acceptInvitation(S.token, invitation.contestId, invitation.entryId)).catch((e) => { if (hadWindow) scheduleBeat(); throw e; });
      S.invitations = S.invitations.filter((i) => i !== invitation);
      const { joined, ...entry } = r;
      S.entry = entry;
      S.joined = joined ? { contestId: invitation.contestId, words: joined.words } : null;
      if (joined) notice('joined-' + invitation.entryId, `You joined ${askersOf(invitation)}'s entry`);
      if (hadWindow) {
        const carry = S.ledger;
        try { await openWindow({ carry }); } catch (e) { stopWindow(); say('ct-error', `Your window could not open again: ${e.message}. Open it on this page.`); }
      }
    } catch (e) {
      say('ct-error', e.offline ? 'reluduali.com could not be reached.' : e.message);
    }
    render();
  }

  /** Asking a friend into your team after entering, up to four; and taking one invitation back before they answer. */
  async function invite(username) {
    say('pt-error', '');
    try {
      S.entry = await guarded(() => RelServer.invite(S.token, S.contestId, username));
    } catch (e) {
      say('pt-error', e.offline ? 'reluduali.com could not be reached.' : e.message);
    }
    render();
  }
  async function takeBack(username) {
    say('pt-error', '');
    try {
      S.entry = await guarded(() => RelServer.takeBackInvitation(S.token, S.contestId, username));
    } catch (e) {
      say('pt-error', e.offline ? 'reluduali.com could not be reached.' : e.message);
    }
    render();
  }

  /** A friend request to the name typed, and saying yes to one sent to you. Then the lists are read again. */
  async function askFriend(username) {
    say('pt-error', '');
    S.friendNote = null;
    try {
      const r = await guarded(() => RelServer.askFriend(S.token, username));
      const name = r.user ? r.user.username : username;
      S.friendNote = r.status === 'friends' ? `You and ${name} are friends now.` : `Friend request sent to ${name}. You are friends once they say yes, on reluduali.com or in their panel.`;
      $('pt-add-name').value = '';
    } catch (e) {
      say('pt-error', e.offline ? 'reluduali.com could not be reached.' : e.message);
    }
    await readLists();
  }
  async function acceptFriend(person) {
    say('pt-error', '');
    try {
      await guarded(() => RelServer.acceptFriend(S.token, person.id));
      S.friendNote = `You and ${person.username} are friends now.`;
    } catch (e) {
      say('pt-error', e.offline ? 'reluduali.com could not be reached.' : e.message);
    }
    await readLists();
  }

  // ---------------------------------------------------------------------------
  // The window: opening it, and the check-in about once a minute
  // ---------------------------------------------------------------------------

  // The contest's project is `{id, name}`. Lumit 0.7.1 gives every project an id that a rename, a
  // move or a Save As keeps, so versions numbered by hand (edit o1, edit o2…) are one project, and a
  // project never saved has one too. Lumit 0.7.0 has no id, and the file's name stands in for it.
  const projectOf = (p) => ({ id: (p && p.id) || null, name: (p && p.name) || null });
  function isContestProject(p) {
    const cp = S.contestProject;
    if (!cp || !p || !p.open) return false;
    if (cp.id && p.id) return cp.id === p.id;
    return !!p.name && p.name === cp.name;
  }
  const contestProjectOpen = () => S.share.role === 'guest' || isContestProject(S.project);
  /** After a rename or a Save As its name follows it, and an id seen for the first time is kept. */
  function followContestProject() {
    const cp = S.contestProject;
    if (!cp || !isContestProject(S.project)) return;
    if ((S.project.id && !cp.id) || (S.project.name && S.project.name !== cp.name)) {
      S.contestProject = projectOf(S.project);
      saveWindowNote();
    }
  }
  /** How the contest's project is named on the panel: never saved, it has no file name yet. */
  const contestProjectName = () => (S.contestProject && S.contestProject.name) || 'your new project (not saved yet)';

  /**
   * Opens a window: the server hands over a key for this window alone, sent
   * once and kept only in this page's memory. `onStart`: opened again because
   * the panel restarted with a window open. `carry`: the ledger of a window
   * that stopped taking check-ins, whose state (not its time) carries on.
   */
  async function openWindow({ onStart = false, carry = null } = {}) {
    say('ct-error', '');
    const r = await guarded(() => RelServer.openWindow(S.token, S.contestId));
    stopWindow({ keepNote: true });
    S.win = { id: r.id, key: r.key, nonce: r.nonce, seq: r.seq, last: '', contestId: S.contestId };
    // Each window keeps its own edit record, chained from the window itself.
    const steps = [];
    S.records.push({ id: r.id, steps });
    S.record = new RelClock.EditRecord(r.id, steps);
    saveRecords();
    S.contest = r.contest;
    S.entry = r.entry;
    S.reopened = onStart;
    S.closedElsewhere = false;
    const now = Date.now();
    S.ledger = new RelClock.Ledger(S.contest);
    S.ledger.start(now);
    if (carry) S.ledger.carryOn(carry);
    if (!S.contestProject && S.project.open && S.project.name) S.contestProject = projectOf(S.project);
    S.ledger.contestProject(contestProjectOpen(), now);
    if (!carry) S.witnessed = [];
    S.lastBeatOk = now;
    S.lastBeatTry = now;
    S.offlineSince = null;
    saveWindowNote();
    scheduleBeat();
    render();
  }

  function saveRecords() {
    if (S.contestId) store.set(KEY.records(S.contestId), JSON.stringify(S.records));
  }

  function saveWindowNote() {
    if (S.win) store.set(KEY.window, JSON.stringify({ contestId: S.contestId, project: S.contestProject }));
  }

  function stopWindow({ keepNote = false } = {}) {
    clearTimeout(S.beatTimer);
    S.win = null;
    S.ledger = null;
    S.record = null;
    if (!keepNote) store.del(KEY.window);
  }

  function scheduleBeat() {
    clearTimeout(S.beatTimer);
    if (!S.win) return;
    const due = Math.max(1000, BEAT_MS - (Date.now() - S.lastBeatTry));
    S.beatTimer = setTimeout(() => { beat().finally(scheduleBeat); }, due);
  }

  /** A timer that has fallen behind (a page tabbed away is woken less often) catches up on the next thing Lumit says. */
  function nudge() {
    if (S.win && !S.beating && Date.now() - S.lastBeatTry > BEAT_MS + 5000) beat().finally(scheduleBeat);
  }
  document.addEventListener('visibilitychange', nudge);

  async function beat() {
    if (!S.win || S.beating) return;
    S.beating = true;
    S.lastBeatTry = Date.now();
    const w = S.win;
    const ledger = S.ledger;
    const rec = S.record;
    try {
      ledger.advance(Date.now());
      const segments = ledger.segments();
      const seq = w.seq + 1;
      // The record's steps are kept on this PC before their fingerprint is
      // sent, so whatever the server stamps can always be shown at hand-in.
      const record = rec && rec.windowId === w.id ? await rec.state() : null;
      if (record) saveRecords();
      const signature = await RelClock.sign(w.key, w.last, seq, w.nonce, segments, record);
      let r;
      try {
        r = await RelServer.beat(S.token, w.id, { seq, nonce: w.nonce, segments, signature, record });
      } catch (e) {
        if (e.offline) {
          // Kept, and sent again with the next check-in, added to.
          if (S.offlineSince === null) S.offlineSince = Date.now();
          if (Date.now() - S.offlineSince > 120000) notice('offline', 'Not reaching reluduali.com: this time is not witnessed');
          return;
        }
        if (e.status === 401) { forgetSignIn('Your sign-in has ended. Sign in again to carry on.'); return; }
        if (e.status === 409 || e.status === 404) { await recover(w, e); return; }
        if (e.status === 422) {
          // The server would not take it (it claims more time than passed, or
          // the chain is broken). That time goes uncharged; say so plainly.
          ledger.accepted(segments);
          S.witnessed.unshift({ at: Date.now(), refused: e.message });
          notice('refused-' + seq, 'A check-in was refused: ' + e.message);
          return;
        }
        throw e;
      }
      if (S.win !== w) return;
      w.seq = r.seq;
      w.nonce = r.nonce;
      w.last = signature;
      ledger.accepted(segments);
      S.entry = r.entry;
      S.offlineSince = null;
      S.lastBeatOk = Date.now();
      // A snapshot asked for (0.3.0): taken and sealed beside the check-ins, never holding them up.
      if (r.snapshot) takeSnapshot(r.snapshot, w).catch(() => {});
      S.witnessed.unshift({ at: S.lastBeatOk, seq: r.seq, doing: segments.filter((s) => s.inFrontMs > 0).map((s) => s.category), gap: r.gap, elapsedMs: r.elapsedMs });
      if (S.witnessed.length > 40) S.witnessed.length = 40;
      const waiting = S.entry.share;
      if (waiting && waiting.setBy !== S.user.id && S.share.role === 'none') notice('link-' + waiting.setAt, `${teammatesOf(S.entry).length > 1 ? 'Someone in your team' : 'Your partner'} is sharing their project: open Partner to join it`);
      if (S.entry.remainingMs <= 0) notice('over', 'Your contest time is used. You can still hand in');
    } catch (e) {
      console.error(e);
    } finally {
      S.beating = false;
      render();
    }
  }

  /**
   * The server no longer takes check-ins for this window. Either another
   * timer opened a window for this contest (one per person, so this one was
   * closed), or a check-in arrived and only its answer was lost, and with it
   * the one-time code the next one needs. Then a new window is the only way
   * on. What this window counted and had not yet reported goes uncharged:
   * the server would refuse it in a new window, as more time than has passed
   * there, and nothing is ever charged twice.
   */
  async function recover(w, error) {
    let state = null;
    try { state = await RelServer.windowState(S.token, w.id); } catch {}
    if (state && state.closedAt) {
      stopWindow();
      S.closedElsewhere = true;
      S.witnessed.unshift({ at: Date.now(), refused: 'Another timer opened this contest, so this window was closed.' });
      notice('closed-' + w.id, 'Another timer took over this contest: this panel stopped timing');
      return;
    }
    const carry = S.ledger;
    await openWindow({ carry }).catch(() => {});
    S.witnessed.unshift({ at: Date.now(), refused: `The window was opened again (${error.message}).` });
  }

  // ---------------------------------------------------------------------------
  // What Lumit tells this panel
  // ---------------------------------------------------------------------------

  function onProject(p) {
    S.project = p || { open: false };
    if (S.win && !S.contestProject && S.project.open && S.project.name) {
      S.contestProject = projectOf(S.project);
      saveWindowNote();
    }
    followContestProject();
    S.ledger?.contestProject(contestProjectOpen(), Date.now());
    render();
  }

  function onEdit(edit) {
    // A project never saved becomes the contest's at its first edit, if Lumit gives it an id
    // (0.7.1): "AS SOON AS YOU TOUCH, the timer starts" (the contest's words, 2026-10-14). A blank project
    // Lumit opens by itself is not taken just for being open.
    if (S.ledger && S.win && !S.contestProject && S.project.open && S.project.id) {
      S.contestProject = projectOf(S.project);
      saveWindowNote();
      S.ledger.contestProject(contestProjectOpen(), Date.now());
    }
    // Only edits in the contest project are noted. Another project's are not
    // even looked at.
    if (!S.ledger || !contestProjectOpen()) return;
    const at = Math.min(Number(edit && edit.at) || Date.now(), Date.now());
    S.ledger.edit(at);
    S.record?.add(at, edit && edit.step);
    nudge();
  }

  function onFocus(f) {
    S.ledger?.focus(!!(f && f.focused), Date.now());
    nudge();
    render();
  }

  async function onExportStarted(st) {
    S.exportState = st || { state: 'running' };
    S.ledger?.exportStarted(Date.now());
    const n = (S.renders.length ? S.renders[S.renders.length - 1].n : 0) + 1;
    S.rendering = { n, startedAt: Date.now(), serverId: null };
    render();
    if (S.win) {
      try {
        const r = await RelServer.renderStarted(S.token, S.win.id);
        if (S.rendering && S.rendering.n === n) S.rendering.serverId = r.id;
      } catch {}
      render();
    }
  }

  function onExportProgress(st) {
    S.exportState = st || S.exportState;
    S.ledger?.exportProgress(Date.now());
    if (holding()) redrawWaiting = true; else renderRender();
  }

  async function onExportFinished(st) {
    S.exportState = st || { state: 'done' };
    S.ledger?.exportEnded(Date.now());
    const r = S.rendering || { n: (S.renders.length ? S.renders[S.renders.length - 1].n : 0) + 1, serverId: null };
    S.rendering = null;
    let print = null;
    try { print = await window.lumit.call('export.fingerprint'); } catch {}
    const sha = print && typeof print.sha256 === 'string' ? print.sha256.toLowerCase() : null;
    const done = { n: r.n, finishedAt: Date.now(), sha256: sha, bytes: print ? print.bytes : null, witnessed: false, status: 'test' };
    if (sha && r.serverId && S.win) {
      try {
        await RelServer.renderDone(S.token, S.win.id, r.serverId, sha, print.bytes);
        done.witnessed = true;
      } catch {}
    }
    S.renders.push(done);
    if (S.whenDone === 'replace' && sha) await replaceEntry(done);
    saveRenders();
    render();
  }

  async function onExportFailed(st) {
    S.exportState = st || { state: 'failed' };
    S.ledger?.exportEnded(Date.now());
    const r = S.rendering;
    S.rendering = null;
    if (r && r.serverId && S.win) RelServer.renderStopped(S.token, S.win.id, r.serverId).catch(() => {});
    render();
  }

  function saveRenders() {
    if (S.contestId) store.set(KEY.renders(S.contestId), JSON.stringify(S.renders.slice(-30)));
  }

  /** "Render and replace my entry": the hand-in keeps its links and takes this render's fingerprint. */
  async function replaceEntry(done) {
    const s = S.submission;
    if (!s) { done.status = 'ready'; return; }
    try {
      S.submission = await guarded(() => RelServer.handIn(S.token, S.contestId, { youtube: s.youtube, hq: s.hq, hqSha256: done.sha256 }));
      for (const x of S.renders) if (x !== done && x.status === 'handed in') x.status = 'replaced';
      done.status = 'handed in';
    } catch (e) {
      done.status = 'not handed in';
      done.error = e.message;
    }
  }

  async function onShare(sh) {
    const was = S.share.role;
    S.share = sh || { role: 'none', people: [] };
    S.ledger?.contestProject(contestProjectOpen(), Date.now());
    if (S.share.role === 'host' && was !== 'host' && S.wantShare) await sendLink();
    if (S.share.role === 'none' && was === 'host' && S.linkSent) {
      S.linkSent = false;
      RelServer.takeBackShareLink(S.token, S.contestId).catch(() => {});
    }
    render();
  }

  // ---------------------------------------------------------------------------
  // Partner: hosting the shared project, or joining it
  // ---------------------------------------------------------------------------

  async function shareProject() {
    say('pt-error', '');
    S.wantShare = true;
    if (S.share.role === 'host') return sendLink();
    // Lumit only opens its own Shared project window; you press Start sharing there.
    try { await window.lumit.call('share.start', {}); } catch (e) { say('pt-error', e.message); }
  }

  async function sendLink() {
    S.wantShare = false;
    try {
      const link = await window.lumit.call('share.link');
      if (!link) return say('pt-error', 'Lumit has no invite link yet. Press Start sharing in its window first.');
      await guarded(() => RelServer.leaveShareLink(S.token, S.contestId, link));
      S.linkSent = true;
      await refreshEntry();
    } catch (e) {
      say('pt-error', e.message);
    }
  }

  async function joinPartner() {
    say('pt-error', '');
    try {
      const s = await guarded(() => RelServer.shareLink(S.token, S.contestId));
      // Lumit opens its Join window with the link filled in. You choose your
      // footage folder there and press Join.
      await window.lumit.call('share.join', { link: s.link });
    } catch (e) {
      say('pt-error', e.status === 404 ? 'There is no invite link waiting any more. Ask your partner to share again.' : e.message);
    }
  }

  async function stopSharing() {
    say('pt-error', '');
    try { await window.lumit.call('share.stop'); } catch (e) { say('pt-error', e.message); }
  }

  // ---------------------------------------------------------------------------
  // Record: the folder recordings land in
  // ---------------------------------------------------------------------------

  async function watch(folder) {
    try {
      const answer = await window.lumit.call('import.watch', folder ? { folder } : {});
      if (!answer || !answer.folder) return;
      S.watched = answer.folder;
      store.set(KEY.watched, answer.folder);
    } catch {
      S.watched = null;
      store.del(KEY.watched);
    }
    renderRecord();
  }
  $('rc-watch').addEventListener('click', () => watch(null));
  $('rc-unwatch').addEventListener('click', async () => {
    try { await window.lumit.call('import.unwatch'); } catch {}
    S.watched = null;
    store.del(KEY.watched);
    renderRecord();
  });

  // ---------------------------------------------------------------------------
  // Record: linking the Reluduali Console
  // ---------------------------------------------------------------------------
  //
  // This panel never talks to the Console. It asks reluduali.com for a code,
  // shows it, and the person types it into the Console, which trades it for
  // a pass of its own and then reports its own time. What the panel knows of
  // the Console afterwards is only what the server says about it.

  async function linkConsole() {
    say('rc-error', '');
    try {
      const wasLinked = !!(meIn(S.entry) || {}).consoleLinked;
      const code = await guarded(() => RelServer.consoleCode(S.token, S.contestId));
      S.consoleCode = { ...code, wasLinked };
      // Until the Console has used it (or it runs out), look every few seconds.
      clearInterval(S.codeWatch);
      S.codeWatch = setInterval(async () => {
        const c = S.consoleCode;
        if (!c || c.expiresAt <= Date.now()) { clearInterval(S.codeWatch); S.consoleCode = null; renderRecord(); return; }
        try { S.entry = await guarded(() => RelServer.entry(S.token, S.contestId)); } catch {}
        const me = meIn(S.entry);
        if (me && me.consoleLinked && !c.wasLinked) { clearInterval(S.codeWatch); S.consoleCode = null; }
        renderRecord();
      }, 3000);
    } catch (e) {
      say('rc-error', e.offline ? 'reluduali.com could not be reached.' : e.message);
    }
    renderRecord();
  }

  async function unlinkConsole() {
    say('rc-error', '');
    try {
      await guarded(() => RelServer.unlinkConsole(S.token, S.contestId));
      clearInterval(S.codeWatch);
      S.consoleCode = null;
      await refreshEntry();
    } catch (e) {
      say('rc-error', e.message);
    }
    renderRecord();
  }
  $('rc-link').addEventListener('click', linkConsole);
  $('rc-unlink').addEventListener('click', unlinkConsole);

  function renderConsoleCard() {
    const cats = consoleCats();
    const me = meIn(S.entry);
    const linked = !!(me && me.consoleLinked);
    const now = Date.now();
    const fresh = !!(me && me.consoleSeenAt && now - me.consoleSeenAt <= 90000);
    const code = S.consoleCode && S.consoleCode.expiresAt > now ? S.consoleCode : null;
    let state;
    if (!S.entry) state = 'Enter a contest first: the Console is linked to your entry.';
    else if (!cats.length) state = 'This contest has nothing for the Console to time, so recording is free in it.';
    else if (code) state = 'Type this code into the Reluduali Console:';
    else if (linked) state = !me.consoleSeenAt ? 'Linked. The Console has not checked in yet.' : fresh ? `Linked. Last heard from ${ago(me.consoleSeenAt)}.` : `Linked, but not heard from since ${hm(me.consoleSeenAt)}.`;
    else state = 'Not linked yet. Link it once, and the Console reports its own time to reluduali.com. This panel never talks to it.';
    $('rc-state').textContent = state;
    $('rc-code-box').hidden = !code;
    if (code) {
      $('rc-code').textContent = code.code;
      $('rc-code-note').textContent = `It works once, until ${hm(code.expiresAt)}. It is all the Console needs: no second password.`;
    }
    $('rc-link').hidden = !(S.entry && cats.length) || !!code;
    $('rc-link').textContent = linked ? 'Link again' : 'Link the Console';
    $('rc-unlink').hidden = !linked;
    const rates = clear($('rc-rates'));
    for (const c of cats) {
      const li = el('li');
      const sw = el('span', 'sw');
      sw.classList.add('seg', 'rec');
      li.append(sw, el('span', '', c.console === 'queued' ? 'A queued recording, hands off' : 'Work in the game, hands on'), el('span', 'mono', rate(c.multiplier)));
      rates.append(li);
    }
    $('rc-note').textContent = !cats.length ? ''
      : (cats.some((c) => c.console === 'queued') ? 'A queued recording is charged on top of anything else, even while you edit. ' : '')
        + 'The Console decides which kind of time it is: only it can tell.';
    $('rc-pill').textContent = linked ? 'Console linked' : 'Console not linked';
    $('rc-pill-dot').className = 'dot ' + (linked && fresh ? 'ok' : 'off');
  }

  // ---------------------------------------------------------------------------
  // Render choices and the hand-in form
  // ---------------------------------------------------------------------------

  function setWhenDone(mode) {
    S.whenDone = mode;
    store.set(KEY.whenDone, mode);
    renderRender();
  }
  $('rd-replace').addEventListener('click', () => setWhenDone('replace'));
  $('rd-just').addEventListener('click', () => setWhenDone('just'));

  const latestRender = () => [...S.renders].reverse().find((r) => r.sha256) || null;

  $('hi-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    say('hi-error', '');
    const pick = latestRender();
    const hqSha256 = pick ? pick.sha256 : (S.submission && S.submission.hqSha256) || null;
    $('hi-go').disabled = true;
    try {
      S.submission = await guarded(() => RelServer.handIn(S.token, S.contestId, { youtube: $('hi-yt').value.trim(), hq: $('hi-hq').value.trim(), hqSha256 }));
      if (pick) {
        for (const x of S.renders) if (x !== pick && x.status === 'handed in') x.status = 'replaced';
        pick.status = 'handed in';
        saveRenders();
      }
      await sendRecord();
      await openSnapshots();
    } catch (e) {
      say('hi-error', e.offline ? 'reluduali.com could not be reached.' : e.message);
    } finally {
      $('hi-go').disabled = false;
      render();
    }
  });

  // ---------------------------------------------------------------------------
  // Sealed snapshots (0.3.0)
  // ---------------------------------------------------------------------------
  //
  // At three moments reluduali.com picks and never says in advance, a check-in's answer asks for a snapshot: { n, nonce,
  // answerBy }. The panel takes a summary of the contest project, makes a random number of its own (the salt), and seals:
  //   seal = HMAC-SHA256(key = the server's nonce, data = salt + "\n" + canonical(summary))
  // It sends only the seal, and keeps the summary and salt here, in its own storage. At hand-in it opens them, and
  // reluduali.com checks each against its seal. The summary is Lumit's own (project.summary: clip counts, lengths and
  // effect names, never a file name, folder or text), once Lumit gives one; until then it is a stand-in: the project's
  // id, and the edit record's length and newest fingerprint. Nothing in either says what you are editing.

  /** JSON with every object's keys in order and no spaces: the same bytes reluduali.com works out from the same summary. */
  function canonical(v) {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('a number that is not finite'); return JSON.stringify(v); }
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    throw new Error(`a ${typeof v} cannot be in a summary`);
  }
  const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
  async function hmacHex(keyHex, text) {
    const key = await crypto.subtle.importKey('raw', fromHex(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  }
  const snapshotsOf = (contestId) => (contestId ? store.json(KEY.snapshots(contestId)) || [] : []);
  const saveSnapshots = (contestId, list) => store.set(KEY.snapshots(contestId), JSON.stringify(list));

  /** The summary sealed: Lumit's own when it has one to give, else the stand-in. */
  async function summaryNow(w) {
    let s = null;
    try { s = await window.lumit.call('project.summary'); } catch {}
    if (s && typeof s === 'object' && !Array.isArray(s)) return s;
    const rec = S.record && S.record.windowId === w.id ? await S.record.state() : null;
    return { standIn: true, id: (S.contestProject && S.contestProject.id) || null, steps: rec ? rec.steps : 0, last: rec ? rec.last : null };
  }

  /** Answers an ask: sealed once (the same seal if it is asked again), sent until reluduali.com has it. */
  async function takeSnapshot(ask, w) {
    const contestId = w.contestId;
    if (!contestId || !Number.isInteger(ask.n) || !/^[0-9a-f]{64}$/.test(ask.nonce || '')) return;
    const list = snapshotsOf(contestId);
    let s = list.find((x) => x.n === ask.n);
    if (!s) {
      const summary = await summaryNow(w);
      const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
      s = { n: ask.n, salt, summary, seal: await hmacHex(ask.nonce, `${salt}\n${canonical(summary)}`), sent: false, at: Date.now() };
      list.push(s);
      saveSnapshots(contestId, list);
    }
    if (s.sent) return;
    try {
      await guarded(() => RelServer.snapshot(S.token, w.id, s.n, s.seal));
      s.sent = true;
    } catch (e) {
      if (e.status === 409) s.sent = true;      // sealed already: an earlier send got there
      else return;                              // not reached: asked again with the next check-in, and sent then
    }
    saveSnapshots(contestId, list);
    S.witnessed.unshift({ at: Date.now(), snapshot: s.n });
  }

  /** At hand-in: every seal reluduali.com has, opened, so it can check each against what it says. */
  async function openSnapshots() {
    const list = snapshotsOf(S.contestId).filter((x) => x.sent);
    if (!list.length) { S.snapshotCheck = null; return; }
    try {
      S.snapshotCheck = await guarded(() => RelServer.openSnapshots(S.token, S.contestId, list.map(({ n, salt, summary }) => ({ n, salt, summary }))));
    } catch (e) {
      S.snapshotCheck = { error: e.offline ? 'reluduali.com could not be reached' : e.message };
    }
  }

  /**
   * The edit record goes with every hand-in. A check-in goes first, so the
   * steps made since the last one are stamped too; then the server checks
   * every window's steps against the fingerprints it stamped.
   */
  async function sendRecord() {
    if (!S.records.length) return;
    if (S.win) { await beat(); scheduleBeat(); }
    try {
      S.recordCheck = await guarded(() => RelServer.editRecord(S.token, S.contestId, S.records));
    } catch (e) {
      S.recordCheck = { error: e.offline ? 'reluduali.com could not be reached' : e.message };
    }
  }

  $('oc-open').addEventListener('click', async () => {
    try { await openWindow(); go('overview'); } catch (e) { say('ct-error', e.message); go('contest'); }
  });
  $('oc-count-this').addEventListener('click', () => {
    S.contestProject = projectOf(S.project);
    saveWindowNote();
    S.ledger?.contestProject(contestProjectOpen(), Date.now());
    render();
  });

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  // A press must not lose its button. In real Lumit, pressing in the panel moves the focus, and Lumit
  // says so (activity.focus) in the middle of the press. A redraw then replaces the button under the
  // mouse, and the browser counts no click: Choose, Enter and Open my window did nothing (Lumit 0.7.0
  // on Windows, 2026-10-14). So while a button is held down a redraw waits, and runs just after the click.
  // A press held longer than a second and a half lets redraws through again, in case its release
  // happened outside the panel.
  const HOLD_MS = 1500;
  let pressedAt = 0, redrawWaiting = false;
  const holding = () => pressedAt > 0 && Date.now() - pressedAt < HOLD_MS;
  document.addEventListener('pointerdown', () => { pressedAt = Date.now(); }, true);
  const released = () => {
    pressedAt = 0;
    if (redrawWaiting) { redrawWaiting = false; setTimeout(render, 0); }
  };
  document.addEventListener('pointerup', released, true);
  document.addEventListener('pointercancel', released, true);

  function render() {
    if (holding()) { redrawWaiting = true; return; }
    if (S.screen === 'signin' || S.screen === 'loading' || !S.user) return;
    setText('who', `Signed in as ${S.user.username}`);
    renderOverview();
    if (S.screen === 'contest') renderContest();
    if (S.screen === 'partner') renderPartner();
    if (S.screen === 'record') renderRecord();
    if (S.screen === 'render') renderRender();
    if (S.screen === 'handin') renderHandIn();
    if (S.screen === 'account') renderAccount();
  }

  function categoryRate(name) {
    const c = S.contest && S.contest.categories.find((x) => x.name === name);
    return c ? c.multiplier : 0;
  }

  /** What the person is doing now, in words, with its colour and rate. */
  function myState(now, over) {
    if (!S.win) {
      if (S.closedElsewhere) return { dot: 'off', what: 'Another timer took over this contest', rate: '' };
      return { dot: 'off', what: S.entry ? 'Your window is not open' : 'Not entered', rate: '' };
    }
    if (over) return { dot: 'over', what: S.contest && S.contest.staticClock ? 'The contest is over' : `Your ${span(S.entry.budgetMs)} are used`, rate: '' };
    const c = S.ledger.current(now);
    switch (c.what) {
      case 'rendering': return { dot: 'rend', what: `Rendering render ${S.rendering ? S.rendering.n : ''}`.trim(), rate: rate(c.rate), state: 'rendering', r: c.rate };
      case 'editing': return { dot: 'edit', what: 'Editing in Lumit', rate: rate(c.rate), state: 'editing', r: c.rate };
      // With no contest project yet (the window opened on a project never saved), the open project is
      // not "another" one: it is waiting to be saved. The old words read as the timer not working.
      case 'not-contest':
        if (S.contestProject) return { dot: 'off', what: 'Another project is open', rate: 'free', state: 'not-contest' };
        if (!S.project.open) return { dot: 'off', what: 'No project is open in Lumit', rate: 'free', state: 'not-contest' };
        // With Lumit's project id (0.7.1), the first edit makes this project the contest's.
        if (S.project.id) return { dot: 'off', what: 'AS SOON AS YOU TOUCH, the timer starts', rate: 'free', state: 'idle', first: true };
        return { dot: 'off', what: 'Your project is not saved yet', rate: 'free', state: 'not-contest' };
      case 'background': return { dot: 'off', what: 'Lumit is behind another program', rate: 'free', state: 'idle' };
      // Before the first edit, the contest's words (2026-10-14): "AS SOON AS YOU TOUCH, the timer starts".
      default: return { dot: 'off', what: c.idleFor === null ? 'AS SOON AS YOU TOUCH, the timer starts' : `Idle for ${Math.max(1, Math.floor(c.idleFor / 60000))} min`, rate: 'free', state: 'idle', first: c.idleFor === null };
    }
  }

  function partnerState(p, now) {
    if (!p) return null;
    if (!p.accepted) return { dot: 'off', what: `${p.username} has not accepted yet`, rate: '', r: 0 };
    const cats = p.doing || [];
    if (cats.length) {
      // Their panel and their Console both count ("charge both"), so their rate is the sum.
      const r = cats.reduce((t, n) => t + categoryRate(n), 0);
      const more = cats.length > 1 ? `, and ${cats.slice(1).join(', ')}` : '';
      return { dot: colourOf(cats[0]), what: `${p.username} ${activityWords(cats[0])}${more}`, rate: rate(r), r };
    }
    if (p.seenAt === null || p.seenAt === undefined) return { dot: 'off', what: `${p.username} has no window open`, rate: '', r: 0 };
    if (now - p.seenAt > 90000) return { dot: 'off', what: `${p.username}: not heard from since ${hm(p.seenAt)}`, rate: '', r: 0 };
    return { dot: 'off', what: `${p.username} is idle`, rate: 'free', r: 0 };
  }

  /** Your own Console, as the server last heard from it. Null when there is nothing to say about it on the clock. */
  function consoleState(now) {
    const me = meIn(S.entry);
    if (!me || !me.consoleLinked || !consoleCats().length) return null;
    const mine = (me.doing || []).filter((n) => consoleCats().some((c) => c.name === n));
    if (mine.length) {
      const r = mine.reduce((t, n) => t + categoryRate(n), 0);
      return { dot: 'rec', what: mine.map(cap).join(' + '), rate: rate(r), r };
    }
    const heard = !!(me.consoleSeenAt && now - me.consoleSeenAt <= 90000);
    return { dot: 'off', what: heard ? 'Linked, not recording' : 'Linked, not heard from', rate: '', r: 0 };
  }

  /** One more person's line on the clock, as #oc-partner is drawn: for the third and fourth in a team. */
  function personRow(label, s) {
    const box = el('div', 'person');
    const now = el('span', 'now');
    const dot = el('span', 'dot ' + (s.dot || 'off'));
    now.append(dot, el('span', 'what', s.what), el('span', 'rate mono', s.rate || ''));
    box.append(el('span', 'lbl', label), now);
    return box;
  }

  function paintPerson(id, label, s) {
    const box = $(id);
    box.querySelector('.lbl').textContent = label;
    box.querySelector('.dot').className = 'dot ' + (s.dot || 'off');
    box.querySelector('.what').textContent = s.what;
    box.querySelector('.rate').textContent = s.rate || '';
  }

  /** The bottom strip's line: the time left and what is spending it. Nothing while no window is open. */
  function statusLine(now) {
    const e = S.entry;
    if (!S.win || !e || !S.ledger) return null;
    S.ledger.advance(now);
    const remaining = e.remainingMs - S.ledger.unsentCharged();
    const c = S.contest;
    const timed = !!(c && c.staticClock);
    const closesIn = c && c.submitBy ? c.submitBy - now : null;
    if (timed && closesIn !== null && closesIn <= 0) return 'the contest is over';
    if (!timed && remaining <= 0) return 'your time is used. You can still hand in';
    const me = myState(now, false);
    const cs = consoleState(now);
    const team = teammatesOf(e).map((m) => partnerState(m, now)).filter(Boolean);
    const teamR = team.reduce((t, s) => t + (s.r || 0), 0);
    const who = [];
    if (me.r) who.push(me.state);   // editing, rendering
    if (cs && cs.r) who.push('recording');
    if (teamR) who.push(team.length > 1 ? 'your team' : 'your partner');
    const r = (me.r || 0) + (cs ? cs.r : 0) + teamR;
    const doing = r ? `${who.join(' + ')} at ${rate(r)}`
      : me.state === 'not-contest' ? (S.contestProject ? 'another project is open, not counting' : 'not counting yet')
      : me.first ? 'AS SOON AS YOU TOUCH, the timer starts'
      : 'paused until you edit';
    const left = timed ? `${countdown(closesIn)} left in the contest` : `${clock(remaining)} left`;
    return `${left} · ${doing}${S.offlineSince ? ' · offline' : ''}`;
  }

  function renderOverview() {
    const now = Date.now();
    if (S.win) S.ledger.advance(now);
    const e = S.entry;
    const c = S.contest;
    const mates = teammatesOf(e);
    const partner = mates[0] || null;
    $('oc-title').textContent = c ? `${c.name} · ${!mates.length ? 'on your own' : mates.length === 1 ? 'team' : `team of ${mates.length + 1}`}` : 'No contest chosen';
    // Two clocks. The contest's own, the same for everyone: plain time to its opening, then to its close.
    // And the weighted one, which is yours: the budget, spent at each kind of work's rate. In an ordinary
    // contest the weighted clock is the big one and the contest's is kept quiet beside it. In a timed
    // contest (a "3HC", 2026-10-16: three hours, the same for everyone) it is the other way round: the contest's clock
    // decides when it is over, and the weighted one counts, small and muted, and ends nothing.
    const opensIn = c && c.opensAt ? c.opensAt - now : 0;
    const closesIn = c && c.submitBy ? c.submitBy - now : null;
    const contestClock = opensIn > 0 ? `opens in ${countdown(opensIn)}` : closesIn === null ? '' : closesIn > 0 ? `closes in ${countdown(closesIn)}` : 'closed';
    const remaining = e ? e.remainingMs - (S.ledger && S.win ? S.ledger.unsentCharged() : 0) : null;
    const timed = !!(c && c.staticClock);
    const over = timed ? closesIn !== null && closesIn <= 0 : remaining !== null && remaining <= 0;
    if (timed) {
      $('oc-clock').textContent = closesIn === null ? '–:––:––' : countdown(opensIn > 0 ? opensIn : Math.max(0, closesIn));
      $('oc-of').textContent = opensIn > 0 ? 'until it opens' : closesIn > 0 ? 'left in the contest' : 'the contest is over';
      $('oc-ends').textContent = remaining === null ? '' : `weighted ${clock(Math.max(0, remaining))} of ${clock(e.budgetMs)}${remaining < 0 ? ` · ${clock(-remaining)} over` : ''}`;
      $('oc-ends').title = 'The weighted clock: your editing time at the rate of each kind of work. In this contest it counts and ends nothing.';
    } else {
      $('oc-clock').textContent = remaining === null ? '–:––:––' : clock(remaining);
      $('oc-of').textContent = e ? `left of ${clock(e.budgetMs)}` : '';
      $('oc-ends').textContent = contestClock;
      $('oc-ends').title = c && c.submitBy ? `closes ${when(c.submitBy)}` : '';
    }
    $('clockcard').classList.toggle('timed', timed);
    $('clockcard').classList.toggle('over', over);
    $('clockcard').classList.toggle('offline', !!(S.win && S.offlineSince));

    // The bar: where the budget went, everyone in the team together.
    const spent = (e && e.spentBy) || {};
    const parts = { rec: 0, edit: 0, rend: 0, other: 0 };
    for (const [name, ms] of Object.entries(spent)) parts[colourOf(name)] += ms;
    const budget = e ? e.budgetMs : 1;
    for (const [k, ms] of Object.entries(parts)) $('oc-bar-' + k).style.width = `${Math.min(100, (100 * ms) / budget)}%`;
    $('oc-bar').setAttribute('aria-label', 'Time spent: ' + Object.entries(spent).map(([n, ms]) => `${n} ${clock(ms)}`).join(', '));

    const me = myState(now, over);
    paintPerson('oc-me', 'You', me);
    const team = mates.map((m) => ({ m, s: partnerState(m, now) }));
    const ps = team.length ? team[0].s : null;
    $('oc-partner').hidden = !ps;
    if (ps) paintPerson('oc-partner', partner.username, ps);
    // The rest of a team of three or four, under the first, the same way.
    const more = clear($('oc-team-more'));
    for (const { m, s } of team.slice(1)) more.append(personRow(m.username, s));
    const teamR = team.reduce((t, x) => t + (x.s.r || 0), 0);
    const cs = consoleState(now);
    $('oc-console').hidden = !cs;
    if (cs) paintPerson('oc-console', 'Your Console', cs);

    // What the budget is going down at now: your panel, your Console and everyone else in the team, all charged.
    const mine = (S.win ? me.r || 0 : 0) + (cs ? cs.r : 0);
    let line = '';
    if (over && timed) line = 'The contest is over.';
    else if (over) line = c && c.submitBy ? `You can still hand in until ${when(c.submitBy)}.` : 'You can still hand in.';
    else if (!S.win && opensIn > 0) line = `The contest opens in ${countdown(opensIn)}. Your window can be opened then.`;
    else if (team.length && (S.win || mine)) {
      const all = mine + teamR;
      const n = 1 + team.length;
      const working = (mine ? 1 : 0) + team.filter((x) => x.s.r).length;
      const who = n === 2 ? (working === 2 ? 'Both working' : 'One of you working') : working === n ? 'All of you working' : working === 1 ? 'One of you working' : `${working} of you working`;
      line = all ? `${who}: shared time runs at ${rate(all)}` : `${n === 2 ? 'Both' : 'All'} idle: nothing is charged`;
    } else if (cs && cs.r) line = `${me.r ? 'Lumit and the Console together' : 'The Console'}: your time runs at ${rate(mine)}`;
    else if (me.state === 'idle' && S.win) line = me.first ? '' : 'Paused. It starts again when you edit.';   // not "paused" before it has ever run
    else if (me.state === 'not-contest') line = S.contestProject ? 'Only the contest project counts. Nothing here is noted.'
      : !S.project.open ? 'Open or start your contest project in Lumit.'
      : 'Nothing counts until you save it once: File ▸ Save in Lumit. That project is then the contest\'s.';
    $('oc-line').textContent = line;

    const w = $('oc-witness');
    w.className = 'wline';
    if (S.win && S.offlineSince) { w.classList.add('warn'); w.textContent = 'Not reaching the server. This time is not witnessed.'; }
    else if (S.win && S.lastBeatOk) { w.classList.add('ok'); w.textContent = `✓ Witnessed by the server · ${S.witnessed.length ? ago(S.lastBeatOk) : 'window opened ' + ago(S.lastBeatOk)}`; }
    else w.textContent = '';
    const p = $('oc-project');
    if (S.win) {
      if (S.share.role === 'guest') p.textContent = mates.length > 1 ? 'Counting: your team\'s shared project' : 'Counting: your partner\'s shared project';
      else if (S.contestProject) p.textContent = contestProjectOpen() ? `Counting: ${contestProjectName()}` : `Only ${contestProjectName()} counts. Another project is open.`;
      else if (S.project.id) p.textContent = 'The project you edit first is the contest\'s.';
      else p.textContent = 'Save your project once, so the timer knows which one is the contest\'s.';
      if (S.reopened) p.textContent += ' · window opened again when this panel started';
    } else p.textContent = '';
    $('oc-fix-project').hidden = !(S.win && S.project.open && (S.project.name || S.project.id) && S.contestProject && !isContestProject(S.project) && S.share.role !== 'guest');
    $('oc-cta').hidden = !!S.win;
    $('oc-open').hidden = !(e && !deadlinePassed() && !notOpenYet());

    // The table: worked, rate, charged, together.
    const rows = clear($('oc-spent-rows'));
    if (c) {
      for (const cat of c.categories) {
        const tr = el('tr');
        const th = el('th');
        th.scope = 'row';
        const name = el('span', 'name');
        const sw = el('span', 'sw');
        sw.classList.add('seg', colourOf(cat.name));
        name.append(sw, document.createTextNode(cat.name[0].toUpperCase() + cat.name.slice(1)));
        th.append(name);
        tr.append(th, el('td', 'mono', clock((e && e.workedBy && e.workedBy[cat.name]) || 0)), el('td', 'mono', rate(cat.multiplier)), el('td', 'mono', clock((e && e.spentBy && e.spentBy[cat.name]) || 0)));
        rows.append(tr);
      }
    }
    $('oc-spent-total').textContent = e ? clock(e.chargedMs) : '';

    // Your entry.
    const s = S.submission;
    const handed = S.renders.find((r) => s && r.sha256 && r.sha256 === s.hqSha256);
    $('oe-what').textContent = s ? (handed ? `Render ${handed.n} is handed in` : 'Handed in') : 'Nothing handed in yet';
    $('oe-detail').textContent = s
      ? `${when(s.updatedAt)} · ${s.witnessed ? 'matches a render the server witnessed' : s.hqSha256 ? 'no render the server witnessed has this fingerprint' : 'no render fingerprint given'}`
      : 'Hand in once you have rendered: a YouTube link and a link to the full-quality file.';

    // Witnessed by the server.
    const list = clear($('ow-list'));
    for (const b of S.witnessed.slice(0, 8)) {
      const li = el('li');
      li.append(el('span', 't', time(b.at)));
      if (b.refused) li.append(el('span', '', b.refused));
      else if (b.snapshot) li.append(el('span', '', `snapshot ${b.snapshot} sealed`), el('span', 'mark-ok', '✓'));
      else if (b.gap) { li.append(el('span', '', `${clock(b.elapsedMs)} not reaching the server`), el('span', 'mark-gap', 'gap')); }
      else { li.append(el('span', '', `check-in ${b.seq} · ${b.doing.length ? b.doing.join(' · ') : 'idle'}`), el('span', 'mark-ok', '✓')); }
      list.append(li);
    }
    if (!S.witnessed.length) list.append(el('li', 'dim', S.win ? 'The first check-in goes out a minute after the window opens.' : 'No window is open.'));
    const steps = S.records.reduce((n, x) => n + x.steps.length, 0);
    $('ow-record').textContent = steps || S.record
      ? `Edit record: ${steps.toLocaleString()} step${steps === 1 ? '' : 's'}${S.record && S.record.last ? ` · last fingerprint ${short(S.record.last)}` : ''}`
      : '';
  }

  function renderContest() {
    const c = S.contest;
    $('ct-name').textContent = c ? c.name : 'Contests';
    $('ct-facts').textContent = c
      ? [`${span(c.budgetMinutes * 60000)} to edit`, c.submitBy ? `hand in by ${when(c.submitBy)}` : null, `${c.entries} entered`].filter(Boolean).join(' · ')
      : 'Choose the contest you are editing for.';
    $('ct-org').textContent = c && c.organizer ? `Run by ${c.organizer}` : '';

    const list = clear($('ct-list'));
    for (const x of S.contests) {
      const li = el('li');
      const what = el('span', 'what');
      what.append(el('span', '', x.name), el('span', 'note', [x.submitBy ? `hand in by ${when(x.submitBy)}` : 'no deadline', `${x.entries} entered`].join(' · ')));
      const asked = S.invitations.find((i) => i.contestId === x.id);
      if (asked) what.append(el('span', 'note ok', `${askersOf(asked)} invited you to edit this one together`));
      // Choosing asks reluduali.com for your entry first. It says it is working, and a failure is
      // said beside the list (ct-error is inside the contest's details, hidden until one is chosen).
      const pick = button('Choose', 'btn', async () => {
        say('ct-pick-error', '');
        pick.disabled = true;
        pick.textContent = 'Choosing…';
        try {
          await chooseContest(x.id);
          go('contest');
        } catch (e) {
          say('ct-pick-error', `${x.name} could not be chosen: ${e.message}`);
          pick.disabled = false;
          pick.textContent = 'Choose';
        }
      });
      li.append(what, x.id === S.contestId ? el('span', 'sub ok', 'chosen') : pick);
      list.append(li);
    }
    $('ct-none').hidden = S.contests.length > 0;
    $('ct-detail').hidden = !c;
    if (!c) return;

    const rates = clear($('ct-rates'));
    for (const cat of c.categories) {
      const li = el('li');
      const sw = el('span', 'sw');
      sw.classList.add('seg', colourOf(cat.name));
      li.append(sw, el('span', '', cat.name[0].toUpperCase() + cat.name.slice(1)), el('span', 'mono', rate(cat.multiplier)));
      rates.append(li);
    }
    const free = el('li');
    const sw = el('span', 'sw');
    sw.classList.add('seg', 'other');
    free.append(sw, el('span', '', `Anything else, or idle for ${minutes(c.idleMinutes)}`), el('span', 'mono', 'free'));
    rates.append(free);

    const { editing, rendering } = RelClock.lumitCategories(c);
    const cons = c.categories.filter((x) => x.console);
    const consoleWords = cons.length
      ? `The Reluduali Console times ${cons.map((x) => `${x.console === 'queued' ? 'queued recording' : 'in-game work'} at ${rate(x.multiplier)}`).join(' and ')}, on top of anything else: link it on the Record page.`
      : 'Recording is not timed in this contest.';
    $('ct-lumit').textContent = editing
      ? `Editing in Lumit counts as ${editing.name}, at ${rate(editing.multiplier)}, while Lumit is in front and you edited in the last ${c.idleMinutes === 1 ? 'minute' : minutes(c.idleMinutes)}. `
        + (rendering ? `An export counts as ${rendering.name}, at ${rate(rendering.multiplier)}. ` : 'Exports are not charged in this contest. ')
        + consoleWords
      : 'This contest does not list Lumit (lumit.exe) among its programs, so this panel cannot time it. Use the Reluduali Timer for it.';

    const body = clear($('ct-enter-body'));
    if (S.joined && S.joined.contestId === c.id) body.append(el('p', 'note ok', S.joined.words));
    const invitation = S.invitations.find((i) => i.contestId === c.id);
    const who = invitation ? askersOf(invitation) : 'A friend';
    if (!S.entry && invitation) {
      body.append(el('p', '', `${who} invited you to edit this contest together, on one shared budget.`));
      if (invitation.refusal) body.append(el('p', 'note', `It can't be accepted now: ${invitation.refusal}.`));
      else { body.append(el('div', 'row')); body.lastChild.append(button('Accept', 'btn pri', () => accept(invitation))); }
      return;
    }
    // Entered on your own, and a friend asks: you can still join them (2026-10-18).
    if (S.entry && invitation) body.append(joinOffer(invitation, who));
    if (!S.entry) {
      const choice = el('div', 'choice');
      const alone = el('button', 'opt');
      alone.type = 'button';
      const withFriend = el('button', 'opt');
      withFriend.type = 'button';
      const pick = el('select', 'in');
      pick.id = 'ct-friend';
      pick.setAttribute('aria-label', 'Your partner');
      for (const f of S.friends) { const o = el('option', '', f.username); o.value = f.username; pick.append(o); }
      let mode = 'alone';
      const paint = () => {
        alone.setAttribute('aria-pressed', String(mode === 'alone'));
        withFriend.setAttribute('aria-pressed', String(mode === 'friend'));
        pick.disabled = mode !== 'friend';
      };
      const opt = (b, t, d) => { const ring = el('span', 'ring'); const txt = el('span'); txt.append(el('span', 'opt-t', t), el('span', 'opt-d', d)); b.append(ring, txt); };
      opt(alone, 'On my own', `${span(c.budgetMinutes * 60000)}, yours alone`);
      opt(withFriend, 'With a friend', S.friends.length ? 'One shared budget. They must accept. Ask more on the Partner page: a team is up to four.' : 'You have no Reluduali friends yet. Add them on the Partner page, or on reluduali.com.');
      alone.addEventListener('click', () => { mode = 'alone'; paint(); });
      withFriend.addEventListener('click', () => { if (S.friends.length) { mode = 'friend'; paint(); } });
      choice.append(alone, withFriend);
      paint();
      const row = el('div', 'row');
      row.append(button('Enter', 'btn pri', () => enter(mode === 'friend' ? pick.value : null)));
      if (S.friends.length) { const label = el('label', '', 'Partner'); label.htmlFor = 'ct-friend'; row.append(label, pick); }
      body.append(choice, row);
      return;
    }
    const asked = teammatesOf(S.entry).filter((m) => !m.accepted);
    if (asked.length) {
      body.append(el('p', '', `You entered with ${namesOf(asked)}. Waiting for them to accept; until then, you can still open your window.`));
    }
    if (deadlinePassed()) { body.append(el('p', 'note', 'The deadline has passed. No new window can be opened.')); return; }
    if (notOpenYet()) { body.append(el('p', 'note', `The contest opens ${when(S.contest.opensAt)}. Your window can be opened then.`)); return; }
    if (S.win) {
      const row = el('div', 'row');
      row.append(el('span', '', 'Your window is open.'), button('Go to the timer', 'btn pri', () => go('overview')));
      body.append(row);
      return;
    }
    const row = el('div', 'row');
    row.append(button('Open my window', 'btn pri', async () => {
      try { await openWindow(); go('overview'); } catch (e) { say('ct-error', e.message); }
    }));
    body.append(row, el('p', 'note', S.project.open && S.project.name
      ? `Your clock starts, and edits count only in the project that is open now: ${S.project.name}. You can't pause the window, but idle time is free.`
      : 'Open your contest project in Lumit and save it once first: edits count only in the project that is open when your window opens. You can\'t pause the window, but idle time is free.'));
  }

  /**
   * An invitation for someone who has entered on their own: what joining does, in plain words, then a second press
   * to say yes. What it says of your time and demos is reluduali.com's own count (`joining`), read with the list.
   */
  function joinOffer(inv, who) {
    const box = el('div', 'offer');
    box.append(el('p', '', `${who} invited you to edit this contest together. You entered on your own, and you can still join them.`));
    if (inv.refusal) { box.append(el('p', 'note', `You can't join now: ${inv.refusal}.`)); return box; }
    const j = inv.joining || { timeMs: 0, demos: 0, price: 0, butterBack: 0 };
    const lines = el('ul');
    lines.append(el('li', '', j.timeMs
      ? `The ${clock(j.timeMs)} of contest time you have used so far joins the team's. From then on you share one budget.`
      : 'You have used none of your contest time yet. From then on you share one budget.'));
    if (j.demos) {
      lines.append(el('li', '', `Your ${j.demos === 1 ? 'must-use demo comes' : `${j.demos} must-use demos come`} back for their full price${j.butterBack ? `, and the ${j.butterBack} Butter you paid comes back to you` : ''}. The team chooses its demos together, from one budget.`));
    }
    if (S.win) lines.append(el('li', '', 'Your window closes and opens again at once, on the team\'s entry. Nothing you counted is lost.'));
    lines.append(el('li', '', `Once you join, you and ${who} are one entry for this contest.`));
    const row = el('div', 'row');
    if (S.joinArmed === inv.entryId) {
      row.append(button(`Yes, join ${who}`, 'btn pri', () => accept(inv)), button('Not now', 'btn', () => { S.joinArmed = null; render(); }));
    } else {
      row.append(button(`Join ${who}`, 'btn pri', () => { S.joinArmed = inv.entryId; render(); }));
    }
    box.append(lines, row);
    return box;
  }

  function renderPartner() {
    const e = S.entry;
    const mates = teammatesOf(e);
    const accepted = mates.filter((m) => m.accepted);
    const asked = mates.filter((m) => !m.accepted);
    const p = mates[0] || null;
    $('pt-initial').textContent = !p ? '?' : mates.length > 1 ? `+${mates.length}` : p.username[0].toUpperCase();
    $('pt-names').textContent = p ? inWords(['You', ...mates.map((m) => m.username)]) : e ? 'Just you' : 'Not entered yet';
    // Up to four in a team, counting those asked who have not said yes yet: reluduali.com counts the same way.
    const canAsk = !!(e && e.members.length < TEAM_MAX && !deadlinePassed());
    const room = e ? TEAM_MAX - e.members.length : 0;
    $('pt-note').textContent = !e ? 'Choose a partner when you enter, on the Contest page. After you enter, you can ask more here: a team is up to four.'
      : !p ? (canAsk ? 'You entered on your own. You can still ask a friend, below, and up to three: each who says yes shares your one budget.' : 'You entered on your own.')
      : mates.length === 1 && !canAsk ? (p.accepted ? (p.seenAt ? 'accepted · their window is open' : 'accepted') : 'invited · waiting for them to accept')
      : mates.length === 1 ? `${p.accepted ? (p.seenAt ? 'accepted · their window is open' : 'accepted') : 'invited · waiting for them to accept'} · you can ask ${room === 1 ? 'one more friend' : `${room} more friends`}`
      : [accepted.length ? `in your team: ${namesOf(accepted)}` : '', asked.length ? `asked, waiting for them to accept: ${namesOf(asked)}` : '',
        canAsk ? `you can ask ${room === 1 ? 'one more friend' : `${room} more friends`}` : ''].filter(Boolean).join(' · ');
    const status = $('pt-share-status');
    const actions = clear($('pt-actions'));
    const lines = [];
    if (asked.length === 1) lines.push(`You asked ${asked[0].username}. Until they say yes, you can take it back and ask someone else.`);
    else if (asked.length) lines.push(`You asked ${namesOf(asked)}. Until each says yes, you can take their invitation back.`);
    for (const w of asked) actions.append(button(asked.length === 1 ? 'Take back the invitation' : `Take back the invitation to ${w.username}`, 'btn', () => takeBack(w.username)));
    if (teamReady()) {
      const waiting = e.share && e.share.setBy !== S.user.id ? e.share : null;
      const nameOf = (id) => (e.members.find((m) => m.id === id) || {}).username || namesOf(accepted);
      const people = (S.share.people || []).map((x) => x.name + (x.me ? ' (you)' : '')).join(', ');
      if (S.share.role === 'host') {
        lines.push(`You are hosting the shared project${people ? ': ' + people : ''}. Footage is matched on each PC; what is missing is sent as a stand-in, encrypted.`);
        actions.append(button(S.linkSent ? 'Send the link again' : `Send the link to ${namesOf(accepted)}`, 'btn', sendLink), button('Stop sharing', 'btn', stopSharing));
      } else if (S.share.role === 'guest') {
        const host = e.share ? nameOf(e.share.setBy) : namesOf(accepted);
        lines.push(`You are in ${host}'s shared project${S.share.away ? ', and their PC is out of reach: your edits wait and are merged when they are back' : ''}.`);
        actions.append(button('Leave', 'btn', stopSharing));
      } else if (waiting) {
        lines.push(`${nameOf(waiting.setBy)} is sharing their project with you (${ago(waiting.setAt)}).`);
        actions.append(button(`Join ${nameOf(waiting.setBy)}'s project`, 'btn pri', joinPartner));
      } else {
        lines.push(accepted.length === 1 ? 'One of you hosts the project; the other joins it. Whoever hosts keeps the saved project.'
          : 'One of you hosts the project; the others join it. Whoever hosts keeps the saved project.');
        actions.append(button('Share this project', 'btn pri', shareProject));
      }
    }
    status.textContent = lines.join(' ');
    const rates = clear($('pt-rates'));
    if (S.contest) {
      const { editing } = RelClock.lumitCategories(S.contest);
      const inGame = S.contest.categories.find((x) => x.console === 'in-game') || S.contest.categories.find((x) => !x.console && /record/i.test(x.name));
      const queued = S.contest.categories.find((x) => x.console === 'queued');
      const ed = editing ? editing.multiplier : 1;
      const rows = [['One of you editing', rate(ed)]];
      if (inGame) rows.push([inGame.console ? 'One editing, one in the game' : 'One editing, one recording', rate(ed + inGame.multiplier)]);
      // As many people as the team has (with those asked), each editing adding the rate again.
      const size = Math.max(2, e ? e.members.length : 2);
      if (size === 2) rows.push(['Both editing', rate(ed * 2)]);
      else for (let k = 2; k <= size; k++) rows.push([k === size ? `All ${k} editing` : `${k} of you editing`, rate(ed * k)]);
      if (queued) rows.push(['A queued recording, on top of any of these', '+' + rate(queued.multiplier)]);
      rows.push([size === 2 ? 'Both idle' : 'All idle', 'free']);
      for (const [t, r] of rows) { const li = el('li'); li.append(el('span'), el('span', '', t), el('span', 'mono', r)); rates.append(li); }
    }
    const friends = clear($('pt-friends'));
    for (const f of S.friends) {
      const li = el('li');
      li.append(el('span', 'av', f.username[0].toUpperCase()), el('span', 'what', f.username));
      const mate = mates.find((m) => m.id === f.id);
      if (mate) li.append(el('span', 'sub ok', !mate.accepted ? 'invited' : mates.length === 1 ? 'partner' : 'in your team'));
      else if (canAsk) li.append(button('Ask to edit together', 'btn', () => invite(f.username)));
      friends.append(li);
    }
    if (!S.friends.length) friends.append(el('li', 'dim', 'No Reluduali friends yet. Send a request below, or on reluduali.com.'));
    // Friend requests: the ones sent to you, to say yes to here; the ones you sent, waiting.
    const requests = clear($('pt-requests'));
    for (const r of S.requests.incoming || []) {
      const li = el('li');
      const what = el('span', 'what');
      what.append(el('span', '', r.username), el('span', 'note', 'wants to be your Reluduali friend'));
      li.append(el('span', 'av', r.username[0].toUpperCase()), what, button('Accept', 'btn pri', () => acceptFriend(r)));
      requests.append(li);
    }
    for (const r of S.requests.outgoing || []) {
      const li = el('li');
      const what = el('span', 'what');
      what.append(el('span', '', r.username), el('span', 'note', 'asked · waiting for them to say yes'));
      li.append(el('span', 'av', r.username[0].toUpperCase()), what);
      requests.append(li);
    }
    requests.hidden = !requests.firstChild;
    say('pt-add-note', S.friendNote || '');
  }

  function renderRecord() {
    renderConsoleCard();
    $('rc-folder').textContent = S.watched || 'No folder is watched';
    $('rc-watch').textContent = S.watched ? 'Watch another folder' : 'Watch a folder';
    $('rc-unwatch').hidden = !S.watched;
    const list = clear($('rc-list'));
    for (const f of S.imported.slice(0, 30)) {
      const li = el('li');
      li.append(el('span', 'mono t', time(f.at)), el('span', 'what', f.path.split(/[\\/]/).pop()));
      list.append(li);
    }
    $('rc-empty').hidden = S.imported.length > 0;
  }

  function renderRender() {
    $('rd-replace').setAttribute('aria-pressed', String(S.whenDone === 'replace'));
    $('rd-just').setAttribute('aria-pressed', String(S.whenDone === 'just'));
    $('rd-replace-d').textContent = S.submission
      ? 'The new render takes the place of your hand-in. Your links stay, and the organizer sees the new fingerprint, so upload the new file to your link too. Until the deadline you can replace it as often as you like.'
      : 'Nothing is handed in yet, so the new render waits for the Hand in page.';
    const rendering = S.ledger && S.ledger.rendering;
    $('rd-sub').textContent = rendering
      ? `Lumit's own export, watched by this panel: ${rate(rendering.multiplier)} while it renders, fingerprinted when it is done`
      : 'Lumit\'s own export, watched by this panel: fingerprinted when it is done';
    const live = S.exportState && S.exportState.state === 'running';
    $('rd-live').hidden = !live;
    if (live) {
      const { frame = 0, total = 0 } = S.exportState;
      $('rd-live-h').textContent = `Rendering${rendering ? ' · ' + rate(rendering.multiplier) : ''}`;
      $('rd-live-bar').style.width = total ? `${Math.min(100, (100 * frame) / total)}%` : '0%';
      $('rd-live-frames').textContent = `frame ${frame} of ${total || '?'}`;
      $('rd-live-timed').textContent = S.rendering && S.rendering.serverId ? 'the server is timing this render' : S.win ? 'telling the server…' : 'not timed: no window is open';
      if (S.rendering && total && frame) {
        const left = ((Date.now() - S.rendering.startedAt) / frame) * (total - frame);
        $('rd-live-left').textContent = `about ${Math.max(1, Math.round(left / 60000))} min left`;
      } else $('rd-live-left').textContent = '';
    }
    const body = clear($('rd-list'));
    for (const r of [...S.renders].reverse().slice(0, 8)) {
      const tr = el('tr');
      tr.append(el('td', '', String(r.n)), el('td', 'mono', when(r.finishedAt)), el('td', 'mono', short(r.sha256)),
        el('td', r.status === 'handed in' ? 'st-in' : 'st-other', r.status + (r.witnessed ? '' : ' · not witnessed')));
      body.append(tr);
    }
    $('rd-empty').hidden = S.renders.length > 0;
  }

  function renderHandIn() {
    const c = S.contest;
    const s = S.submission;
    const n = teammatesOf(S.entry).length;
    $('hi-sub').textContent = c && c.submitBy ? `${!n ? 'You' : n === 1 ? 'Either of you' : 'Anyone in your team'} can update it until ${when(c.submitBy)}` : '';
    const handed = s ? S.renders.find((r) => r.sha256 && r.sha256 === s.hqSha256) : null;
    $('hi-latest').textContent = handed ? `Render ${handed.n} · ${when(s.updatedAt)}` : '';
    if (s && document.activeElement !== $('hi-yt') && !$('hi-yt').value) $('hi-yt').value = s.youtube;
    if (s && document.activeElement !== $('hi-hq') && !$('hi-hq').value) $('hi-hq').value = s.hq;
    $('hi-go').textContent = s ? 'Update my entry' : 'Hand in';
    const pick = latestRender();
    $('hi-render').textContent = pick
      ? `With it goes the fingerprint of render ${pick.n} (${short(pick.sha256)}), so the organizer can check that the file at your link is that render.`
      : 'Render in Lumit first, and its fingerprint goes with your entry.';
    const checks = clear($('hi-checks'));
    const add = (ok, text) => { const li = el('li', ok ? '' : 'pending'); li.append(el('span', ok ? 'tick' : 'open', ok ? '✓' : '○'), el('span', '', text)); checks.append(li); };
    if (!S.entry) { add(false, 'Enter the contest first, on the Contest page.'); return; }
    add(!!s, s ? `Handed in · ${when(s.updatedAt)}` : 'Not handed in yet');
    add(!!(s && s.witnessed), s && s.witnessed
      ? `The file's fingerprint matches a render the server timed: ${clock(s.witnessed.witnessedMs)} long, finished ${when(s.witnessed.endedAt)}`
      : 'No render the server timed has this file\'s fingerprint yet');
    add(true, `Time used: ${clock(S.entry.chargedMs)} of ${clock(S.entry.budgetMs)}`);
    const kept = (meIn(S.entry) || {}).record || null;
    const rc = S.recordCheck;
    if (rc && rc.error) add(false, `Your edit record was not checked: ${rc.error}`);
    else if (rc && !rc.ok) add(false, `Your edit record does not match what the server stamped: ${rc.problems[0].message}`);
    else if (!rc && kept && !kept.ok) add(false, 'Your edit record, as last handed in, did not match what the server stamped. Hand in again from this PC');
    else if (rc || kept) {
      const f = rc ? rc.facts : kept;
      add(true, `Your edit record: ${f.steps.toLocaleString()} step${f.steps === 1 ? '' : 's'}, matching all ${f.stamps} fingerprint${f.stamps === 1 ? '' : 's'} the server stamped${f.unstamped ? ` (${f.unstamped} after the last check-in)` : ''}`);
    } else add(false, 'Your edit record goes with the hand-in: step names and times, checked against what the server stamped');
    const sc = S.snapshotCheck;
    if (sc && sc.error) add(false, `Your snapshots were not opened: ${sc.error}`);
    else if (sc && sc.results) {
      const matched = sc.results.filter((x) => x.verdict === 'match').length;
      add(matched === sc.results.length, `Your snapshots: ${matched} of ${sc.results.length} opened and matching their seals`);
    }
    add(false, 'At judging, the organizer checks the file at your link against its fingerprint');
  }

  function renderAccount() {
    $('ac-who').textContent = `Signed in as ${S.user.username}`;
    const installed = S.info && S.info.extension && S.info.extension.version;   // what Lumit installed, from extension.json
    $('ac-versions').textContent = `Reluduali panel ${installed || VERSION}${S.info ? ` · Lumit ${S.info.lumit} · extension API ${S.info.api}` : ''}`;
    const list = clear($('ac-sent'));
    for (const m of S.sent.slice(-80).reverse()) {
      const li = el('li');
      li.append(el('span', 't', time(m.at)), el('span', '', `${m.method} reluduali.com${m.path} → ${m.status}`));
      list.append(li);
    }
  }

  // ---------------------------------------------------------------------------
  // Starting
  // ---------------------------------------------------------------------------

  RelServer.onSent = (m) => {
    S.sent.push(m);
    if (S.sent.length > 300) S.sent.splice(0, S.sent.length - 300);
    if (S.screen === 'account') renderAccount();
  };

  async function start() {
    const lumit = window.lumit;
    try { S.info = await lumit.call('app.info'); } catch {}
    lumit.on('project.changed', onProject);
    lumit.on('activity.edit', onEdit);
    lumit.on('activity.focus', onFocus);
    lumit.on('export.started', onExportStarted);
    lumit.on('export.progress', onExportProgress);
    lumit.on('export.finished', onExportFinished);
    lumit.on('export.failed', onExportFailed);
    lumit.on('import.added', (f) => { if (f && f.path) { S.imported.unshift({ path: f.path, at: Date.now() }); renderRecord(); } });
    lumit.on('share.changed', onShare);
    try { S.project = await lumit.call('project.info'); } catch {}
    try { S.share = await lumit.call('share.state'); } catch {}
    try { S.exportState = await lumit.call('export.state'); } catch {}
    const watched = store.get(KEY.watched);
    if (watched) watch(watched);

    S.token = store.get(KEY.token);
    if (S.token) {
      try {
        S.user = await RelServer.me(S.token);
        await afterSignIn();
      } catch (e) {
        if (e.status === 401) { store.del(KEY.token); S.token = null; go('signin'); }
        else { S.user = null; go('signin'); say('signin-error', e.offline ? 'reluduali.com could not be reached. You are still signed in; this panel will try again when you sign in.' : e.message); }
      }
    } else {
      go('signin');
    }
    setInterval(() => { if (S.screen === 'overview' || S.screen === 'render') render(); }, 1000);
    // Every second on every screen, and while a press holds the panel's own redraws back.
    setInterval(() => setStatus(statusLine(Date.now())), 1000);
    // The lists again every minute while the Contest or Partner screen shows.
    setInterval(() => { if (listsShown()) readLists(); }, 60000);
    $('ct-refresh').addEventListener('click', async () => {
      const b = $('ct-refresh');
      b.disabled = true; b.textContent = 'Reading…';
      try { await readLists(); } finally { b.disabled = false; b.textContent = 'Refresh'; }
    });
    setInterval(() => { if (S.win && S.contestId) refreshEntry(); }, 5 * 60000);
  }

  go('loading');
  let started = false;
  const begin = () => { if (!started) { started = true; start(); } };
  if (window.lumit) begin(); else window.addEventListener('lumitready', begin);
  setTimeout(() => { if (!window.lumit) { $('nolumit').hidden = false; $('loading-note').textContent = 'This panel works only inside Lumit.'; } }, 4000);
})();
