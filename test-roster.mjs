// Edge-case QA for court grouping, labels, cap, cascade and slots.
// Phase-1 contract: every helper reads event fields off the event object —
// never global config — so tests construct full event shapes via ev().
import {
  groupPlayersIntoCourts, rosterText, describeCascade, lastCallState,
  eventSlots, addDays, maxPlayers, isFull, joinOutcome,
  headcountLine, nextOccurrence, eventId, newEvent, parsePropose, ensurePids,
  channelFor, smsText,
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

console.log('\n== recurrence: nextOccurrence ==');
{
  // 2026-08-02 is a Sunday. Use fixed UTC instants; recurrence math is Pacific.
  const thuRec = { weekdays: ['Thu'], hour: 6, label: '6:00 AM' };
  const sunAM = new Date('2026-08-02T17:00:00Z'); // Sun 10am PDT
  check('Thu recurrence from Sunday -> next Thursday', nextOccurrence(thuRec, sunAM) === '2026-08-06');
  const thuBefore = new Date('2026-08-06T12:30:00Z'); // Thu 5:30am PDT (before start)
  check('game day before start -> same day', nextOccurrence(thuRec, thuBefore) === '2026-08-06');
  const thuAfter = new Date('2026-08-06T15:00:00Z'); // Thu 8am PDT (start+1h passed)
  check('game day after start+1h -> rolls a week', nextOccurrence(thuRec, thuAfter) === '2026-08-13');

  const singlesRec = { weekdays: ['Sun', 'Mon', 'Tue'], hour: 5, label: '5:00 AM' };
  const sat = new Date('2026-08-01T17:00:00Z'); // Sat 10am PDT
  check('multi-day recurrence picks soonest (Sun)', nextOccurrence(singlesRec, sat) === '2026-08-02');
  const sunLate = new Date('2026-08-02T14:00:00Z'); // Sun 7am PDT (5am game rolled)
  check('after Sun game rolls to Mon', nextOccurrence(singlesRec, sunLate) === '2026-08-03');
}

console.log('\n== event identity ==');
{
  check('recurring id embeds date+hour', eventId('2026-08-06', 6, 'r') === '2026-08-06T06:r');
  const g = { chatId: -1, settings: { location: 'X', mapUrl: 'u', courts: 4, perCourt: 4 } };
  const e = newEvent(g, { date: '2026-08-06', hour: 6, label: '6:00 AM', sfx: 'r', kind: 'recurring' });
  check('newEvent inherits group settings', e.location === 'X' && e.perCourt === 4 && e.chatId === -1);
  check('newEvent starts open/active/empty', e.phase === 'open' && e.status === 'active' && e.players.length === 0);
  // KV keys sort chronologically because the id starts with the date.
  const a = eventId('2026-08-06', 6, 'r'), b = eventId('2026-08-09', 9, 'ab12');
  check('event ids sort by date', a < b);
}

console.log('\n== proposals: parsePropose ==');
{
  const now = new Date('2026-08-02T17:00:00Z'); // Sun 10am PDT
  const sat = parsePropose('Sat 9am', now);
  check('weekday resolves forward', sat && sat.date === '2026-08-08' && sat.hour === 9, JSON.stringify(sat));
  check('label normalized', sat.label === '9:00 AM', sat.label);
  const pm = parsePropose('Tue 6:30 PM', now);
  check('pm + minutes', pm && pm.hour === 18 && pm.label === '6:30 PM', JSON.stringify(pm));
  const iso = parsePropose('2026-08-20 7am', now);
  check('ISO date accepted', iso && iso.date === '2026-08-20' && iso.hour === 7);
  const slash = parsePropose('8/15 6am', now);
  check('M/D accepted', slash && slash.date === '2026-08-15');
  check('same weekday today counts as today', parsePropose('Sun 5pm', now).date === '2026-08-02');
  check('garbage rejected', parsePropose('whenever ish', now) === null);
  check('missing time rejected', parsePropose('Sat', now) === null);
}

console.log('\n== callback_data stays under 64 bytes ==');
{
  // Worst case: gc:<eventId>:<pid> with a proposal id.
  const eid = eventId('2026-12-31', 23, 'zzzz');
  const cb = `gc:${eid}:abcd`;
  check('guest-cancel callback fits', new TextEncoder().encode(cb).length <= 64, `${cb.length} chars`);
  const inCb = `in:${eid}`;
  check('join callback fits', new TextEncoder().encode(inCb).length <= 64);
}

console.log('\n== pid backfill ==');
{
  const e = ev(3);
  delete e.players[0].pid;
  e.players[1].pid = e.players[2].pid = 'dupe';
  ensurePids(e);
  const pids = e.players.map((p) => p.pid);
  check('all players have pids', pids.every(Boolean));
  check('pids unique', new Set(pids).size === pids.length, JSON.stringify(pids));
}

console.log('\n== proposed event shape ==');
{
  const g = { chatId: -5, settings: { location: 'Bob Baskin Park', mapUrl: 'u', courts: 4, perCourt: 4 } };
  const e = newEvent(g, { date: '2026-08-08', hour: 9, label: '9:00 AM', sfx: 'ab12', kind: 'proposed',
    proposedBy: 7, proposedByName: 'John', location: 'Fiesta', perCourt: 2 });
  check('overrides beat group defaults', e.location === 'Fiesta' && e.perCourt === 2);
  check('roster credits proposer', rosterText(e).includes('proposed by John'));
  check('recurring roster has no proposer line', !rosterText(ev(2)).includes('proposed by'));
}

console.log('\n== notification routing (channelFor) ==');
{
  check('telegram member -> telegram', channelFor({ key: 'u:5', id: 5 }) === 'telegram');
  check('guest -> telegram (via sponsor)', channelFor({ key: 'g:5:pal', guestOf: 5 }) === 'telegram');
  check('web player -> sms', channelFor({ key: 'p:+15551234567' }) === 'sms');
  check('unknown -> null', channelFor({ key: 'x:???' }) === null);
}

console.log('\n== smsText strips Telegram HTML ==');
{
  const out = smsText('🎉 A spot opened — <b>you&#x27;re</b> now on <b>Court 1</b>.\nThu, Aug 6 · Bob Baskin Park');
  check('tags gone', !/[<>]/.test(out.replace(/&#x27;/, "'")), JSON.stringify(out));
  check('content kept', out.includes('Court 1') && out.includes('Bob Baskin Park'));
  check('entities decoded', smsText('A &amp; B &lt;ok&gt;') === 'A & B <ok>');
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}\n`);
process.exit(fails ? 1 : 0);
