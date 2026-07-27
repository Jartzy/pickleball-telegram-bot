// Edge-case QA for court grouping, labels, cap and cascade.
import { groupPlayersIntoCourts, rosterText, describeCascade, CONFIG } from
  './worker.js';

const SIZE = CONFIG.playersPerCourt;
const MAX = CONFIG.game.courts * SIZE;
let fails = 0;
const check = (name, cond, detail = '') => {
  if (!cond) { fails++; console.log(`  FAIL  ${name} ${detail}`); }
  else console.log(`  ok    ${name}`);
};

const mk = (n) => Array.from({ length: n }, (_, i) => ({ key: `u:${i + 1}`, id: i + 1, name: `P${i + 1}` }));

console.log(`\n== court grouping across boundaries (size ${SIZE}, cap ${MAX}) ==`);
for (const n of [0, 1, 3, 4, 5, 7, 8, 9, 12, 15, 16, 17]) {
  const courts = groupPlayersIntoCourts(mk(n));
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
  // court numbers must be 1..k with no gaps/dupes
  const nums = courts.map((c) => c.courtNumber);
  check(`n=${n} court numbers sequential`, nums.every((v, i) => v === i + 1), JSON.stringify(nums));
}

console.log('\n== join-outcome label maths (mirrors joinLabel) ==');
for (const n of [0, 3, 4, 7, 8, 15, 16]) {
  const court = Math.floor(n / SIZE) + 1;
  const needAfter = SIZE - ((n % SIZE) + 1);
  const fills = needAfter === 0;
  check(`n=${n} -> court ${court}, need ${needAfter}, fills=${fills}`,
    court >= 1 && needAfter >= 0 && needAfter < SIZE);
  if (n === 3) check('n=3 fills court 1', fills === true);
  if (n === 4) check('n=4 starts court 2 needing 3', court === 2 && needAfter === 3);
  if (n === 7) check('n=7 fills court 2', fills === true && court === 2);
  if (n === 15) check('n=15 fills court 4', fills === true && court === 4);
}

console.log('\n== cap ==');
check('cap equals venue capacity', MAX === 16, `MAX=${MAX}`);
check('16 players = 4 confirmed courts, no partial',
  groupPlayersIntoCourts(mk(16)).filter((c) => !c.isConfirmed).length === 0);
check('17th would create a 5th court (must be blocked upstream)',
  groupPlayersIntoCourts(mk(17)).length === 5);

console.log('\n== drop cascade across a court boundary ==');
// 5 players: P5 alone on court 2. Drop P1 -> P5 must move up to court 1.
{
  const before = mk(5);
  const week = { date: '2026-07-30', phase: 'open', players: mk(5).filter((p) => p.key !== 'u:1'), msgId: null };
  const text = describeCascade(before, week, ['P1']);
  check('cascade names the leaver', text.includes('P1'));
  check('cascade reports promotion to Court 1', /P5.*Court 1/s.test(text), JSON.stringify(text));
  // 5 -> 4 leaves a FULL court, so nothing should be reported short.
  check('5->4 does NOT claim a shortage', !/needs/i.test(text), JSON.stringify(text));
}
// 4 -> 3 genuinely breaks the court and must say so.
{
  const before = mk(4);
  const week = { date: '2026-07-30', phase: 'open', players: mk(4).filter((p) => p.key !== 'u:1'), msgId: null };
  const text = describeCascade(before, week, ['P1']);
  check('4->3 says we need 1 more', /need\D*<b>1<\/b>/is.test(text), JSON.stringify(text));
  check('4->3 avoids court numbers in the shortage line', !/Court \d needs/i.test(text));
}
// 8 -> drop one: court 2 breaks
{
  const before = mk(8);
  const week = { date: '2026-07-30', phase: 'open', players: mk(8).filter((p) => p.key !== 'u:2'), msgId: null };
  const text = describeCascade(before, week, ['P2']);
  check('8->7 promotes across boundary', /Court 1/.test(text), JSON.stringify(text));
}

console.log('\n== roster rendering at boundaries ==');
for (const n of [0, 4, 5, 16]) {
  const week = { date: '2026-07-30', phase: 'open', players: mk(n), msgId: null };
  const t = rosterText(week);
  check(`n=${n} renders headcount`, t.includes(`${n} in`), t.split('\n').pop());
  check(`n=${n} shows venue courts`, t.includes(`${CONFIG.game.courts} courts`));
  if (n === 0) check('empty roster invites first signup', /Nobody signed up/.test(t));
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}\n`);
process.exit(fails ? 1 : 0);
