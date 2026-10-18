// EVERYTHING THIS PANEL EVER SENDS is one of the requests below, and nothing
// else. The README lists them in plain words, and lumit/check.mjs fails if
// the panel sends anything that is not on its own copy of that list.
//
// Each one goes through Lumit (`net.fetch`), which lets this panel reach
// reluduali.com and no other site. The page itself may not open any
// connection at all: the first line of index.html forbids it, and the
// browser inside Lumit enforces that, not this file.
//
// What comes back is reluduali.com's answer. A refusal comes back with the
// server's own reason, in its own words.
(function (root) {
  'use strict';

  const SERVER = 'https://reluduali.com';
  const id = (s) => encodeURIComponent(String(s));

  /** For the panel's own list of what it sent: where each request went and what came back. Never what it carried. */
  function tell(method, path, status) {
    const listener = root.RelServer && root.RelServer.onSent;
    if (listener) try { listener({ at: Date.now(), method, path, status }); } catch {}
  }

  async function send(method, path, body, token) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = 'Bearer ' + token;
    const request = { url: SERVER + path, method, headers };
    if (body !== undefined) request.body = JSON.stringify(body);
    let answer;
    try {
      // Lumit gives up on its own after 15 s to connect and 30 s to answer. An answer that never
      // comes back to the page would leave it waiting for ever, so it stops waiting after a minute.
      answer = await Promise.race([
        root.lumit.call('net.fetch', request),
        new Promise((_, no) => setTimeout(() => no(Object.assign(new Error('no answer'), { code: 'timeout' })), 60000)),
      ]);
    } catch (cause) {
      tell(method, path, 'not reached');
      const e = new Error(cause && cause.code === 'timeout' ? 'Lumit passed on no answer from reluduali.com within a minute' : 'reluduali.com could not be reached');
      e.offline = true;
      e.cause = cause;
      throw e;
    }
    tell(method, path, answer.status);
    let data = null;
    try { data = answer.body ? JSON.parse(answer.body) : null; } catch { data = null; }
    if (answer.status < 200 || answer.status >= 300) {
      const e = new Error((data && data.error) || `reluduali.com answered ${answer.status}`);
      e.status = answer.status;
      throw e;
    }
    return data;
  }

  root.RelServer = {
    // Signing in: your Reluduali username and password, once. What comes back
    // is a token that stands for this sign-in; the password is not kept.
    signIn: (username, password) => send('POST', '/api/auth/token', { username, password }),
    signOut: (token) => send('POST', '/api/auth/logout', {}, token),
    me: (token) => send('GET', '/api/auth/me', undefined, token),

    // Contests: their rules are public. Your entry, your invitations and your
    // friends are yours alone; the server answers only about you.
    contests: (token) => send('GET', '/api/contests', undefined, token),
    entry: (token, contestId) => send('GET', `/api/contests/${id(contestId)}/entry`, undefined, token),
    enter: (token, contestId, partner) => send('POST', `/api/contests/${id(contestId)}/enter`, partner ? { partner } : {}, token),
    invitations: (token) => send('GET', '/api/contests/invitations', undefined, token),
    // Saying yes to a friend's invitation. If you had entered on your own, your entry joins theirs: the time you
    // used counts in your one shared budget, and your must-use demos go back for their full price.
    acceptInvitation: (token, contestId, entryId) => send('POST', `/api/contests/${id(contestId)}/join/${id(entryId)}`, {}, token),
    // Asking a friend to be your partner after you entered on your own, by name; and taking that back.
    invite: (token, contestId, partner) => send('POST', `/api/contests/${id(contestId)}/invite`, { partner }, token),
    takeBackInvitation: (token, contestId) => send('DELETE', `/api/contests/${id(contestId)}/invite`, undefined, token),

    // Your friends, and friend requests: a request to the name you type, and saying yes to one sent to you.
    friends: (token) => send('GET', '/api/friends', undefined, token),
    friendRequests: (token) => send('GET', '/api/friends/requests', undefined, token),
    askFriend: (token, username) => send('POST', '/api/friends', { username }, token),
    acceptFriend: (token, userId) => send('POST', `/api/friends/requests/${id(userId)}/accept`, {}, token),

    // Your window: opening it, the check-in about once a minute, and each
    // render as it happens. A check-in carries only how long each category
    // counted and what that charged, and your edit record's length and newest
    // fingerprint; a render, only the finished file's fingerprint and size.
    // Never the edit, the file, its name or where it is.
    openWindow: (token, contestId) => send('POST', '/api/timer/windows', { contestId }, token),
    beat: (token, windowId, { seq, nonce, segments, signature, record }) =>
      send('POST', `/api/timer/windows/${id(windowId)}/beat`, record ? { seq, nonce, segments, signature, record: { steps: record.steps, last: record.last } } : { seq, nonce, segments, signature }, token),
    renderStarted: (token, windowId) => send('POST', `/api/timer/windows/${id(windowId)}/render`, { phase: 'start' }, token),
    renderDone: (token, windowId, renderId, sha256, bytes) =>
      send('POST', `/api/timer/windows/${id(windowId)}/render`, { phase: 'done', renderId, sha256, bytes }, token),
    renderStopped: (token, windowId, renderId) => send('POST', `/api/timer/windows/${id(windowId)}/render`, { phase: 'stopped', renderId }, token),
    windowState: (token, windowId) => send('GET', `/api/timer/windows/${id(windowId)}`, undefined, token),

    // Handing in: the links you type, and the fingerprint of the render you choose.
    submission: (token, contestId) => send('GET', `/api/contests/${id(contestId)}/submission`, undefined, token),
    handIn: (token, contestId, { youtube, hq, hqSha256 }) =>
      send('POST', `/api/contests/${id(contestId)}/submission`, hqSha256 ? { youtube, hq, hqSha256 } : { youtube, hq }, token),
    // With the hand-in, your edit record: each step's name and time, window by
    // window, for the server to check against the fingerprints it stamped.
    // Only the names Lumit gave the steps ("Add layer", "Set keyframe"), never
    // what they did.
    editRecord: (token, contestId, windows) =>
      send('POST', `/api/contests/${id(contestId)}/edit-record`, { windows: windows.map((w) => ({ id: w.id, steps: w.steps })) }, token),

    // Linking the Reluduali Console: a one-time code for you to type into it,
    // and ending the link. The Console then reports its own time to
    // reluduali.com; this panel never talks to it.
    consoleCode: (token, contestId) => send('POST', `/api/contests/${id(contestId)}/console-code`, {}, token),
    unlinkConsole: (token, contestId) => send('DELETE', `/api/contests/${id(contestId)}/console`, undefined, token),

    // Your partner: the Lumit invite link to your shared project, left for
    // them and only them, and taken back when you stop sharing.
    shareLink: (token, contestId) => send('GET', `/api/contests/${id(contestId)}/share`, undefined, token),
    leaveShareLink: (token, contestId, link) => send('POST', `/api/contests/${id(contestId)}/share`, { link }, token),
    takeBackShareLink: (token, contestId) => send('DELETE', `/api/contests/${id(contestId)}/share`, undefined, token),
  };
})(typeof window !== 'undefined' ? window : globalThis);
