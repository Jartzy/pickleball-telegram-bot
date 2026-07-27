# Pickleball Bot — Roadmap / Feature Backlog

Ideas parked for later, with feasibility notes. Tracked in beads (`bd list`).

---

## ✅ Shipped

- **Web page can't drop Telegram members or guests.** By keyspace design the
  `/signup` page only touches `w:<name>` entries; Telegram members (`u:<id>`) and
  guests (`g:<inviterId>:<name>`) are untouchable from the web. Added a clear message
  ("X is in via Telegram — only they can drop themselves") and a `Telegram` badge on
  protected members so the perk of joining is visible. Only a member can `/out`
  themselves; only the inviter can `/unguest` their guest (and guests cascade off if
  the inviter drops).

---

## Idea: Targeted "nudge" messages + a "save the day" hero tally

**Original ask (paraphrased):** send tailored messages to different people —
- **Confirmed players:** "You're in at {location}. There are N on the waitlist —
  tap here to drop and give your spot to someone in line."
- **Waitlist players:** "There are N of you on the waitlist. Recruit M more to fill
  a court, or drop if you'd like."
- **Group members not signed up:** "There are 3 on the waitlist — want to be the
  4th and save the day?"
- **Bonus:** track who fills the deciding spot and give them a ⭐ badge + running tally.

### ⚠️ Telegram platform constraints (read this first — it shapes everything)

These are hard limits of the Telegram **Bot API**, not our code:

1. **Bots cannot start a private DM.** A bot may only send a *private* message to a
   user who has already opened a chat with the bot and pressed **Start**. We cannot
   cold-DM someone. To DM a person we must (a) have them start the bot in DM once,
   and (b) store their private `chat_id`.
2. **Bots cannot list group members.** There is no "get all members" method. We get
   `getChatMemberCount` (a number) and `getChatMember(userId)` (requires knowing the
   id already). So **"everyone in the group who isn't signed up" is not a knowable
   set** — we can't target those people individually.
3. **Group @mentions DO work** for users we already know (anyone who signed up via
   Telegram `/in`, keyed `u:<id>`). `mention()` in `worker.js` already pings them via
   `tg://user?id=` — even without a public @username.
4. **Web sign-ups have no Telegram identity.** People added through `/signup` are
   keyed `w:<name>` with no `id`, so they can't be @mentioned or DM'd at all.

**Net effect:** most of this has to be delivered as **group messages with
@mentions**, not private DMs — unless we add a one-time "DM the bot to get personal
nudges" onboarding step. And cohort #3 (unsigned group members) can only be reached
by a **group-wide broadcast**, never individually.

### What's feasible, in priority order

**Phase 1 — Cohort nudges as group @mentions (feasible now, reuses existing code)**
- Extend the existing `sendRecruitingAlert()` / `cutoff` slot logic.
- **Confirmed cohort:** group message @mentioning confirmed players with a **Drop**
  button — "Can't make it? Free your spot for the waitlist." (Only mentions players
  with a Telegram `id`; web names get a generic line.)
- **Waitlist cohort:** @mention waitlisters — "You're #N of M on the waitlist; K more
  unlock Court X. Recruit with `/guest Name`, or Drop."
- Delivery is one grouped post per cohort (or a combined post with two sections) so we
  don't spam. Fires at `cutoff`, and optionally on demand via a command.
- **Blocked sub-part:** individually messaging unsigned members → not possible.
  Substitute: a single group broadcast "3 on the waitlist — be the 4th and save the
  day!" with a **🖐 Claim a spot** button (a version of this already exists).

**Phase 2 — "Save the day" hero tally (self-contained, fun, low risk)**
- KV: `hero:<userId>` → count (or one `heroes` object `{ userId: {name, count} }`).
- Credit logic: when a player's join flips a court from *partial* → *confirmed* (fills
  the 4th slot), increment that user's counter. Detectable in the add path by comparing
  `groupPlayersIntoCourts` before vs. after.
- Display: ⭐ badge next to their name in `rosterText`, and/or a `/heroes` leaderboard
  command. Optional footnote/asterisk tally as requested.
- No platform limits here — this is purely our own state.

**Phase 3 — True private DMs (needs onboarding; partial platform limits)**
- Add a one-time flow: "DM the bot & press Start to get personal reminders." Store each
  opted-in user's private `chat_id` in KV (`dm:<userId>`).
- Then Phase 1's nudges can go out as real DMs to opted-in users, falling back to group
  @mention for everyone else.
- Still cannot reach unsigned members who never interacted with the bot.

### Recommendation

Start with **Phase 2 (hero tally)** — it's self-contained, delightful, and has zero
platform friction — then **Phase 1** cohort nudges as group @mentions. Treat **Phase 3
private DMs** as optional and only if people actually want reminders in their DMs.
Set expectations that "message the specific people not signed up" isn't achievable
individually — a group broadcast with a Claim button is the real-world equivalent.

### Open questions
- Is spamming the group with multiple cohort posts acceptable, or should it be one
  combined message? (Leaning: one combined post to reduce noise.)
- Do we want a `/heroes` leaderboard, inline ⭐ badges, or both?
- Worth building the DM opt-in onboarding, or is group @mention enough?

---

## Idea: Attendance & drop-off analytics — `pickleball-telegram-bot-kla` (P2)

Track per-person attendance and drop behavior over time to see who's reliable vs
flaky. Internal-only; may not be circulated.

- **Data model:** `stats:<userId>` and/or an append-only `history:<date>` event log.
- **Capture:** in (signup), out (drop), **late drop** (out after cutoff/final — the
  strongest flakiness signal), inclusion on the locked **final** roster (= expected
  to attend).
- **Ground truth gap:** true attendance / no-show needs a signal the bot doesn't have
  yet — add a post-game "who showed up?" prompt, or let the organizer mark no-shows.
  Without it, "late drop after committing" is the best proxy.
- **Identity caveat:** reliable only for Telegram members (`u:`) and guests (tied to
  inviter). Web sign-ups (`w:`) are name-only with no stable cross-week identity —
  another reason to join Telegram.
- **⚠️ Sensitive:** this is behavioral data (a reliability score) about real people.
  Store privately, never expose on the public `/signup` page, and be thoughtful about
  surfacing it socially.

## Idea: Guest claim-link — `pickleball-telegram-bot-cev` (P3)

When a member adds a guest, let them send the guest a link to claim the spot
themselves — another nudge to join Telegram. User flagged as complex / nice-to-have.

- On `/guest`, mint a claim token in KV (`claim:<token>` → `{date, inviterId, name}`).
- Share via a Telegram deep link (`t.me/<bot>?start=claim_<token>`) or a
  `/signup/claim?token=` web URL.
- Claiming converts the `g:<inviterId>:<name>` entry to the claimer's own identity
  (`u:<id>` if they join), so the guest becomes self-managing.
- Handle token expiry, one-time use, and key/cascade conversion.
