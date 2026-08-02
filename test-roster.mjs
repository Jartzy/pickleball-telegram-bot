// Edge-case QA for court grouping, labels, cap, cascade and slots.
// Phase-1 contract: every helper reads event fields off the event object —
// never global config — so tests construct full event shapes via ev().
import {
  groupPlayersIntoCourts, rosterText, describeCascade, lastCallState,
  activeSlots, eventSlots, addDays, maxPlayers, isFull, joinOutcome,
  headcountLine, CONFIG,
} from './worker.js';

const SIZE = 4;
const MAX = 16;
let fails = 0;
const check = (name, cond, detail = '') => {
  if (!cond) { fails++; console.log(`  FAIL  ${name} ${detail}`); }
  else console.log(`  ok    ${name}`);
};

const mk = (n) => Array.from({ length: n }, (_, i) => ({ key: `u:${i + 1}`, id: i + 1, name: `P${i + 1}` }));

/** Full event-shaped object; overrides let a test vary perCourt/hour/etc. */
const ev = (n, over = {}) => ({
  date: '2026-07-30', phase: 'open', players: mk(n), msgId: null,
  hour: 6, label: '6:00 AM', location: 'Bob Baskin Park',
  mapUrl: 'https://maps.example/x', courts: 4, perCourt: SIZE,
  ...over,
});

console.log(`\n== court grouping across boundaries (size ${SIZE}, cap ${MAX}) ==`);
for (const n of [0, 1, 3, 4, 5, 7, 8, 9, 12, 15, 16, 17]) {
  const courts = groupPlayersIntoCourts(mk(n), SIZE);
  const expectedCourts = Math.ceil(n / SIZE);
  const confirmed = courts.filter((c) => c.isConfirmed).length;
  const expectedConfirmed = Math.floor(n / SIZE);
  const partial = courts.find((c) => !c.isConfirmed);
  const seats = courts.reduce((a, c) => a + c.players.length, 0);
  check(`n=${n} court count`, courts.length === expectedCourts, `got ${courts.length} want ${expectedCourts}`);
  check(`n=${n} confirmed count`, confirmed === expectedConfirmed, `got ${confirmed} want ${expectedConfirmed}`);
  check(`n=${n} no player lost`, seats === n, `got ${seats} want ${n}`);
  if (partial) {
    check(`n=${n} partial needs right amount`,
      partial.playersNeeded === SIZE - (n % SIZE), `got ${partial.playersNeeded}`);
    check(`n=${n} only ONE partial court`, courts.filter((c) => !c.isConfirmed).length === 1);
  }
  const nums = courts.map((c) => c.courtNumber);
  check(`n=${n} court numbers sequential`, nums.every((v, i) => v === i + 1), JSON.stringify(nums));
}

console.log('\n== singles: perCourt=2 court math ==');
for (const n of [0, 1, 2, 3, 4, 5]) {
  const courts = groupPlayersIntoCourts(mk(n), 2);
  check(`n=${n} singles court count`, courts.length === Math.ceil(n / 2));
  check(`n=${n} singles confirmed`, courts.filter((c) => c.isConfirmed).length === Math.floor(n / 2));
}
check('singles event: 2 players is full court', lastCallState(ev(2, { perCourt: 2, courts: 1 })) === 'set');
check('singles event: 1 player is short', lastCallState(ev(1, { perCourt: 2, courts: 1 })) === 'short');
check('singles cap: courts=1 perCourt=2 -> max 2', maxPlayers(ev(0, { perCourt: 2, courts: 1 })) === 2);
check('singles isFull at 2', isFull(ev(2, { perCourt: 2, courts: 1 })) === true);

console.log('\n== join-outcome (from event object) ==');
{
  check('n=0 -> court 1, 3 more after join', JSON.stringify(joinOutcome(ev(0))) === JSON.stringify({ court: 1, needAfter: 3, fills: false }));
  check('n=3 join fills court 1', joinOutcome(ev(3)).fills === true && joinOutcome(ev(3)).court === 1);
  check('n=4 join starts court 2', joinOutcome(ev(4)).court === 2 && joinOutcome(ev(4)).needAfter === 3);
  check('n=15 join fills court 4', joinOutcome(ev(15)).fills === true && joinOutcome(ev(15)).court === 4);
  check('singles n=1 join fills court 1', joinOutcome(ev(1, { perCourt: 2 })).fills === true);
}

console.log('\n== cap ==');
check('cap equals venue capacity', maxPlayers(ev(0)) === MAX, `got ${maxPlayers(ev(0))}`);
check('16 players = 4 confirmed courts, no partial',
  groupPlayersIntoCourts(mk(16), SIZE).filter((c) => !c.isConfirmed).length === 0);
check('17th would create a 5th court (must be blocked upstream)',
  groupPlayersIntoCourts(mk(17), SIZE).length === 5);
check('isFull at 16', isFull(ev(16)) === true);
check('not full at 15', isFull(ev(15)) === false);

