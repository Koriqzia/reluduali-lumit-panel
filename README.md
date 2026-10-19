# The Reluduali panel for Lumit

**The Reluduali contest clock, as a panel inside Lumit. Version 0.3.0.**

Reluduali runs editing contests. Each entrant gets the same amount of editing
time. This panel is the clock that keeps that time. It sits inside Lumit, the
video editor, next to Lumit's own panels.

Small, it shows the clock. Made bigger, it shows the contest, your partner,
your renders and your hand-in.

It talks to **reluduali.com and to no other site**. Below is everything it
sends, everything it keeps, and how you can check each of those things
yourself.

## Contents

- [What it counts](#what-it-counts)
- [What it never counts](#what-it-never-counts)
- [What it sends, and to where: the complete list](#what-it-sends-and-to-where-the-complete-list)
- [What it never sends](#what-it-never-sends)
- [What it hears from Lumit](#what-it-hears-from-lumit)
- [What it cannot do](#what-it-cannot-do)
- [What it keeps on your PC](#what-it-keeps-on-your-pc)
- [How to check all of this yourself](#how-to-check-all-of-this-yourself)
- [Installing it](#installing-it)
- [Checking that your download is this one](#checking-that-your-download-is-this-one)
- [Signing in](#signing-in)
- [Removing it](#removing-it)
- [The checks it comes with](#the-checks-it-comes-with)
- [Versions](#versions)
- [For people who build software](#for-people-who-build-software)
- [Licence](#licence)

## What it counts

| | it counts when | at |
|---|---|---|
| **Editing** | Lumit is the window in front, your contest project is open, and you made an edit in the last few minutes (the contest says how many) | the contest's editing rate |
| **Rendering** | Lumit is exporting. This counts even with nobody at the keyboard | the contest's rendering rate, which is usually much lower |
| **Anything else** | another program is in front, another project is open, or you made no edit for those few minutes | **free: it is not counted** |

- **The clock starts on your first edit**, not when you open the panel.
- **Switch to another program** and it stops counting at once.
- **Stop editing** and it stops when those few minutes run out.
- **Only the contest project counts.** That is the project that was open when
  your window opened. If that project was never saved, it is the first one
  you edit.
- **Save it under a new name, rename it or move it, and it still counts.**
  Lumit gives every project an id that stays with it, and the panel follows
  that id. A different project with the same file name does not count.
- **Lumit's bottom strip** shows the clock even while the panel is hidden
  behind another panel. For example: *Reluduali: 2:41:07 left · editing at
  1.0×*.
- **If your PC freezes or sleeps during a render**, it stops counting 15
  seconds after Lumit last reported the render.
- **A timed contest** (the same few hours for everyone) shows the contest's
  own countdown large. Your weighted clock still counts, small and grey, and
  ends nothing.
- **No window opens** before a contest opens or after it closes.

**Recording is not counted by this panel.** That is the job of a separate
program, the Reluduali Console. Lumit gives a panel no way to start another
program or talk to one, so this panel never talks to the Console. If you use
the Console, you link it once: on the panel's *Record* page, press
**Link the Console** and type the code it shows into the Console. The Console
then tells reluduali.com about its own time.

## What it never counts

- Time in any other program.
- Time in any other Lumit project. Other projects are not counted and not
  even noted.
- Time when you are not editing, past those few minutes.
- What you edit. The panel never sees your footage, your pictures or your
  screen.

## What it sends, and to where: the complete list

Everything goes to **https://reluduali.com**, and nowhere else.

Every request below is in one short file, `reluduali/server.js`. It is the
panel's only network code. There is nothing else.

Every request except signing in also carries your sign-in **token**: a long
random code that reluduali.com gave the panel when you signed in. It stands
for your sign-in, so you do not send your password again.

Like any website, reluduali.com can see the internet address a request comes
from. That is how the internet works, and no program can avoid it.

| when | where (on reluduali.com) | what is in it |
|---|---|---|
| You press **Sign in** | `POST /api/auth/token` | your Reluduali name and password, once. A token comes back. **The password is not kept anywhere** |
| The panel opens and you are already signed in | `GET /api/auth/me` | nothing but the token. It asks "is this sign-in still good?" |
| You sign in; the *Contest* or *Partner* page opens; every minute while one of them shows; you press **Refresh**; you enter a contest | `GET /api/contests`, `GET /api/friends`, `GET /api/friends/requests`, `GET /api/contests/invitations` | nothing but the token. Contests' rules are public. Your friends, your friend requests and your invitations are yours alone |
| You choose a contest; the lists above are read again; you share your project or unlink the Console; every 5 minutes while your window is open | `GET /api/contests/<contest>/entry`, `GET /api/contests/<contest>/submission` | nothing but the token. It asks for **your** entry and **your** hand-in |
| Every 3 seconds while a Console code is waiting (10 minutes at most) | `GET /api/contests/<contest>/entry` | nothing but the token. It asks whether the Console has used the code |
| You press **Enter** | `POST /api/contests/<contest>/enter` | the friend you chose as your partner, by name. Nothing if you enter alone |
| You accept a partner's invitation | `POST /api/contests/<contest>/join/<entry>` | nothing but the token. If you had entered on your own, your entry joins theirs: the time you used counts in your one shared budget, and your must-use demos go back for their full price. The panel says this and asks you once more before it sends anything |
| You press **Ask to edit together** next to a friend, after entering (a team is up to four, counting those asked) | `POST /api/contests/<contest>/invite` | that friend's Reluduali name |
| You press **Take back the invitation**, before they answer | `DELETE /api/contests/<contest>/invite` | the Reluduali name of the friend whose invitation you take back |
| You press **Send a friend request** | `POST /api/friends` | the Reluduali name you typed |
| You press **Accept** on a friend request someone sent you | `POST /api/friends/requests/<person>/accept` | nothing but the token |
| You press **Open my window**, or Lumit restarts while your window was open | `POST /api/timer/windows` | which contest |
| **About once a minute, while your window is open** | `POST /api/timer/windows/<window>/beat` | how long each kind of work counted since last time, and what that charged; a counter and a one-time code from the server; a signature that chains this check-in to the ones before it; and your **edit record's** length and newest fingerprint (see below). **Nothing about what you are editing** |
| Only if a check-in is refused | `GET /api/timer/windows/<window>` | nothing but the token. It asks whether this window was closed (for example, because you opened the contest on another PC) |
| An export starts, while your window is open | `POST /api/timer/windows/<window>/render` | only that it started |
| That export finishes | the same | the finished file's **fingerprint** (SHA-256) and its size in bytes. **Never the file, its name or where it is** |
| That export fails or is stopped | the same | only that it stopped |
| You press **Hand in** | `POST /api/contests/<contest>/submission` | the YouTube link and the file link you type, and the fingerprint of the render you choose |
| An export finishes, you chose **Render and replace my entry**, and you have handed in before | the same | your same two links, and the new render's fingerprint |
| At three moments in a contest that reluduali.com picks and never says in advance, while your window is open | `POST /api/timer/windows/<window>/snapshot` | only a **seal**: a fingerprint of a summary of the contest project, mixed with a random number reluduali.com sent at that moment and one the panel made. Nothing about the project can be read from it |
| With every hand-in | `POST /api/contests/<contest>/edit-record` | your **edit record**: the name and time of each step you made in the contest project (see below) |
| With every hand-in, if any snapshot was asked for | `POST /api/contests/<contest>/snapshots` | the snapshots opened: each one's summary and the panel's random number, so reluduali.com can check each against its seal. A summary is counts and lengths (clips, effects, steps), never a file's name, a folder or anything you wrote. Until Lumit gives the panel such a summary, it is the project's id and the edit record's length and newest fingerprint |
| You share your project with your partner | `POST /api/contests/<contest>/share` | the invite link to your shared Lumit project, left on reluduali.com **for the others in your team alone** |
| You stop sharing | `DELETE /api/contests/<contest>/share` | nothing but the token. The link is taken back |
| Your partner presses **Join** | `GET /api/contests/<contest>/share` | nothing but the token. It fetches the invite link you left |
| You press **Link the Console** | `POST /api/contests/<contest>/console-code` | nothing but the token. A one-time code comes back, for you to type into the Console |
| You press **Unlink** | `DELETE /api/contests/<contest>/console` | nothing but the token. The Console's link ends at once |
| You press **Sign out** | `POST /api/auth/logout` | nothing but the token. The token stops working |

One more thing leaves the panel, but not through it: **Make a Reluduali
account**, on the sign-in page, asks Lumit to open `https://reluduali.com/login`
in your own web browser. The panel sends nothing for that.

**About the edit record.** Each time you change something in the contest
project, Lumit tells the panel the step's name, such as *Set keyframe* or
*Add layer*, and the time. Never what the step did: not which layer, not
which keyframe, not any value. Steps in any other project are not even
noted.

The panel keeps that list on your PC and builds a fingerprint over it, step
by step. Each check-in sends only how many steps there are and the newest
fingerprint. A fingerprint reveals nothing about the steps. The server
stamps it with its own clock.

When you hand in, the list itself is sent. The server checks that the list
rebuilds every fingerprint it stamped. That shows each step was made by the
time it was counted. A step renamed, moved or left out afterwards does not
match. What the organizer can see is the list: step names and times, nothing
else.

**About the partner link.** Whoever has that link can join the project and
edit it. That is how Lumit's sharing works. reluduali.com shows it to the
others in your team and to nobody else, and drops it after 48 hours. If you would rather
it never passed through reluduali.com, set a password in Lumit's own
*Shared project* window, and tell your partner the password another way.

## What it never sends

- Your footage, your pictures, your project file, or any file at all.
- The name of any file, or where any file is on your PC.
- What a step did. Only its name and time.
- Anything about other projects or other programs.
- Your password, except once, to reluduali.com, when you press Sign in.
- Anything to any site other than reluduali.com.

## What it hears from Lumit

Lumit decides what a panel may see, and asks you before you install. This
panel asks for these five things, in `reluduali/extension.json`:

| permission | what Lumit lets it see or do |
|---|---|
| `project` | the open project's file name (not its folder), Lumit's id for it, and when a project opens, saves or closes |
| `activity` | when you edit and what each step is called, and when Lumit is the window in front |
| `export` | when an export starts, how far it has got, and when it finishes; and the finished file's fingerprint and size, which Lumit works out itself |
| `import` | a folder **you** pick (your recordings folder, on the *Record* page). Lumit brings new files from it into your project and tells the panel their names, which it shows on that page and does not send |
| `share` | it can open Lumit's own *Shared project* window, see who is in a shared project, and read the invite link while you share |

It also asks Lumit which version of Lumit is running, to show it on the
*Account* page.

## What it cannot do

**Lumit enforces this, not the panel.** Lumit tells you before you install.

- It cannot see your footage, your pictures or your screen.
- It cannot read or change files on your computer.
- It cannot change what is in your project, beyond bringing in files from the
  one folder you pick.
- It cannot start, stop or change an export. It only watches one you start.
- It cannot share or join a project by itself. It opens Lumit's own window,
  and **you** press *Start sharing* or *Join*.
- It cannot reach any site but reluduali.com.

## What it keeps on your PC

In the panel's own storage, which Lumit keeps for this panel alone:

- the sign-in's **token** (never your password), until you sign out;
- which contest you chose, and whether your window was open, so it can open
  again if Lumit restarts;
- which project is the contest's: its file name (never its folder) and
  Lumit's id for it;
- the folder you chose for recordings;
- your renders' **fingerprints** and when they finished (not their names or
  where they are);
- your **edit record**: each step's name and time, for this contest only;
- whether you chose *Render and replace my entry*;
- the snapshots it sealed, until they are opened at hand-in.

**Sign out**, on the *Account* page, forgets the token at once.

## How to check all of this yourself

You do not have to take any of this on trust.

- **The panel's own list of what it sent.** The *Account* page (your name, at
  the bottom of the panel's menu) shows every message the panel has sent
  since it opened: where it went and what the server answered. It does not
  keep what you typed.
- **Lumit's install question.** Before it installs anything, Lumit lists what
  the panel can and cannot do, in Lumit's own words. reluduali.com is the
  only site on it.
- **The first line of `reluduali/index.html`.** It says `connect-src 'none'`.
  That tells the browser inside Lumit to refuse every connection the page
  tries to open by itself. The browser enforces it, whatever the panel's code
  says. The only way out is to ask Lumit, which allows reluduali.com alone.
- **`reluduali/extension.json`.** Its `hosts` line names one site:
  `reluduali.com`.
- **`reluduali/server.js`.** Every request in the table above is in that one
  short file, with a comment in plain words.
- **The code is plain text.** Every file in the panel can be opened in
  Notepad. Nothing is compressed, scrambled or hidden.

## Installing it

It needs **Lumit 0.8.0 or newer**. The panel itself says it needs 0.7.1, the
first Lumit that counts only your own edits in a shared project. But 0.7.1
only came out as test builds, so 0.8.0 is the first ordinary Lumit release it
installs in. Lumit refuses to install it in anything older. Get Lumit from
Lumit's own download page, https://lumitlab.com/download.

1. Download `reluduali-lumit-0.3.0.zip`, from **https://reluduali.com/lumit**
   or from this repository's *Releases*. They are the same file.
2. Check it is the right file (next section). This step is optional, but it
   takes one line.
3. Unzip it: right-click it, then **Extract All**. You get one folder, with
   `extension.json` in it.
4. In Lumit: **Edit ▸ Settings ▸ Addons ▸ Extensions ▸ Install from a
   folder**, and choose that folder.
5. Lumit asks *Install Reluduali?* and lists, in its own words, what the panel
   can and cannot do. Read it. Then press **Install**.
6. Open the panel: **Window ▸ Extensions ▸ Reluduali**. Dock it wherever you
   like.

Installing a newer version over this one replaces it.

Lumit's extensions need Microsoft WebView2, which most Windows PCs already
have. If the panel says WebView2 is missing, install it from Microsoft.

## Checking that your download is this one

Every copy of version 0.3.0 is exactly the same file, byte for byte. Its
fingerprint (SHA-256) is:

```
CB060DB78F36F73EF6265B8E4406210DAA52945583393CA4802ABCFAD08C7E31
```

To check yours: open PowerShell in the folder that holds the zip, and run

```powershell
Get-FileHash .\reluduali-lumit-0.3.0.zip
```

It prints a `Hash`. If it is the line above, you have this file. If it is
anything else, do not install it.

reluduali.com/lumit shows the same fingerprint.

## Signing in

You sign in with your **Reluduali account**: the same account as the Demo
Database and the contest site.

1. In the panel, type your Reluduali name and password, and press
   **Sign in**.
2. No account yet? Press **Make a Reluduali account**. It opens
   reluduali.com in your own web browser. Make the account there, then sign in
   in the panel.

Your password goes to reluduali.com once, to sign you in. It is not saved on
your PC. What the panel keeps is the token that comes back.

Then choose your contest, press **Enter**, then **Open my window**. The clock
starts on your first edit.

To edit with friends, choose one as your partner when you enter, and ask more
on the *Partner* page: a team is up to four. If you entered on your own, you
can still ask later, and a friend who entered on their own can still say yes
to yours. You can add friends on that page too.

## Removing it

In Lumit: **Edit ▸ Settings ▸ Addons ▸ Extensions**, then **Remove** next to
Reluduali. Lumit deletes the panel's folder.

Lumit keeps what the panel stored (above), in case you install it again. To
forget your sign-in, press **Sign out** in the panel before you remove it.

## The checks it comes with

Two checks come with the panel. They run with Node.js 24 or newer, from this
folder, and need nothing else installed.

- **`clock.test.mjs`**, the clock's own tests, with made-up times. Anyone can
  run it:

  ```
  node --test clock.test.mjs
  ```

  It should end with `pass 16` and `fail 0`.

- **`check.mjs`** runs the whole panel in a hidden Chrome window, against a
  *pretend* Lumit and a scratch copy of the reluduali.com server. It fails if
  the panel sends anything that is not in the table above. Like Lumit, the
  pretend Lumit reads `extension.json` first and refuses anything the panel
  did not ask permission for. It also proves its own check can fail: it loads
  the panel without the first line of `index.html`, and makes sure the page
  then *can* connect.

  ```
  node check.mjs
  ```

  It needs Google Chrome, and a copy of the reluduali.com server's code,
  which is not public. Point `RELUDUALI_SERVER_REPO` at that copy. The server
  runs on a free port with an empty data folder in the system's temporary
  folder, so nothing real is touched. **So today only the people who run
  reluduali.com can run this check.** It ends with a line such as
  `ran 32 of 32 · 32 passed · 0 failed · 0 browser processes left`. Its run on
  version 0.3.0, on 19 October 2026, passed 32 of 32.

## Versions

- **0.3.0** (19 October 2026): a team is up to four. Ask more friends from the
  *Partner* page after entering, and take back each invitation on its own. The
  clock and the *Partner* page show everyone in the team. Sealed snapshots: at three
  moments in a contest that nobody knows in advance, a seal of a summary of the
  contest project, opened at hand-in so reluduali.com can check it.
- **0.2.3** (18 October 2026): you can join a partner after you started on
  your own. Your entry joins theirs, the time you used counts in your one
  shared budget, and your must-use demos go back for their full price; the
  panel says so and asks once more. You can ask a friend, or take the
  invitation back, after entering on your own. Friends can be added, and
  friend requests accepted, inside the panel.
- **0.2.2** (17 October 2026): new contests, friends and invitations show
  without signing in again. They are read when the *Contest* or *Partner*
  page opens, every minute while one shows, and on **Refresh**.
- **0.2.1** (16 October 2026): timed contests show their own countdown large;
  "opens in" before a contest opens, and no window before then.
- **0.2.0** (16 October 2026): needs Lumit 0.7.1, the first that counts only
  your own edits in a shared project; the clock on Lumit's bottom strip; the
  contest project followed by Lumit's id through a rename or Save As.
- **0.1.0** (10 to 14 October 2026): the first version, used in Lumit 0.7.0.

## For people who build software

| file | what it is |
|---|---|
| `reluduali/extension.json` | the manifest: id, permissions, the one host |
| `reluduali/index.html` | every screen, and the content security policy in its first line |
| `reluduali/clock.js` | the clock: pure, no network, no Lumit. Editing and rendering from Lumit's reports, the check-in's arithmetic and its HMAC, the edit record's chain |
| `reluduali/server.js` | the only network code: every request the panel can make |
| `reluduali/panel.js` | connects Lumit's events and the clock to the screen. Text is set with `textContent`, never as HTML |
| `reluduali/panel.css` | the look |
| `clock.test.mjs` | the clock's tests: `node --test clock.test.mjs` |
| `check.mjs` | the panel in headless Chrome against a pretend Lumit and a scratch server: `node check.mjs` |

The zip holds the six files in `reluduali/` and `LICENSE`, and nothing else.

**Network.** The page's content security policy is
`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://reluduali.com; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'`.
Every request goes through Lumit's `net.fetch`, which allows only the
manifest's `hosts`. The policy would allow pictures from reluduali.com; the
panel shows none today.

**Signing in** uses `POST /api/auth/token`, which answers with a token
instead of a cookie, because `net.fetch` keeps no cookies. The panel sends it
back as `Authorization: Bearer <token>`.

**The check-in.** `seq`, the server's one-time `nonce`, and `segments` of
`category:inFrontMs:chargedMs`, signed with HMAC-SHA256 under the window's key
over the previous signature, a newline, and `seq|nonce|segments`. The key
comes once, when the window opens, and is kept only in the page's memory. A
check-in that carries the edit record adds `record: { steps, last }`, and its
signed text ends `|record:<steps>:<last>`.

**The edit record** chains each step from the window it was made in:

```
start  = SHA-256( "reluduali edit record\n" + window id )
step i = SHA-256( previous + "\n" + i + "|" + at + "|" + name )    i from 1
```

Lowercase hex; `at` in whole milliseconds; a name cut to 200 characters. At
hand-in, `POST /api/contests/<id>/edit-record` sends
`{ windows: [{ id, steps: [[at, name], …] }] }`. The server refuses a record
that goes back, changes without a new step, or does not start from its
window.

**Categories.** The panel counts Lumit's editing as the contest category
that lists `lumit.exe`, and Lumit's exports as the category marked
`countsWhileIdle`. A contest that lists neither cannot be timed by this
panel, and the panel says so.

## Licence

MIT. See `LICENSE`. Anyone may read, copy, change and share it.
