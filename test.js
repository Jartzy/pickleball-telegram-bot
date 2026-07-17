/**
 * Logic tests for the pure functions in worker.js — run with:  npm test
 * (No Cloudflare/Telegram access needed; tests only the court math,
 * roster rendering, drop cascade, and Pacific-time game-date math.)
 */
import assert from 'node:assert';
import { groupPlayersIntoCourts, rosterText, describeCascade, activeGameDate, CONFIG } from './worker.js';

const P = (name, i) => ({ key: `u:${i}`, id: i, name });
const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi', 'Ivan'];
const players = (n) => names.slice(0, n).map(P);

// --- Court grouping: strict blocks of 4 ------------------------------------
assert.strictEqual(groupPlayersIntoCourts([]).length, 0);

let courts = groupPlayersIntoCourts(players(6));
assert.strictEqual(courts.length, 2);
assert.strictEqual(courts[0].isConfirmed, true);
assert.strictEqual(courts[1].isConfirmed, false);
assert.strictEqual(courts[1].playersNeeded, 2);

courts = groupPlayersIntoCourts(players(8));
assert.strictEqual(courts[1].isConfirmed, true); // Court 2 upgrades at exactly 8

courts = groupPlayersIntoCourts(players(9));
assert.strictEqual(courts[2].courtNumber, 3);
assert.strictEqual(courts[2].playersNeeded, 3);

// --- Roster rendering -------------------------------------------------------
const week = { date: '2026-07-23', phase: 'open', players: players(6) };
const text = rosterText(week);
assert(text.includes('Court 1 (CONFIRMED)'));
assert(text.includes('Waitlist / Filling Court 2'));
assert(text.includes('Needs 2 more players'));
assert(text.includes('Thu, Jul 23'));

// Guests render with attribution.
const gWeek = {
  date: '2026-07-23',
  phase: 'open',
  players: [...players(4), { key: 'g:1:jake', name: 'Jake', guestOf: 1, guestOfName: 'Alice' }],
};
assert(rosterText(gWeek).includes('Jake <i>(guest of Alice)</i>'));

// --- Drop cascade: Court 1 drop promotes top waitlister ---------------------
const before = players(8); // two confirmed courts
const after = { date: '2026-07-23', phase: 'urgent', players: before.filter((p) => p.name !== 'Bob') };
const cascade = describeCascade(before, after, ['Bob']);
assert(cascade.includes('Bob'));
assert(cascade.includes('Eve moves up to Court 1')); // player #5 slides into Court 1
assert(cascade.includes('Court 2 now needs <b>1</b> more player'));

// --- Game-date math (America/Los_Angeles, game = Thu 6am) -------------------
// Wed Jul 22 2026, 7pm PDT (= Thu 02:00 UTC): active game is tomorrow, Thu Jul 23.
assert.strictEqual(activeGameDate(new Date('2026-07-23T02:00:00Z')), '2026-07-23');
// Thu Jul 23, 5:15am PDT: still game day.
assert.strictEqual(activeGameDate(new Date('2026-07-23T12:15:00Z')), '2026-07-23');
// Thu Jul 23, 8am PDT (game over, sign-ups reopen): rolls to next Thu.
assert.strictEqual(activeGameDate(new Date('2026-07-23T15:00:00Z')), '2026-07-30');
// Friday: next Thursday.
assert.strictEqual(activeGameDate(new Date('2026-07-24T20:00:00Z')), '2026-07-30');
// Winter (PST, UTC-8) sanity check: Wed Dec 16 2026 7pm PST = Thu 03:00 UTC.
assert.strictEqual(activeGameDate(new Date('2026-12-17T03:00:00Z')), '2026-12-17');

assert.strictEqual(CONFIG.playersPerCourt, 4);

console.log('All tests passed ✔');