console.log('\n== drop cascade across a court boundary ==');
{
  const before = mk(5);
  const week = ev(0); week.players = mk(5).filter((p) => p.key !== 'u:1');
  const text = describeCascade(before, week, ['P1']);
  check('cascade names the leaver', text.includes('P1'));
  check('cascade reports promotion to Court 1', /P5.*Court 1/s.test(text), JSON.stringify(text));
  check('5->4 does NOT claim a shortage', !/needs/i.test(text), JSON.stringify(text));
}
{
  const before = mk(4);
  const week = ev(0); week.players = mk(4).filter((p) => p.key !== 'u:1');
  const text = describeCascade(before, week, ['P1']);
  check('4->3 says we need 1 more', /need\D*<b>1<\/b>/is.test(text), JSON.stringify(text));
  check('4->3 avoids court numbers in the shortage line', !/Court \d needs/i.test(text));
}
{
  const before = mk(8);
  const week = ev(0); week.players = mk(8).filter((p) => p.key !== 'u:2');
  const text = describeCascade(before, week, ['P2']);
  check('8->7 promotes across boundary', /Court 1/.test(text), JSON.stringify(text));
}

console.log('\n== roster rendering at boundaries ==');
for (const n of [0, 4, 5, 16]) {
  const t = rosterText(ev(n));
  check(`n=${n} renders headcount`, t.includes(`${n} in`), t.split('\n').pop());
  check(`n=${n} shows venue courts`, t.includes('4 courts'));
  if (n === 0) check('empty roster invites first signup', /Nobody signed up/.test(t));
}
check('roster shows event location, not config',
  rosterText(ev(1, { location: 'Fiesta Park', mapUrl: 'https://m/x' })).includes('Fiesta Park'));
check('roster shows event label',
  rosterText(ev(1, { label: '7:30 AM' })).includes('7:30 AM'));

console.log('\n== last-call branch (Wed 7pm) ==');
{
  check('0 signed up -> short (NOT "set")', lastCallState(ev(0)) === 'short', lastCallState(ev(0)));
  check('1 signed up -> short', lastCallState(ev(1)) === 'short');
  check('3 signed up -> short', lastCallState(ev(3)) === 'short');
  check('4 signed up -> set', lastCallState(ev(4)) === 'set', lastCallState(ev(4)));
  check('5 signed up -> recruit', lastCallState(ev(5)) === 'recruit', lastCallState(ev(5)));
  check('8 signed up -> set', lastCallState(ev(8)) === 'set');
  check('16 signed up -> set', lastCallState(ev(16)) === 'set');
}

console.log('\n== two events are fully isolated ==');
{
  const doubles = ev(5);
  const singles = ev(3, { date: '2026-08-02', perCourt: 2, courts: 2, label: '5:00 AM', location: 'Whitney Ranch' });
  check('doubles recruit while singles recruit independently',
    lastCallState(doubles) === 'recruit' && lastCallState(singles) === 'recruit');
  singles.players = mk(4);
  check('filling singles does not change doubles',
    lastCallState(singles) === 'set' && lastCallState(doubles) === 'recruit');
  check('headcounts independent', headcountLine(doubles).includes('5 in') && headcountLine(singles).includes('4 in'));
  check('renders use own venue', rosterText(singles).includes('Whitney Ranch') && rosterText(doubles).includes('Bob Baskin Park'));
}

console.log('\n== per-event slots (eventSlots) ==');
{
  const slots = eventSlots(ev(0)); // Thu 2026-07-30, 6am
  const by = Object.fromEntries(slots.map((s) => [s.id, s]));
  check('four slots', slots.length === 4, slots.map((s) => s.id).join(','));
  check('remind-3d = Mon 8am', by['remind-3d'].date === '2026-07-27' && by['remind-3d'].hour === 8);
  check('remind-1d = Wed 8am', by['remind-1d'].date === '2026-07-29' && by['remind-1d'].hour === 8);
  check('lastcall = Wed 7pm', by['lastcall'].date === '2026-07-29' && by['lastcall'].hour === 19);
  check('final = Thu 5am (1hr before)', by['final'].date === '2026-07-30' && by['final'].hour === 5);

  const midnight = eventSlots(ev(0, { hour: 0 }));
  const mfinal = midnight.find((s) => s.id === 'final');
  check('midnight game: final crosses to previous day 11pm',
    mfinal.date === '2026-07-29' && mfinal.hour === 23, JSON.stringify(mfinal));

  const sunday5 = eventSlots(ev(0, { date: '2026-08-02', hour: 5 }));
  const sby = Object.fromEntries(sunday5.map((s) => [s.id, s]));
  check('Sun 5am game: final Sun 4am', sby['final'].date === '2026-08-02' && sby['final'].hour === 4);
  check('Sun game: lastcall Sat 7pm', sby['lastcall'].date === '2026-08-01' && sby['lastcall'].hour === 19);
}
check('addDays basic', addDays('2026-07-30', -3) === '2026-07-27');
check('addDays month boundary', addDays('2026-08-01', -2) === '2026-07-30');
check('addDays year boundary', addDays('2026-01-01', -1) === '2025-12-31');

console.log('\n== legacy global schedule (until Phase 2 cutover) ==');
{
  const ids = activeSlots().map((s) => s.id);
  check('five slots', ids.length === 5, ids.join(','));
  const final = activeSlots().find((s) => s.id === 'final');
  check('final is one hour before the game', final.hour === (CONFIG.game.hour + 23) % 24, String(final.hour));
  const open = activeSlots().find((s) => s.id === 'open');
  check('open is after the game has rolled over', open.hour === (CONFIG.game.hour + 2) % 24, String(open.hour));
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}\n`);
process.exit(fails ? 1 : 0);
