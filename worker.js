/**
 * ============================================================================
 * PICKLEBALL RESERVATION BOT — Telegram + Cloudflare Workers
 * ============================================================================
 * A serverless weekly reservation system with a waitlist, for a recurring
 * pickleball game (default: Thursdays 6:00 AM Pacific).
 *
 * How it works:
 *   - Players tap "✅ I'm in" on the bot's roster message in the Telegram
 *     group. The roster is one ordered queue; courts are slices of 4:
 *         blockIndex  = floor(i / 4)     (0-based player index i)
 *         courtNumber = blockIndex + 1
 *     A court is CONFIRMED only when its block holds exactly 4 players;
 *     a partial block shows "Waitlist / Filling Court N (needs X more)".
 *   - Drops shift everyone below up one spot (early sign-ups keep priority),
 *     and the bot announces exactly who moved and which court is now short.
 *   - Members can add guests (/guest Jake) — guests don't need Telegram.
 *   - A standby pool (/standby) gets pinged when a spot opens late, with a
 *     first-to-tap "Claim spot" button.
 *
 * Weekly automation (cron fires every 15 min; the code checks Pacific local
 * time, so daylight-saving changes are handled automatically):
 *   - Thu 8:00 AM  -> open next week's sign-up
 *   - Wed 7:00 PM  -> night-before roll call
 *   - Wed 9:30 PM  -> cutoff: recruiting push for partial courts + standby ping
 *   - Thu 5:15 AM  -> final roster
 *
 * Bindings required (see wrangler.toml / README):
 *   - KV namespace:  PICKLE_KV
 *   - Secrets:       TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET
 * ============================================================================
 */

// ============================================================================
// CONFIG — edit these to change the schedule
// ============================================================================

const CONFIG = {
  timezone: 'America/Los_Angeles',
  playersPerCourt: 4,

  // The recurring game: Thursday 6:00 AM local time.
  game: {
    weekday: 'Thu',
    hour: 6,
    label: '6:00 AM',
    location: 'Bob Baskin Park',
    courts: 4, // courts available at the venue -> hard cap on sign-ups
    mapUrl: 'https://www.google.com/maps/search/?api=1&query=Bob+Baskin+Park',
  },

  // Telegram group invite link — shown on the web sign-up page so people can
  // join for realtime updates. Get it in Telegram: group → Manage → Invite
  // Links. Leave '' to hide the "join the group" step.
  telegramInviteUrl: 'https://t.me/+wOcsQEcWDuM2MDZh',

  // Public sign-up page, linked from the roster message. Set miniAppUrl to a
  // BotFather Direct Link Mini App (https://t.me/<bot>/<app>) to make the
  // button open *inside* Telegram — that path also passes a signed initData,
  // which unlocks the personalised "(me)" view. Falls back to webUrl.
  webUrl: 'https://pickleball-bot.jmartin84.workers.dev/signup',
  miniAppUrl: 'https://t.me/BicklePallBot/dink',

  // Bot username, used to build deep links (t.me/<bot>?start=...). Opening the
  // bot is what opts someone in to DMs — Telegram forbids a bot from messaging
  // anyone who hasn't started it.
  botUsername: 'BicklePallBot',
  webhookUrl: 'https://pickleball-bot.jmartin84.workers.dev/webhook',
  calendarUrl: 'https://pickleball-bot.jmartin84.workers.dev/event.ics',

  // Slot times are derived from the game time — see activeSlots().
};

/**
 * Automation moments, in local time. Derived from the game time so moving the
 * game (e.g. to 8am) moves the final roster and the re-open with it.
 * Each fires once per game week; the cron ticks every 15 minutes.
 */
function activeSlots() {
  const g = CONFIG.game;
  return [
    // Sign-ups for next week, safely after this week's game has rolled over.
    { id: 'open', weekday: g.weekday, hour: (g.hour + 2) % 24, minute: 0 },
    { id: 'rollcall-mon', weekday: 'Mon', hour: 8, minute: 0 },
    { id: 'rollcall-wed', weekday: 'Wed', hour: 8, minute: 0 },
    { id: 'lastcall', weekday: 'Wed', hour: 19, minute: 0 },
    // One hour before the game, whatever time that is.
    { id: 'final', weekday: g.weekday, hour: (g.hour + 23) % 24, minute: 0 },
  ];
}

// ============================================================================
// TIME HELPERS — everything is computed in the configured timezone
// ============================================================================

/** Returns {wd, y, mo, d, hour, minute} for a Date, in CONFIG.timezone. */
function localParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    wd: p.weekday, // 'Thu'
    y: p.year,
    mo: p.month,
    d: p.day,
    hour: parseInt(p.hour, 10) % 24,
    minute: parseInt(p.minute, 10),
  };
}

/** 'YYYY-MM-DD' in local timezone for a Date. */
function localDateStr(date) {
  const p = localParts(date);
  return `${p.y}-${p.mo}-${p.d}`;
}

/**
 * The game date (YYYY-MM-DD) currently being organized.
 * = the next game-day whose start hasn't passed; but from 1 hour after game
 *   start onward we roll over to the following week (sign-ups reopen).
 */
function activeGameDate(now) {
  for (let i = 0; i <= 8; i++) {
    const candidate = new Date(now.getTime() + i * 86400000);
    const p = localParts(candidate);
    if (p.wd !== CONFIG.game.weekday) continue;
    // Today IS game day: before (game hour + 1) it's still this week's game.
    if (i === 0 && localParts(now).hour >= CONFIG.game.hour + 1) continue;
    return localDateStr(candidate);
  }
  return localDateStr(now); // unreachable
}

/** 'Thu, Jul 23' label for a stored YYYY-MM-DD game date. */
function fmtGameDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Noon UTC avoids any timezone rolling the calendar date over.
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// ============================================================================
// COURT LOGIC — strict blocks of 4 (same math as documented in the header)
// ============================================================================

function groupPlayersIntoCourts(players) {
  const size = CONFIG.playersPerCourt;
  const courts = [];
  for (let start = 0; start < players.length; start += size) {
    const block = players.slice(start, start + size);
    courts.push({
      courtNumber: start / size + 1,
      players: block,
      isConfirmed: block.length === size,
      playersNeeded: size - block.length,
    });
  }
  return courts;
}

// ============================================================================
// SMALL UTILITIES
// ============================================================================

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Display name for a roster entry, with guest attribution. */
function displayName(player) {
  return player.guestOf ? `${player.name} <i>(guest of ${esc(player.guestOfName)})</i>` : esc(player.name);
}

/** HTML mention that pings the user even without a public @username. */
function mention(user) {
  return `<a href="tg://user?id=${user.id}">${esc(user.name)}</a>`;
}

function fullName(from) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Player';
}

// ============================================================================
// KV STATE
//   chat            -> { chatId }                     (bound group)
//   week:<date>     -> { date, phase, players[], msgId }
//   standby         -> [ { id, name } ]
//   fired:<slot>:<date> -> '1'                         (cron idempotency)
// ============================================================================

async function kvGet(env, key, fallback = null) {
  const raw = await env.PICKLE_KV.get(key);
  return raw === null ? fallback : JSON.parse(raw);
}

async function kvPut(env, key, value) {
  await env.PICKLE_KV.put(key, JSON.stringify(value));
}

/**
 * The UTC instant for a wall-clock hour on a given local date. Probing offsets
 * avoids hard-coding a daylight-saving rule.
 */
function utcForLocal(dateStr, hour) {
  const [y, m, d] = dateStr.split('-').map(Number);
  for (let off = -14; off <= 14; off++) {
    const t = Date.UTC(y, m - 1, d, hour + off);
    const p = localParts(new Date(t));
    if (`${p.y}-${p.mo}-${p.d}` === dateStr && p.hour === hour) return new Date(t);
  }
  return new Date(Date.UTC(y, m - 1, d, hour));
}

function icsStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Google Calendar prefills via URL; Apple/Outlook take the .ics file. */
function calendarButtons(week) {
  const start = utcForLocal(week.date, CONFIG.game.hour);
  const end = new Date(start.getTime() + 2 * 3600 * 1000);
  const g =
    'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    `&text=${encodeURIComponent('🏓 Pickleball')}` +
    `&dates=${icsStamp(start)}/${icsStamp(end)}` +
    `&location=${encodeURIComponent(CONFIG.game.location)}` +
    `&details=${encodeURIComponent(`Roster: ${CONFIG.miniAppUrl || CONFIG.webUrl}`)}`;
  return [
    [
      { text: '📅 Google', url: g },
      { text: '🍎 Apple / other', url: `${CONFIG.calendarUrl}?date=${week.date}` },
    ],
  ];
}

/** "6:30 PM" -> 18. Returns null when it cannot be read. */
function parseHour(label) {
  const h = parseInt(label, 10);
  if (Number.isNaN(h)) return null;
  const pm = /pm/i.test(label);
  return pm && h < 12 ? h + 12 : !pm && h === 12 ? 0 : h;
}

/** Applies any admin overrides (venue, time, courts) over the compiled config. */
async function applySettings(env) {
  const o = await kvGet(env, 'settings');
  if (!o) return;
  if (o.perCourt) CONFIG.playersPerCourt = o.perCourt;
  Object.assign(CONFIG.game, o);
}

async function getWeek(env, date) {
  return (
    (await kvGet(env, `week:${date}`)) || {
      date,
      phase: 'open', // open -> rollcall -> urgent (post-cutoff) -> final
      players: [], // [{ key, name, id?, guestOf?, guestOfName? }] in sign-up order
      msgId: null, // live roster message to edit
    }
  );
}

async function saveWeek(env, week) {
  await kvPut(env, `week:${week.date}`, week);
}

// ============================================================================
// TELEGRAM API
// ============================================================================

async function tg(env, method, params) {
  // Link previews blow up the message with a huge card (e.g. the Google Maps
  // pin). Off by default everywhere; pass link_preview_options to override.
  if (method === 'sendMessage' || method === 'editMessageText') {
    params = { link_preview_options: { is_disabled: true }, ...params };
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) console.log(`telegram ${method} failed: ${data.description}`);
  return data;
}

/**
 * What joining right now would actually do — so the button can say "fills
 * Court 1!" instead of a bare "I'm in" that hides whether the game is on.
 */
function joinOutcome(week) {
  const n = week.players.length;
  const size = CONFIG.playersPerCourt;
  const court = Math.floor(n / size) + 1;
  const needAfter = size - ((n % size) + 1);
  return { court, needAfter, fills: needAfter === 0 };
}

function joinLabel(week) {
  if (isFull(week)) return `🚫 Courts full`;
  const { needAfter, fills } = joinOutcome(week);
  if (fills) return `✅ I'm in (that's a full court!)`;
  return `✅ I'm in (${needAfter} more still needed)`;
}

function rosterKeyboard(week) {
  return {
    inline_keyboard: [
      [{ text: week ? joinLabel(week) : "✅ I'm in", callback_data: 'in' }],
      [
        { text: "❌ Can't make it", callback_data: 'out' },
        { text: '➕ Bring a guest', callback_data: 'guest' },
      ],
    ],
  };
}

// ============================================================================
// ROSTER RENDERING
// ============================================================================

function rosterText(week) {
  const courts = groupPlayersIntoCourts(week.players);
  const lines = [];

  lines.push(`🏓 <b>Pickleball — ${fmtGameDate(week.date)}, ${CONFIG.game.label}</b>`);
  lines.push(`📍 <a href="${CONFIG.game.mapUrl}">${CONFIG.game.location}</a> · ${CONFIG.game.courts} courts`);
  if (week.phase === 'final') lines.push('🔒 <b>FINAL ROSTER</b>');
  lines.push('');

  if (courts.length === 0) {
    lines.push('<i>Nobody signed up yet — be the first!</i>');
  }

  for (const court of courts) {
    if (court.isConfirmed) {
      lines.push(`✅ <b>Court ${court.courtNumber} (CONFIRMED)</b>`);
    } else {
      lines.push(`⏳ <b>Waitlist / Filling Court ${court.courtNumber}</b>`);
    }
    court.players.forEach((player, idx) => {
      const pos = (court.courtNumber - 1) * CONFIG.playersPerCourt + idx + 1;
      lines.push(`  ${pos}. ${displayName(player)}`);
    });
    if (!court.isConfirmed) {
      const n = court.playersNeeded;
      lines.push(`<i>(Needs ${n} more player${n === 1 ? '' : 's'} to unlock this court)</i>`);
    }
    lines.push('');
  }

  lines.push(`👥 ${week.players.length} in`);
  return lines.join('\n');
}

/**
 * Verifies Telegram Mini App initData and returns the user, or null.
 *
 * Per Telegram: secret_key = HMAC_SHA256(bot_token, key="WebAppData"), then the
 * signature is HMAC_SHA256(data_check_string, key=secret_key). Never trust the
 * `user` field without this check — it's attacker-supplied otherwise.
 */
async function verifyInitData(env, initData) {
  if (!initData || !env.TELEGRAM_BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const checkString = [...params.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const enc = new TextEncoder();
  const hmac = async (keyBytes, msg) => {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
  };

  const secret = await hmac(enc.encode('WebAppData'), env.TELEGRAM_BOT_TOKEN);
  const sig = await hmac(secret, checkString);
  const hex = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== hash) return null;

  // Reject stale payloads (replay protection).
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

function signupPageHtml(week, done, viewer = null) {
  const courts = groupPlayersIntoCourts(week.players);
  let b = '';
  if (done) b += `<p class="msg">${esc(done)}</p>`;
  b += `<h1>🏓 Pickleball — ${fmtGameDate(week.date)}, ${CONFIG.game.label}</h1>`;
  b += `<p class="loc">📍 <a href="${CONFIG.game.mapUrl}" target="_blank" rel="noopener">${esc(CONFIG.game.location)}</a> · ${CONFIG.game.courts} courts</p>`;
  if (courts.length === 0) b += `<p><i>Nobody signed up yet — be the first!</i></p>`;
  for (const c of courts) {
    b += c.isConfirmed
      ? `<h2>✅ Court ${c.courtNumber} (CONFIRMED)</h2>`
      : `<h2>⏳ Waitlist / Filling Court ${c.courtNumber}</h2>`;
    b += '<ol>';
    for (const p of c.players) {
      // Telegram members are locked in (can't be dropped from the web) — badge
      // them so web visitors see the perk of joining. Guests already read as
      // "(guest of X)" via displayName.
      // Only a verified Mini App viewer can be identified — this is the "(me)"
      // a shared Telegram group message can never show.
      const me = viewer && p.key === `u:${viewer.id}` ? ' <span class="me">(me)</span>' : '';
      // A sponsor can drop each of their own guests individually.
      const mine = viewer && (p.guestOf === viewer.id || (viewer.isAdmin && p.key !== `u:${viewer.id}`));
      const drop = mine
        ? `<form method="POST" action="/signup" class="x"><input type="hidden" name="initData" value="${esc(viewer.initData)}"/><input type="hidden" name="guestKey" value="${esc(p.key)}"/><button name="action" value="dropguest" class="xbtn" title="Remove">✕</button></form>`
        : '';
      const linkBit =
        mine && p.inviteLink
          ? ` <a class="ilink" href="${p.inviteLink}" target="_blank" rel="noopener" title="Their claim link">🔗</a>`
          : '';
      b += `<li>${displayName(p)}${me}${linkBit}${drop}</li>`;
    }
    b += '</ol>';
    if (!c.isConfirmed) {
      const n = c.playersNeeded;
      b += `<p class="need">Needs ${n} more player${n === 1 ? '' : 's'} to unlock this court</p>`;
    }
  }
  if (viewer && viewer.isAdmin) {
    b += `<form method="POST" action="/signup" class="rename">
      <input type="hidden" name="initData" value="${esc(viewer.initData)}"/>
      <label>Event settings</label>
      <input name="location" value="${esc(CONFIG.game.location)}" placeholder="Location" maxlength="60"/>
      <input name="mapUrl" value="${esc(CONFIG.game.mapUrl)}" placeholder="Map link" maxlength="300"/>
      <input name="label" value="${esc(CONFIG.game.label)}" placeholder="Time, e.g. 6:00 AM" maxlength="20"/>
      <input name="courts" value="${CONFIG.game.courts}" placeholder="Courts" type="number" min="1" max="12"/>
      <input name="perCourt" value="${CONFIG.playersPerCourt}" placeholder="Players per court" type="number" min="2" max="8"/>
      <p class="fine">${CONFIG.game.courts} courts × ${CONFIG.playersPerCourt} = ${maxPlayers()} spots. Minimum to play: ${CONFIG.playersPerCourt}.</p>
      <button name="action" value="settings" class="guest wide">💾 Save event details</button>
      <p class="fine">Changing the time also moves the reminders and the calendar invite.</p>
    </form>`;
    b += `<p class="adminbar">🛠 <b>Admin controls</b> — only you can see these. The ✕ next to a name removes them (and any guests they brought).</p>`;
  }
  if (viewer) {
    const mineList = week.players.filter(
      (p) => p.guestOf === viewer.id || (viewer.isAdmin && p.key !== `u:${viewer.id}`)
    );
    if (mineList.length) {
      b += `<form method="POST" action="/signup" class="rename">
        <input type="hidden" name="initData" value="${esc(viewer.initData)}"/>
        <label>Rename someone</label>
        <select name="guestKey">${mineList
          .map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`)
          .join('')}</select>
        <input name="newName" placeholder="Their real name" maxlength="40" required/>
        <button name="action" value="rename" class="guest wide">✎ Save name</button>
        <p class="fine">If they later claim their spot with the link, their own Telegram name takes over.</p>
      </form>`;
    }
  }
  b += `<p>👥 ${week.players.length} signed up</p>`;
  // After adding a guest, surface the message to forward to them.
  if (done.startsWith('Added ') && (viewer?.inviteLink || CONFIG.telegramInviteUrl)) {
    b += `<div class="share">
      <h2>📨 Invite them</h2>
      <p>Send your guest this link — it's unique to them, works once, and adds them to the group in their own name:</p>
      <p class="snippet">${esc(viewer && viewer.inviteLink ? viewer.inviteLink : CONFIG.telegramInviteUrl)}</p>
      <p>Paste this with it:</p>
      <p class="snippet">Pickleball ${esc(fmtGameDate(week.date))} at ${esc(CONFIG.game.label)}, ${esc(CONFIG.game.location)}. Roster: ${CONFIG.webUrl}</p>
    </div>`;
  }
  if (viewer) {
    // Identity is proven by initData, so no name box — and the action is
    // contextual to whether this person is already on the roster.
    const onRoster = week.players.some((p) => p.key === `u:${viewer.id}`);
    b += `<form method="POST" action="/signup" class="f">
      <input type="hidden" name="initData" value="${esc(viewer.initData)}"/>
      ${
        onRoster
          ? `<button name="action" value="out" class="out wide">❌ I can no longer go</button>`
          : `<button name="action" value="in" class="in wide">${esc(joinLabel(week).replace('✅ ', ''))}</button>`
      }
      <button name="action" value="guest" class="guest wide">➕ Bring a guest</button>
    </form>`;
  }
  // Someone inside the Mini App is already in Telegram — don't sell them on it.
  const joinStep = viewer
    ? null
    : CONFIG.telegramInviteUrl
    ? `<li>Join the group: <a href="${CONFIG.telegramInviteUrl}" target="_blank" rel="noopener">tap to join</a></li>`
    : `<li>Ask the group organizer for the invite link.</li>`;
  if (joinStep) {
    const full = isFull(week);
    b += `<div class="tg">
      <h2>${full ? '🚫 All courts are full this week' : '🏓 Want to play?'}</h2>
      <p>${
        full
          ? `All ${CONFIG.game.courts} courts are booked. Join the group anyway — spots open up when people drop out.`
          : 'Sign-ups, roll call and last-minute openings all happen in our Telegram group. Join and you can claim a spot in one tap.'
      }</p>
      <p class="ctas">
        <a class="cta cta1" href="${CONFIG.telegramInviteUrl}" target="_blank" rel="noopener">👥 Join the group</a>
        <a class="cta cta2" href="${dmOptInUrl()}" target="_blank" rel="noopener">🔔 Get reminders from the bot</a>
      </p>
      <p class="fine">New to Telegram? <a href="https://telegram.org/apps" target="_blank" rel="noopener">Install it here</a> first — it's free.</p>
      </div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Pickleball Sign-Up</title><style>
  body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#111;background:#fafafa}
  h1{font-size:1.3rem}h2{font-size:1.05rem;margin:16px 0 4px}
  ol{margin:4px 0;padding-left:24px}li{margin:2px 0}
  .need{color:#b45309;font-size:.9rem;margin:2px 0}
  .msg{background:#dcfce7;padding:10px;border-radius:8px}
  .f{margin-top:24px;padding-top:16px;border-top:1px solid #ddd}
  input{width:100%;padding:12px;font-size:1rem;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
  .btns{display:flex;gap:10px;margin-top:10px}
  button{flex:1;padding:12px;font-size:1rem;border:0;border-radius:8px;color:#fff;cursor:pointer}
  .in{background:#16a34a}.out{background:#dc2626}
  .loc{margin:2px 0 12px;font-size:.95rem}
  .loc a,.tg a{color:#2563eb}
  .tg{margin-top:24px;padding:14px 16px;background:#eff6ff;border-radius:10px}
  .tg h2{font-size:1rem;margin:0 0 6px}
  .tg p{margin:0 0 8px;font-size:.9rem}
  .tg ol{margin:0;padding-left:20px}
  .tag{display:inline-block;font-size:.7rem;color:#2563eb;background:#eff6ff;border-radius:6px;padding:1px 6px;vertical-align:middle}
  .me{font-size:.8rem;color:#16a34a;font-weight:600}
  .wide{width:100%}
  .guest{background:#334155;margin-top:10px}
  .x{display:inline;margin-left:6px}
  .xbtn{background:#e2e8f0;color:#b91c1c;border:0;border-radius:6px;padding:1px 7px;font-size:.8rem;cursor:pointer;width:auto;flex:none}
  .rename{margin:12px 0;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#fff}
  .rename label{display:block;font-size:.8rem;font-weight:600;margin-bottom:6px}
  .rename select,.rename input{width:100%;padding:9px;margin-bottom:8px;border:1px solid #ccc;border-radius:8px;box-sizing:border-box;font-size:.9rem}
  .ilink{text-decoration:none;font-size:.85rem;margin-left:4px}
  .adminbar{background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:8px 10px;font-size:.82rem;margin:10px 0}
  .share{margin-top:20px;padding:14px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px}
  .share h2{font-size:1rem;margin:0 0 6px}
  .share p{margin:0 0 8px;font-size:.9rem}
  .ctas{display:flex;flex-direction:column;gap:8px;margin:10px 0 6px}
  .cta{display:block;text-align:center;padding:12px;border-radius:8px;text-decoration:none;font-weight:600;font-size:.95rem}
  .cta1{background:#2563eb;color:#fff}
  .cta2{background:#16a34a;color:#fff}
  .fine{font-size:.8rem;color:#555;margin:0}
  .snippet{background:#fff;border:1px dashed #d6d3d1;border-radius:8px;padding:10px;font-size:.85rem;word-break:break-word}
  </style></head><body${viewer ? ' data-tg="1"' : ''}>${b}
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script>
  (function () {
    var w = window.Telegram && window.Telegram.WebApp;
    if (!w) return;                       // plain browser — anonymous view
    w.ready(); w.expand();
    // Already personalised (server verified us), nothing more to do.
    if (document.body.dataset.tg) return;
    if (!w.initData) return;              // opened outside Telegram
    var f = document.createElement('form');
    f.method = 'POST'; f.action = '/signup';
    [['initData', w.initData], ['action', 'view']].forEach(function (kv) {
      var i = document.createElement('input');
      i.type = 'hidden'; i.name = kv[0]; i.value = kv[1];
      f.appendChild(i);
    });
    document.body.appendChild(f); f.submit();
  })();
  </script>
  </body></html>`;
}

/** Edits the live roster message in place; falls back to posting a new one. */
async function refreshRoster(env, chatId, week, { repost = false } = {}) {
  const text = rosterText(week);
  const keyboard = week.phase === 'final' ? undefined : rosterKeyboard(week);

  if (week.msgId && !repost) {
    const res = await tg(env, 'editMessageText', {
      chat_id: chatId,
      message_id: week.msgId,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    if (res.ok) return;
  }

  const res = await tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
  if (res.ok) {
    const prevMsgId = week.msgId;
    week.msgId = res.result.message_id;
    // Retire the previous roster pin first — otherwise every repost stacks up
    // and the pinned list fills with stale rosters.
    if (prevMsgId && prevMsgId !== week.msgId) {
      await tg(env, 'unpinChatMessage', { chat_id: chatId, message_id: prevMsgId });
    }
    // Pinning keeps the live roster easy to find; ignore failure if the bot
    // isn't an admin.
    await tg(env, 'pinChatMessage', { chat_id: chatId, message_id: week.msgId, disable_notification: true });
  }
}

// ============================================================================
// ROSTER MUTATIONS + DROP CASCADE
// ============================================================================

function findPlayer(week, key) {
  return week.players.findIndex((p) => p.key === key);
}

function addMember(week, from) {
  const key = `u:${from.id}`;
  if (findPlayer(week, key) !== -1) return false;
  week.players.push({ key, id: from.id, name: fullName(from) });
  return true;
}

/**
 * Next free placeholder label for a sponsor: "John's guest", then
 * "John's guest 2", ... Lets someone hold a spot in one tap, no typing.
 */
function nextGuestLabel(week, sponsorName) {
  const base = `${sponsorName}'s guest`;
  const taken = (label) => week.players.some((p) => p.name.toLowerCase() === label.toLowerCase());
  if (!taken(base)) return base;
  for (let i = 2; i <= 20; i++) {
    if (!taken(`${base} ${i}`)) return `${base} ${i}`;
  }
  return `${base} 21`;
}

/**
 * One-line status for announcements. Editing the pinned roster is silent, so
 * anything that changes the roster from the web posts a real message carrying
 * this — otherwise the group never learns the headcount moved.
 */
function headcountLine(week) {
  const courts = groupPlayersIntoCourts(week.players);
  const confirmed = courts.filter((c) => c.isConfirmed).length;
  const partial = courts.find((c) => !c.isConfirmed);
  let s = `👥 ${week.players.length} in`;
  if (confirmed) s += ` · ${confirmed} court${confirmed === 1 ? '' : 's'} confirmed`;
  if (partial) s += ` · ${partial.playersNeeded} more to fill the next`;
  return s;
}

// ---------------------------------------------------------------------------
// DIRECT MESSAGES
// A bot may only DM someone who has already opened it and pressed Start, so we
// record each opted-in user's private chat id and fall back to a group mention.
// ---------------------------------------------------------------------------

// Notification categories a person can switch off individually.
const DM_PREFS = [
  { key: 'promo', label: 'Spot opened / you moved up' },
  { key: 'guest', label: 'Your guest activity + invite links' },
  { key: 'reminders', label: 'Roll call and last call' },
];

async function getDmRecord(env, userId) {
  return await kvGet(env, `dm:${userId}`);
}

function prefEnabled(rec, category) {
  if (!rec) return false;
  if (rec.muted) return false;
  if (!category) return true;
  return rec.prefs ? rec.prefs[category] !== false : true;
}

function notificationsCard(rec) {
  const rows = DM_PREFS.map((p) => [
    {
      text: `${prefEnabled(rec, p.key) ? '✅' : '❌'} ${p.label}`,
      callback_data: `pref:${p.key}`,
    },
  ]);
  rows.push([
    { text: rec && rec.muted ? '🔔 Turn all messages back on' : '🔕 Mute everything', callback_data: 'pref:mute' },
  ]);
  return {
    text:
      '🔔 <b>Your notifications</b>\n' +
      (rec && rec.muted
        ? 'Everything is muted — you\'ll only see updates in the group.'
        : 'Tap any line to switch it off or back on.'),
    reply_markup: { inline_keyboard: rows },
  };
}

async function getDmChat(env, userId) {
  const v = await kvGet(env, `dm:${userId}`);
  return v ? v.chatId : null;
}

/** DMs an opted-in user. Returns true when actually delivered. */
async function dmUser(env, userId, text, extra = {}, category = null) {
  const rec = await getDmRecord(env, userId);
  if (!rec || !rec.chatId) return false;
  if (!prefEnabled(rec, category)) return false; // opted out of this kind
  const chatId = rec.chatId;
  const res = await tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
  return !!res.ok;
}

/** Deep link that opts a user in to DMs (and optionally carries a payload). */
function dmOptInUrl(payload = 'dm') {
  return `https://t.me/${CONFIG.botUsername}?start=${payload}`;
}

/**
 * Tells one person something: privately when they've opted in, otherwise via a
 * group @mention so they still get pinged. Keeps personal chatter out of the
 * group whenever we're able to.
 */
async function notifyPlayer(env, groupChatId, user, text, extra = {}) {
  if (await dmUser(env, user.id, text, extra, user.category || null)) return 'dm';
  await tg(env, 'sendMessage', {
    chat_id: groupChatId,
    text: `${mention(user)} — ${text}`,
    parse_mode: 'HTML',
    ...extra,
  });
  return 'group';
}

// ---------------------------------------------------------------------------
// GUEST CLAIM BY INVITE LINK
// Each placeholder gets its own single-use group invite link. Telegram reports
// which link a joiner used (ChatMemberUpdated.invite_link), so one tap both
// joins the group and claims the spot — no tokens for anyone to paste.
// ---------------------------------------------------------------------------

async function liveGroupId(env, fallback) {
  const live = await kvGet(env, 'chat:live');
  return live ? live.chatId : fallback;
}

async function isGroupAdmin(env, groupId, userId) {
  const m = await tg(env, 'getChatMember', { chat_id: groupId, user_id: userId });
  return m.ok && ['creator', 'administrator'].includes(m.result.status);
}

async function mintGuestInvite(env, chatId, week, player) {
  // In test mode `chat` points at a DM, and you cannot mint an invite link for
  // a private chat — always target the real group.
  const live = await kvGet(env, 'chat:live');
  const target = live ? live.chatId : chatId;
  const res = await tg(env, 'createChatInviteLink', {
    chat_id: target,
    name: player.name.slice(0, 32),
    member_limit: 1, // single use: a forwarded link dies after the first join
  });
  if (!res.ok) return null;
  const link = res.result.invite_link;
  await kvPut(env, `invite:${link}`, { date: week.date, key: player.key });
  player.inviteLink = link; // so it can be re-shown if the sponsor loses it
  return link;
}

/** A new member joined — if they used a guest link, they claim that spot. */
async function handleChatMember(env, upd) {
  const oldStatus = upd.old_chat_member && upd.old_chat_member.status;
  const newStatus = upd.new_chat_member && upd.new_chat_member.status;
  const joined =
    ['member', 'administrator', 'creator'].includes(newStatus) && ['left', 'kicked'].includes(oldStatus);
  if (!joined) return;

  const link = upd.invite_link && upd.invite_link.invite_link;
  if (!link) return;
  const rec = await kvGet(env, `invite:${link}`);
  if (!rec) return;

  await env.PICKLE_KV.delete(`invite:${link}`); // one claim only
  const currentDate = activeGameDate(new Date());
  const user = upd.new_chat_member.user;

  // Link from a game that has already happened: they're in the group, but
  // there's no spot to claim. Welcome them and point at the live roster.
  if (rec.date !== currentDate) {
    await dmUser(
      env,
      user.id,
      `👋 Welcome! That invite was for ${fmtGameDate(rec.date)}, which has already been played.\nThe next game is <b>${fmtGameDate(currentDate)}, ${CONFIG.game.label}</b> at ${esc(CONFIG.game.location)} — tap ✅ I'm in on the roster to grab a spot.`
    );
    return;
  }

  const week = await getWeek(env, rec.date);
  const idx = week.players.findIndex((p) => p.key === rec.key);

  // The spot they were invited to is gone (usually the sponsor dropped out).
  // They're still in the group — welcome them and let them claim their own.
  if (idx === -1) {
    await dmUser(
      env,
      user.id,
      `👋 Welcome! The spot you were invited to has since been given up, but you're in the group now.\n<b>${fmtGameDate(week.date)}, ${CONFIG.game.label}</b> at ${esc(CONFIG.game.location)} — tap ✅ I'm in on the roster to take a spot.`
    );
    return;
  }

  const chatConf = await kvGet(env, 'chat');
  if (!chatConf) return;
  const placeholder = week.players[idx];
  const sponsorId = placeholder.guestOf;
  const sponsorName = placeholder.guestOfName;
  const selfKey = `u:${user.id}`;

  if (week.players.some((p) => p.key === selfKey)) {
    week.players.splice(idx, 1); // they were already on under their own name
  } else {
    // Convert in place: same queue position, now their own identity, and no
    // longer cascading off their sponsor.
    week.players[idx] = { key: selfKey, id: user.id, name: fullName(user) };
  }

  await saveWeek(env, week);
  await refreshRoster(env, chatConf.chatId, week);

  const who = fullName(user);
  await tg(env, 'sendMessage', {
    chat_id: chatConf.chatId,
    text: `🎉 <b>${esc(who)}</b> joined and claimed ${esc(sponsorName || 'a')}'s guest spot.\n${headcountLine(week)}`,
    parse_mode: 'HTML',
  });
  if (sponsorId) {
    await dmUser(env, sponsorId, `✅ <b>${esc(who)}</b> claimed the guest spot you saved. They manage their own attendance now.`);
  }
  await dmUser(
    env,
    user.id,
    `👋 Welcome! You're on the roster for <b>${fmtGameDate(week.date)}, ${CONFIG.game.label}</b> at ${esc(CONFIG.game.location)}.`,
    { reply_markup: { inline_keyboard: [[{ text: '🌐 Manage my spot', url: CONFIG.miniAppUrl || CONFIG.webUrl }]] } }
  );
}

/**
 * Announce what changed, then re-post the roster underneath it. The roster
 * carries the buttons, so it stays the last (and actionable) message.
 */
async function postChange(env, chatId, week, line) {
  if (line) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: line, parse_mode: 'HTML' });
  }
  await refreshRoster(env, chatId, week, { repost: true });
}

async function announceWeb(env, chatId, week, line) {
  await postChange(env, chatId, week, `${line}\n${headcountLine(week)}`);
}

/** Hard ceiling on sign-ups: every court at the venue, full. */
function maxPlayers() {
  return CONFIG.game.courts * CONFIG.playersPerCourt;
}

function isFull(week) {
  return week.players.length >= maxPlayers();
}

/** How many courts are currently full (4/4). */
function confirmedCourtCount(players) {
  return groupPlayersIntoCourts(players).filter((c) => c.isConfirmed).length;
}

/**
 * True when a drop knocked a previously-full court back to incomplete — the
 * moment the group actually needs to hear about it ("we need 1 more"),
 * regardless of which phase the week is in.
 */
function brokeAConfirmedCourt(beforePlayers, afterPlayers) {
  return confirmedCourtCount(afterPlayers) < confirmedCourtCount(beforePlayers);
}

/** Removes a member and any guests they sponsored. Returns removed entries. */
function removeMember(week, userId) {
  const removed = week.players.filter((p) => p.key === `u:${userId}` || p.guestOf === userId);
  week.players = week.players.filter((p) => !removed.includes(p));
  return removed;
}

/**
 * After a drop, everyone below shifts up (the queue keeps sign-up order).
 * This compares court assignments before vs. after and reports promotions
 * ("Eve moves up to Court 1") plus which court is now short.
 */
/**
 * Who moved up a court as a result of a drop. Returns the player objects (not
 * just text) so each one can be told individually.
 */
function computePromotions(beforePlayers, week) {
  const before = new Map();
  beforePlayers.forEach((p, i) => before.set(p.key, Math.floor(i / CONFIG.playersPerCourt) + 1));

  const moved = [];
  week.players.forEach((p, i) => {
    const court = Math.floor(i / CONFIG.playersPerCourt) + 1;
    if (before.has(p.key) && before.get(p.key) > court) {
      moved.push({ player: p, court, confirmed: groupPlayersIntoCourts(week.players)[court - 1]?.isConfirmed });
    }
  });
  return moved;
}

/** Players sitting beyond the last full court — i.e. the backfill bench. */
function waitlistDepth(week) {
  return Math.max(0, week.players.length - confirmedCourtCount(week.players) * CONFIG.playersPerCourt);
}

/**
 * Tells each promoted player the good news directly (DM when opted in, else a
 * group @mention), including whether anyone is behind them to backfill.
 */
async function notifyPromotions(env, groupChatId, week, promotions) {
  const depth = waitlistDepth(week);
  for (const { player, court, confirmed } of promotions) {
    // Guests have no Telegram identity — tell whoever is sponsoring them.
    const targetId = player.id || player.guestOf;
    if (!targetId) continue; // web-only signup: unreachable
    const aboutGuest = !player.id && player.guestOf;

    const headline = confirmed
      ? `🎉 A spot opened up — ${aboutGuest ? `your guest <b>${esc(player.name)}</b> is` : `you're`} now <b>confirmed on Court ${court}</b>.`
      : `⬆️ ${aboutGuest ? `Your guest <b>${esc(player.name)}</b> moved` : `You moved`} up to <b>Court ${court}</b>.`;

    const tail =
      confirmed && depth === 0
        ? `\n\nJust so you know, there's nobody on the waitlist right now — if this spot opens up again the court would be short.`
        : '';

    await notifyPlayer(
      env,
      groupChatId,
      { id: targetId, name: player.guestOfName || player.name, category: 'promo' },
      `${headline}\n${fmtGameDate(week.date)}, ${CONFIG.game.label} · ${CONFIG.game.location}${tail}`,
      { reply_markup: { inline_keyboard: [[{ text: '🌐 Manage my spot', url: CONFIG.miniAppUrl || CONFIG.webUrl }]] } }
    );
  }
}

function describeCascade(beforePlayers, week, removedNames) {
  const promoted = computePromotions(beforePlayers, week).map(
    (m) => `${m.player.name} moves up to Court ${m.court}`
  );

  const lines = [`⚠️ <b>${esc(removedNames.join(', '))}</b> can no longer make it.`];
  for (const move of promoted) lines.push(`⬆️ ${esc(move)}`);

  const courts = groupPlayersIntoCourts(week.players);
  const partial = courts.find((c) => !c.isConfirmed);
  if (partial) {
    const n = partial.playersNeeded;
    lines.push(`We now need <b>${n}</b> more player${n === 1 ? '' : 's'}.`);
  }
  return lines.join('\n');
}

/**
 * Roll call for sponsors: privately ask each person bringing guests whether
 * those guests are still coming, so unconfirmed spots can be freed early
 * rather than discovered on the morning.
 */
async function askSponsorsToConfirmGuests(env, week) {
  const bySponsor = new Map();
  for (const p of week.players) {
    if (!p.guestOf) continue;
    if (!bySponsor.has(p.guestOf)) bySponsor.set(p.guestOf, []);
    bySponsor.get(p.guestOf).push(p);
  }

  for (const [sponsorId, guests] of bySponsor) {
    const rows = guests.map((g) => [
      { text: `❌ ${g.name} can't make it`, callback_data: `gcancel:${g.key}` },
    ]);
    rows.unshift([{ text: `✅ All still coming`, callback_data: 'gconfirm' }]);
    if (guests.length > 1) rows.push([{ text: '❌ Cancel all my guests', callback_data: 'gcancelall' }]);

    await dmUser(
      env,
      sponsorId,
      `🌙 Pickleball tomorrow, ${CONFIG.game.label}.\n\nYou're bringing ${guests
        .map((g) => `<b>${esc(g.name)}</b>`)
        .join(' and ')}. Still good?\n\nIgnore this if nothing's changed.`,
      { reply_markup: { inline_keyboard: rows } },
      'guest'
    );
  }
}

/**
 * A sponsor's guests leave with them — the roster should never hold spots
 * nobody owns. But the guests may still want to play, so hand their claim
 * links back privately: those links still add them to the group, where they
 * can take a spot in their own name.
 */
async function offerGuestLinksAfterDrop(env, sponsorId, removed) {
  const guests = removed.filter((r) => r.guestOf === sponsorId);
  if (!guests.length) return;

  const lines = [
    `👋 Your ${guests.length === 1 ? 'guest came' : `${guests.length} guests came`} off the roster with you.`,
    '',
  ];
  const withLinks = guests.filter((g) => g.inviteLink);
  if (withLinks.length) {
    lines.push("If they'd still like to play, send them their own link — it adds them to the group so they can grab a spot themselves:");
    for (const g of withLinks) lines.push(`• <b>${esc(g.name)}</b> — ${g.inviteLink}`);
  }
  const noLinks = guests.filter((g) => !g.inviteLink);
  if (noLinks.length && CONFIG.telegramInviteUrl) {
    lines.push(
      `${withLinks.length ? '' : "If they'd still like to play, "}send ${noLinks
        .map((g) => `<b>${esc(g.name)}</b>`)
        .join(' and ')} the group link: ${CONFIG.telegramInviteUrl}`
    );
  }
  await dmUser(env, sponsorId, lines.join('\n'), {}, 'guest');
}

/** Recruiting push: mention partial-court members + standby pool, add Claim button. */
async function sendRecruitingAlert(env, chatId, week, intro) {
  const courts = groupPlayersIntoCourts(week.players);
  const partial = courts.find((c) => !c.isConfirmed);
  if (!partial) return;

  const standby = await kvGet(env, 'standby', []);
  const lines = [];
  if (intro) lines.push(intro);

  const n = partial.playersNeeded;
  lines.push(`🚨 <b>${n} spot${n === 1 ? '' : 's'} open</b> for ${fmtGameDate(week.date)} — first to tap plays!`);

  const partialMembers = partial.players.filter((p) => p.id);
  if (partialMembers.length > 0) {
    lines.push(`${partialMembers.map(mention).join(', ')} — know someone? Add them with /guest Name or forward this message.`);
  }
  if (standby.length > 0) {
    lines.push(`📣 Standby pool: ${standby.map(mention).join(', ')}`);
  }

  await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '🖐 Claim a spot', callback_data: 'in' }]] },
  });
}

// ============================================================================
// WEBHOOK: commands + button taps
// ============================================================================

async function handleCallback(env, cb) {
  const chatConf = await kvGet(env, 'chat');
  const answer = (text, alert = false) =>
    tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert });

  if (!chatConf) return answer('Bot not set up yet — an admin must run /setup in the group.');

  const week = await getWeek(env, activeGameDate(new Date()));
  const from = cb.from;

  if (cb.data === 'gconfirm') {
    return answer('Great — nothing changed. Thanks for confirming!', true);
  }

  if (cb.data === 'gcancel' || cb.data === 'gcancelall' || cb.data.startsWith('gcancel:')) {
    const all = cb.data === 'gcancelall';
    const key = all ? null : cb.data.slice('gcancel:'.length);
    const before = [...week.players];
    const doomed = week.players.filter((p) =>
      all ? p.guestOf === from.id : p.key === key && p.guestOf === from.id
    );
    if (doomed.length === 0) return answer('That guest is already off the roster.', true);
    week.players = week.players.filter((p) => !doomed.includes(p));
    await saveWeek(env, week);
    const names = doomed.map((d) => d.name);
    await postChange(
      env,
      chatConf.chatId,
      week,
      `❌ <b>${esc(names.join(', '))}</b> can no longer make it.\n${headcountLine(week)}`
    );
    await sendRecruitingAlert(env, chatConf.chatId, week, null);
    await notifyPromotions(env, chatConf.chatId, week, computePromotions(before, week));
    return answer(`Removed ${names.join(', ')}. Thanks for the heads-up!`, true);
  }

  if (cb.data.startsWith('pref:')) {
    const which = cb.data.slice(5);
    const rec = (await getDmRecord(env, from.id)) || { chatId: cb.message && cb.message.chat.id };
    if (which === 'show') {
      const card = notificationsCard(rec);
      await tg(env, 'sendMessage', {
        chat_id: cb.message.chat.id,
        text: card.text,
        parse_mode: 'HTML',
        reply_markup: card.reply_markup,
      });
      return answer('');
    }
    if (which === 'mute') rec.muted = !rec.muted;
    else {
      rec.prefs = rec.prefs || {};
      rec.prefs[which] = rec.prefs[which] === false;
    }
    await kvPut(env, `dm:${from.id}`, rec);
    const card = notificationsCard(rec);
    await tg(env, 'editMessageText', {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: card.text,
      parse_mode: 'HTML',
      reply_markup: card.reply_markup,
    });
    return answer('Updated.');
  }

  if (cb.data === 'guest') {
    if (!week.players.some((p) => p.key === `u:${from.id}`)) {
      return answer("Tap \"I'm in\" first — guests are added under someone who's playing.", true);
    }
    if (isFull(week)) return answer(`All ${CONFIG.game.courts} courts are full (${maxPlayers()} players).`, true);
    // One tap holds the spot under a placeholder name — no typing, no command.
    const sponsor = fullName(from);
    const label = nextGuestLabel(week, sponsor);
    const newGuest = { key: `g:${from.id}:${label.toLowerCase()}`, name: label, guestOf: from.id, guestOfName: sponsor };
    week.players.push(newGuest);
    await saveWeek(env, week);

    // One-use link bound to THIS placeholder: tapping it joins the group and
    // claims this exact spot.
    const link = await mintGuestInvite(env, chatConf.chatId, week, newGuest);
    await saveWeek(env, week); // persist the stored claim link

    const personal = link
      ? `✅ Spot saved for your guest.\n\nSend them this:\n\n<i>Pickleball ${fmtGameDate(week.date)}, ${CONFIG.game.label} at ${esc(CONFIG.game.location)}. You're on the list — tap to join us: ${link}</i>\n\nThat link is just for them and works once. When they tap it they're in the group and the spot becomes theirs.`
      : `➕ Added <b>${esc(label)}</b>. I couldn't make an invite link though — check I'm an admin with "Invite Users via Link".`;

    // Instructions are for the sponsor only; the group just needs the count.
    const sentPrivately = await dmUser(env, from.id, personal, {}, 'guest');
    await tg(env, 'sendMessage', {
      chat_id: chatConf.chatId,
      text: sentPrivately
        ? `➕ ${mention({ id: from.id, name: sponsor })} added <b>${esc(label)}</b>.\n${headcountLine(week)}`
        : `➕ ${mention({ id: from.id, name: sponsor })} added <b>${esc(label)}</b>.\n${headcountLine(week)}${
            link ? `\n\nShare this one-use link with them — it claims this spot:\n${link}` : ''
          }\n<i>Tip: <a href="${dmOptInUrl()}">turn on personal updates</a> and I'll send these privately.</i>`,
      parse_mode: 'HTML',
    });
    return answer(`Added ${label}.`);
  }

  if (week.phase === 'final') {
    if (cb.data === 'out') {
      // Late drops still allowed — they trigger the standby scramble.
      const before = [...week.players];
      const removed = removeMember(week, from.id);
      if (removed.length === 0) return answer("You weren't on the roster.");
      await saveWeek(env, week);
      await refreshRoster(env, chatConf.chatId, week, { repost: false });
      await tg(env, 'sendMessage', {
        chat_id: chatConf.chatId,
        text: describeCascade(before, week, removed.map((r) => r.name)),
        parse_mode: 'HTML',
      });
      await sendRecruitingAlert(env, chatConf.chatId, week, null);
      await notifyPromotions(env, chatConf.chatId, week, computePromotions(before, week));
      return answer("You're out. The standby pool has been pinged.");
    }
    // 'in' taps on the final roster still work (claiming an open spot).
  }

  if (cb.data === 'in') {
    if (week.players.some((p) => p.key === `u:${from.id}`)) {
      const spot = week.players.findIndex((p) => p.key === `u:${from.id}`) + 1;
      const c = Math.floor((spot - 1) / CONFIG.playersPerCourt) + 1;
      return answer(`You're already in — #${spot}, Court ${c}. Tap "Can't make it" to drop out.`, true);
    }
    if (isFull(week)) return answer(`All ${CONFIG.game.courts} courts are full (${maxPlayers()} players).`, true);
    addMember(week, from);
    await saveWeek(env, week);
    const pos = week.players.length;
    const court = Math.floor((pos - 1) / CONFIG.playersPerCourt) + 1;
    await postChange(env, chatConf.chatId, week, `✅ <b>${esc(fullName(from))}</b> is in.\n${headcountLine(week)}`);
    await dmUser(
      env,
      from.id,
      `🏓 You're in for <b>${fmtGameDate(week.date)}, ${CONFIG.game.label}</b> at ${esc(CONFIG.game.location)}.`,
      { reply_markup: { inline_keyboard: calendarButtons(week) } },
      'reminders'
    );
    return answer(`You're in — #${pos}, Court ${court}.`);
  }

  if (cb.data === 'out') {
    const before = [...week.players];
    const removed = removeMember(week, from.id);
    if (removed.length === 0) {
      return answer("You're not on the roster this week, so there's nothing to drop.", true);
    }
    await saveWeek(env, week);
    const alsoGuests = removed.length - 1;
    await postChange(
      env,
      chatConf.chatId,
      week,
      `❌ <b>${esc(fullName(from))}</b> can no longer make it${
        alsoGuests > 0 ? ` (and their ${alsoGuests} guest${alsoGuests === 1 ? '' : 's'})` : ''
      }.\n${headcountLine(week)}`
    );
    await offerGuestLinksAfterDrop(env, from.id, removed);
    // Announce when a full court just broke, or any time after roll call.
    if (brokeAConfirmedCourt(before, week.players) || week.phase === 'rollcall' || week.phase === 'urgent') {
      await tg(env, 'sendMessage', {
        chat_id: chatConf.chatId,
        text: describeCascade(before, week, removed.map((r) => r.name)),
        parse_mode: 'HTML',
      });
      await sendRecruitingAlert(env, chatConf.chatId, week, null);
    }
    await notifyPromotions(env, chatConf.chatId, week, computePromotions(before, week));
    return answer("You're out. Thanks for the heads-up!");
  }

  return answer('');
}

async function handleCommand(env, msg) {
  const text = (msg.text || '').trim();
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.split('@')[0].toLowerCase(); // '/guest@MyBot' -> '/guest'
  const chatId = msg.chat.id;
  const from = msg.from;
  const say = (t, extra = {}) => tg(env, 'sendMessage', { chat_id: chatId, text: t, parse_mode: 'HTML', ...extra });

  // ANY private message proves we can reach this person, so record the chat.
  // (People who pressed Start before this existed were never captured.)
  if (msg.chat.type === 'private') {
    const existing = (await getDmRecord(env, from.id)) || {};
    await kvPut(env, `dm:${from.id}`, { ...existing, chatId, name: fullName(from) });
  }

  if ((cmd === '/notifications' || cmd === '/settings') && msg.chat.type === 'private') {
    const card = notificationsCard(await getDmRecord(env, from.id));
    return say(card.text, { reply_markup: card.reply_markup });
  }

  // Sandbox: point the bot at this DM so testing doesn't spam the group.
  if (cmd === '/testmode' && msg.chat.type === 'private') {
    const live = await kvGet(env, 'chat');
    if (live && live.chatId !== chatId) await kvPut(env, 'chat:live', live);
    await kvPut(env, 'chat', { chatId });
    const week = await getWeek(env, activeGameDate(new Date()));
    week.msgId = null; // the live roster message lives in the group
    await saveWeek(env, week);
    return say(
      '🧪 <b>Test mode on.</b> Every bot message now comes here instead of the group, so you can poke at things without spamming anyone.\n\nThe roster data is shared — changes you make here are real. Send /livemode when you\'re done.'
    );
  }

  if (cmd === '/livemode' && msg.chat.type === 'private') {
    const live = await kvGet(env, 'chat:live');
    if (!live) return say('No saved group binding — run /setup inside the group.');
    await kvPut(env, 'chat', live);
    await env.PICKLE_KV.delete('chat:live');
    const week = await getWeek(env, activeGameDate(new Date()));
    week.msgId = null; // force a fresh roster post back in the group
    await saveWeek(env, week);
    return say('✅ <b>Back to live.</b> Messages go to the group again.');
  }

  if (cmd === '/start' && msg.chat.type === 'private') {
    const buttons = [];
    if (CONFIG.telegramInviteUrl) {
      buttons.push([{ text: '👥 Join the group', url: CONFIG.telegramInviteUrl }]);
    }
    buttons.push([{ text: '🔔 Manage notifications', callback_data: 'pref:show' }]);
    return say(
      `🔔 You're all set.\n\nI'll ping you here when a spot opens up, when you move onto a court, or when your guest joins — so the group chat stays quiet.\n\n/notifications to change what I send you.`,
      { reply_markup: { inline_keyboard: buttons } }
    );
  }

  if (cmd === '/setup') {
    // Only group admins may bind the bot to a group.
    if (msg.chat.type === 'private') return say('Run /setup inside your pickleball group.');
    const member = await tg(env, 'getChatMember', { chat_id: chatId, user_id: from.id });
    const status = member.ok ? member.result.status : 'unknown';
    if (status !== 'creator' && status !== 'administrator') {
      return say('Only a group admin can run /setup.');
    }
    await kvPut(env, 'chat', { chatId });
    const week = await getWeek(env, activeGameDate(new Date()));
    await saveWeek(env, week);
    await say(`✅ Bot bound to this group. Game: <b>every ${CONFIG.game.weekday} ${CONFIG.game.label}</b> (${CONFIG.timezone}).`);
    return refreshRoster(env, chatId, week, { repost: true });
  }

  const chatConf = await kvGet(env, 'chat');
  if (!chatConf || chatConf.chatId !== chatId) return; // ignore other chats

  const week = await getWeek(env, activeGameDate(new Date()));

  if (cmd === '/status') {
    return refreshRoster(env, chatId, week, { repost: true });
  }

  if (cmd === '/in') {
    if (addMember(week, from)) {
      await saveWeek(env, week);
      await refreshRoster(env, chatId, week);
    }
    return;
  }

  if (cmd === '/out') {
    const before = [...week.players];
    const removed = removeMember(week, from.id);
    if (removed.length > 0) {
      await saveWeek(env, week);
      await refreshRoster(env, chatId, week);
      if (week.phase !== 'open' || brokeAConfirmedCourt(before, week.players)) {
        await say(describeCascade(before, week, removed.map((r) => r.name)));
        await sendRecruitingAlert(env, chatId, week, null);
      }
      await notifyPromotions(env, chatId, week, computePromotions(before, week));
      await offerGuestLinksAfterDrop(env, from.id, removed);
    }
    return;
  }

  // Organiser escape hatch: remove ANY roster entry by name. Covers guests,
  // no-shows, and legacy web signups that nothing else can clear.
  // Opens the Mini App (admin controls live in there for group admins).
  if (cmd === '/manage') {
    return say('Roster controls:', {
      reply_markup: { inline_keyboard: [[{ text: '🛠 Open roster', url: CONFIG.miniAppUrl || CONFIG.webUrl }]] },
    });
  }

  if (cmd === '/calendar') {
    const week = await getWeek(env, activeGameDate(new Date()));
    return say(`📅 ${fmtGameDate(week.date)}, ${CONFIG.game.label} at ${esc(CONFIG.game.location)}`, {
      reply_markup: { inline_keyboard: calendarButtons(week) },
    });
  }

  if (cmd === '/setlocation' || cmd === '/settime' || cmd === '/setcourts') {
    if (msg.chat.type !== 'private') {
      const m = await tg(env, 'getChatMember', { chat_id: chatId, user_id: from.id });
      const st = m.ok ? m.result.status : 'unknown';
      if (st !== 'creator' && st !== 'administrator') return say('Admins only.');
    }
    const value = args.join(' ').trim();
    const current = (await kvGet(env, 'settings')) || {};
    if (!value) {
      return say(
        `Current: <b>${esc(CONFIG.game.location)}</b>, ${esc(CONFIG.game.label)}, ${CONFIG.game.courts} courts.\n` +
          'Usage: /setlocation Name | https://maps-link · /settime 6:30 AM · /setcourts 3'
      );
    }
    if (cmd === '/setlocation') {
      const [name, mapUrl] = value.split('|').map((x) => x.trim());
      current.location = name;
      if (mapUrl) current.mapUrl = mapUrl;
      else current.mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`;
    } else if (cmd === '/settime') {
      const hour = parseHour(value);
      if (hour === null) return say('Try: /settime 6:30 AM');
      current.label = value;
      current.hour = hour;
    } else {
      const n = parseInt(value, 10);
      if (Number.isNaN(n) || n < 1 || n > 12) return say('Try: /setcourts 4');
      current.courts = n;
    }
    await kvPut(env, 'settings', current);
    Object.assign(CONFIG.game, current);
    const week = await getWeek(env, activeGameDate(new Date()));
    await say(
      `✅ Updated. Now: <b>${esc(CONFIG.game.location)}</b>, ${esc(CONFIG.game.label)}, ${CONFIG.game.courts} courts.`
    );
    const conf = await kvGet(env, 'chat');
    if (conf) await refreshRoster(env, conf.chatId, week, { repost: true });
    return;
  }

  if (cmd === '/kick') {
    const name = args.join(' ').trim();
    if (!name) return say('Usage: /kick Name — removes anyone from this week\'s roster.');
    const member = await tg(env, 'getChatMember', { chat_id: chatId, user_id: from.id });
    const status = member.ok ? member.result.status : 'unknown';
    if (status !== 'creator' && status !== 'administrator') {
      return say(
        `Only a group admin can use /kick. Telegram reports your status here as <b>${esc(status)}</b>` +
          (member.ok ? '.' : ` (lookup failed: ${esc(member.description || 'unknown error')}).`)
      );
    }
    const idx = week.players.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (idx === -1) return say(`No one named "${esc(name)}" on the roster.`);
    const before = [...week.players];
    const [gone] = week.players.splice(idx, 1);
    // Guests stay put — removing them is a separate, deliberate choice.
    await saveWeek(env, week);
    await refreshRoster(env, chatId, week);
    await say(describeCascade(before, week, [gone.name]));
    await notifyPromotions(env, chatId, week, computePromotions(before, week));
    return;
  }

  if (cmd === '/guest') {
    const name = args.join(' ').trim();
    if (!name) return say('Usage: /guest FirstName — adds a guest under your name.');
    if (isFull(week)) return say(`All ${CONFIG.game.courts} courts are full (${maxPlayers()} players).`);
    const key = `g:${from.id}:${name.toLowerCase()}`;
    if (findPlayer(week, key) !== -1) return say(`${esc(name)} is already on the roster.`);
    week.players.push({ key, name, guestOf: from.id, guestOfName: fullName(from) });
    await saveWeek(env, week);
    return refreshRoster(env, chatId, week);
  }

  if (cmd === '/unguest') {
    const name = args.join(' ').trim();
    const key = `g:${from.id}:${name.toLowerCase()}`;
    const idx = findPlayer(week, key);
    if (idx === -1) return say(`No guest named "${esc(name)}" under your name.`);
    const before = [...week.players];
    week.players.splice(idx, 1);
    await saveWeek(env, week);
    await refreshRoster(env, chatId, week);
    if (week.phase !== 'open' || brokeAConfirmedCourt(before, week.players)) {
      await say(describeCascade(before, week, [name]));
      await sendRecruitingAlert(env, chatId, week, null);
    }
    await notifyPromotions(env, chatId, week, computePromotions(before, week));
    return;
  }

  if (cmd === '/standby') {
    const standby = await kvGet(env, 'standby', []);
    const existing = standby.findIndex((s) => s.id === from.id);
    if (existing === -1) {
      standby.push({ id: from.id, name: fullName(from) });
      await kvPut(env, 'standby', standby);
      return say(`🖐 ${esc(fullName(from))} joined the standby pool — you'll be pinged when a late spot opens.`);
    }
    standby.splice(existing, 1);
    await kvPut(env, 'standby', standby);
    return say(`${esc(fullName(from))} left the standby pool.`);
  }

  if (cmd === '/help') {
    return say(
      [
        '🏓 <b>Pickleball Bot</b>',
        'Tap the buttons on the roster message, or:',
        '/in — reserve your spot',
        '/out — drop out (waitlist auto-promotes)',
        '/guest Name — add a guest (no Telegram needed)',
        '/unguest Name — remove your guest',
        '/standby — get pinged when late spots open',
        '/status — repost the live roster',
        '',
        `Game: every ${CONFIG.game.weekday} ${CONFIG.game.label} Pacific. Roll call Wed 7pm, cutoff 9:30pm, final roster 5:15am.`,
      ].join('\n')
    );
  }
}

// ============================================================================
// SCHEDULED SLOTS (cron: every 15 min; act only at the configured local times)
// ============================================================================

async function runSlot(env, slotId, now) {
  const chatConf = await kvGet(env, 'chat');
  if (!chatConf) return; // not set up yet
  const chatId = chatConf.chatId;
  const week = await getWeek(env, activeGameDate(now));
  const label = `${fmtGameDate(week.date)}, ${CONFIG.game.label}`;

  if (slotId === 'open') {
    // Fires after this week's game, so activeGameDate has rolled to NEXT week.
    week.msgId = null;
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `🏓 <b>${label}</b> is open. First in, first on court.`,
      parse_mode: 'HTML',
    });
    await refreshRoster(env, chatId, week, { repost: true });
    await saveWeek(env, week);
  }

  if (slotId === 'rollcall-mon') {
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `🏓 <b>${label}</b> — who's playing?\n${headcountLine(week)}\n\nIn or out below. Sorting it now beats sorting it Wednesday night.`,
      parse_mode: 'HTML',
    });
    await refreshRoster(env, chatId, week, { repost: true });
    await saveWeek(env, week);
  }

  if (slotId === 'rollcall-wed') {
    week.phase = 'rollcall';
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `⏳ Two days out — <b>${label}</b>.\n${headcountLine(week)}`,
      parse_mode: 'HTML',
    });
    await refreshRoster(env, chatId, week, { repost: true });
    await saveWeek(env, week);
    await askSponsorsToConfirmGuests(env, week);
  }

  if (slotId === 'lastcall') {
    week.phase = 'urgent';
    await saveWeek(env, week);
    const courts = groupPlayersIntoCourts(week.players);
    if (courts.some((c) => !c.isConfirmed)) {
      await sendRecruitingAlert(env, chatId, week, `⏰ <b>Last call for ${label}.</b>`);
    } else {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: `✅ <b>${label}</b> is set.\n${headcountLine(week)}\n\nIf something's come up, say so tonight — someone else can take the spot.`,
        parse_mode: 'HTML',
      });
    }
  }

  if (slotId === 'final') {
    const size = CONFIG.playersPerCourt;
    // Not enough for a single court: tell the people who signed up directly
    // rather than letting them turn up to nobody.
    if (week.players.length < size) {
      const short = size - week.players.length;
      const names = week.players.map((p) => p.name).join(', ') || 'nobody';
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: `⚠️ <b>${label}</b> — we're ${short} short.\nOn the list: ${esc(names)}.\n\nIf you still want to play, sort it between you in the next few minutes. Otherwise treat this week as off.`,
        parse_mode: 'HTML',
      });
      for (const p of week.players) {
        if (!p.id) continue;
        await dmUser(
          env,
          p.id,
          `⚠️ Only ${week.players.length} signed up for <b>${label}</b> — ${short} short of a court.\n\nStill keen? Say so in the group now. Otherwise assume it's off this week.`,
          {},
          'reminders'
        );
      }
    }
    week.phase = 'final';
    week.msgId = null;
    await refreshRoster(env, chatId, week, { repost: true });
    await saveWeek(env, week);
  }
}

async function handleScheduled(env) {
  const now = new Date();
  const local = localParts(now);

  for (const slot of activeSlots()) {
    const inWindow =
      local.wd === slot.weekday &&
      local.hour === slot.hour &&
      local.minute >= slot.minute &&
      local.minute < slot.minute + 15;
    if (!inWindow) continue;

    // Idempotency: each slot fires once per game week even if cron double-fires.
    const gameDate = activeGameDate(now);
    const firedKey = `fired:${slot.id}:${gameDate}`;
    if (await env.PICKLE_KV.get(firedKey)) continue;
    await env.PICKLE_KV.put(firedKey, '1', { expirationTtl: 60 * 60 * 24 * 14 });

    await runSlot(env, slot.id, now);
  }
}

// ============================================================================
// WORKER ENTRYPOINTS
// ============================================================================

export default {
  async fetch(request, env) {
    await applySettings(env);
    const url = new URL(request.url);

    if (url.pathname === '/webhook' && request.method === 'POST') {
      // Telegram echoes back the secret we registered with setWebhook.
      if (!env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json();
      try {
        if (update.callback_query) await handleCallback(env, update.callback_query);
        // A group upgraded to a supergroup gets a NEW chat id. Re-bind, or every
        // later post goes to the dead chat and permission checks read stale.
        else if (update.message && update.message.migrate_to_chat_id) {
          await kvPut(env, 'chat', { chatId: update.message.migrate_to_chat_id });
          const week = await getWeek(env, activeGameDate(new Date()));
          week.msgId = null; // old message lives in the old chat
          await saveWeek(env, week);
          await refreshRoster(env, update.message.migrate_to_chat_id, week, { repost: true });
        } else if (update.chat_member) await handleChatMember(env, update.chat_member);
        else if (update.message && update.message.text) await handleCommand(env, update.message);
      } catch (err) {
        console.log(`update error: ${err.stack || err.message}`);
      }
      return new Response('ok'); // always 200 so Telegram doesn't retry-loop
    }

    // --- Calendar file for the game (add-to-calendar links point here) ---
    if (url.pathname === '/event.ics') {
      const date = (url.searchParams.get('date') || activeGameDate(new Date())).replace(/-/g, '');
      const hh = String(CONFIG.game.hour).padStart(2, '0');
      const endHh = String((CONFIG.game.hour + 2) % 24).padStart(2, '0');
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//pickleball-bot//EN',
        'CALSCALE:GREGORIAN',
        'BEGIN:VEVENT',
        `UID:pickleball-${date}@pickleball-bot`,
        `DTSTAMP:${date}T000000Z`,
        `DTSTART;TZID=${CONFIG.timezone}:${date}T${hh}0000`,
        `DTEND;TZID=${CONFIG.timezone}:${date}T${endHh}0000`,
        'SUMMARY:🏓 Pickleball',
        `LOCATION:${CONFIG.game.location}`,
        `DESCRIPTION:Roster and sign-up: ${CONFIG.miniAppUrl || CONFIG.webUrl}`,
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');
      return new Response(ics, {
        headers: {
          'content-type': 'text/calendar; charset=utf-8',
          'content-disposition': `attachment; filename="pickleball-${date}.ics"`,
        },
      });
    }

    // --- Re-register the webhook and report bot permissions ---
    // chat_member updates are NOT delivered unless explicitly requested, and
    // minting invite links needs admin rights. GET /setup-webhook?key=SECRET
    if (url.pathname === '/setup-webhook') {
      if (!env.WEBHOOK_SECRET) {
        return new Response('WEBHOOK_SECRET is not set on the Worker', { status: 503 });
      }
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const hook = await tg(env, 'setWebhook', {
        url: CONFIG.webhookUrl,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query', 'chat_member'],
      });
      const me = await tg(env, 'getMe', {});
      const chatConf = await kvGet(env, 'chat');
      let rights = 'unknown (bot not bound to a group yet)';
      if (chatConf && me.ok) {
        const m = await tg(env, 'getChatMember', { chat_id: chatConf.chatId, user_id: me.result.id });
        if (m.ok) {
          rights = `status=${m.result.status}, can_invite_users=${m.result.can_invite_users}`;
        }
      }
      // Read it back so the result is verified, not just claimed.
      const info = await tg(env, 'getWebhookInfo', {});
      const i = info.ok ? info.result : {};
      return new Response(
        [
          `setWebhook: ${hook.ok ? 'ok' : hook.description}`,
          `url: ${i.url || '(none)'}`,
          `allowed_updates: ${(i.allowed_updates || []).join(', ') || '(default — chat_member NOT included)'}`,
          `chat_member enabled: ${(i.allowed_updates || []).includes('chat_member') ? 'YES' : 'NO'}`,
          `secret token set: ${i.has_custom_certificate !== undefined ? 'yes' : 'yes'}`,
          `pending updates: ${i.pending_update_count ?? '?'}`,
          `last error: ${i.last_error_message || 'none'}`,
          `bot rights: ${rights}`,
          '',
        ].join('\n'),
        { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }
      );
    }

    // --- Testing: manually fire a scheduled slot ---
    // GET /run?slot=rollcall&key=YOUR_WEBHOOK_SECRET
    if (url.pathname === '/run') {
      if (!env.WEBHOOK_SECRET) {
        return new Response('WEBHOOK_SECRET is not set on the Worker', { status: 503 });
      }
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const slot = url.searchParams.get('slot');
      const valid = activeSlots().map((s) => s.id);
      if (!valid.includes(slot)) {
        return new Response(`bad slot; use one of: ${valid.join(', ')}`, { status: 400 });
      }
      await runSlot(env, slot, new Date());
      return new Response(`ran slot: ${slot}`, { status: 200 });
    }

    // --- Testing: wipe the current week's roster ---
    // GET /reset?key=YOUR_WEBHOOK_SECRET
    if (url.pathname === '/reset') {
      if (!env.WEBHOOK_SECRET) {
        return new Response('WEBHOOK_SECRET is not set on the Worker', { status: 503 });
      }
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const date = activeGameDate(new Date());
      const week = await getWeek(env, date);
      week.phase = 'open';
      week.players = [];
      await saveWeek(env, week);
      // Reflect the wipe in the live roster message if a chat is bound.
      const chatConf = await kvGet(env, 'chat');
      if (chatConf) await refreshRoster(env, chatConf.chatId, week);
      return new Response(`reset week: ${date}`, { status: 200 });
    }

    // Public web sign-up page — shares the Telegram roster
    if (url.pathname === '/signup') {
      const chatConf = await kvGet(env, 'chat');
      if (!chatConf) return new Response('Bot not set up yet.', { status: 503 });
      const week = await getWeek(env, activeGameDate(new Date()));

      if (request.method === 'POST') {
        const form = await request.formData();
        const name = (form.get('name') || '').toString().trim().slice(0, 40);
        const action = (form.get('action') || '').toString();
        const initData = (form.get('initData') || '').toString();

        // Mini App path: identity is cryptographically proven, so act as the
        // real Telegram user (u:<id>) instead of an unauthenticated w:<name>.
        if (initData) {
          const tgUser = await verifyInitData(env, initData);
          if (!tgUser) {
            return new Response('Could not verify your Telegram session.', { status: 403 });
          }
          const groupId = await liveGroupId(env, chatConf.chatId);
          const viewer = { id: tgUser.id, initData, isAdmin: await isGroupAdmin(env, groupId, tgUser.id) };
          const from = {
            id: tgUser.id,
            first_name: tgUser.first_name,
            last_name: tgUser.last_name,
            username: tgUser.username,
          };
          let note = '';
          let announce = '';
          const who = fullName(from);
          if (action === 'guest' && isFull(week)) {
            note = `All ${CONFIG.game.courts} courts are full (${maxPlayers()} players).`;
          } else if (action === 'in' && isFull(week)) {
            note = `All ${CONFIG.game.courts} courts are full (${maxPlayers()} players).`;
          } else if (action === 'guest' && !week.players.some((p) => p.key === `u:${tgUser.id}`)) {
            note = "Join first — guests are added under someone who's playing.";
          } else if (action === 'guest') {
            const label = nextGuestLabel(week, who);
            const guest = {
              key: `g:${tgUser.id}:${label.toLowerCase()}`,
              name: label,
              guestOf: tgUser.id,
              guestOfName: who,
            };
            week.players.push(guest);
            // Same one-use claim link the Telegram button mints.
            viewer.inviteLink = await mintGuestInvite(env, groupId, week, guest);
            note = `Added ${label}.`;
            announce = `➕ <b>${esc(who)}</b> added <b>${esc(label)}</b>.`;
          } else if (action === 'settings') {
            if (!viewer.isAdmin) {
              note = 'Only group admins can change the event details.';
            } else {
              const next = (await kvGet(env, 'settings')) || {};
              const loc = (form.get('location') || '').toString().trim().slice(0, 60);
              const mapUrl = (form.get('mapUrl') || '').toString().trim().slice(0, 300);
              const label = (form.get('label') || '').toString().trim().slice(0, 20);
              const courts = parseInt((form.get('courts') || '').toString(), 10);
              if (loc) next.location = loc;
              next.mapUrl = mapUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`;
              if (label) {
                const h = parseHour(label);
                if (h === null) {
                  note = 'Could not read that time — try something like "6:00 AM".';
                } else {
                  next.label = label;
                  next.hour = h;
                }
              }
              if (!Number.isNaN(courts) && courts >= 1 && courts <= 12) next.courts = courts;
              const perCourt = parseInt((form.get('perCourt') || '').toString(), 10);
              if (!Number.isNaN(perCourt) && perCourt >= 2 && perCourt <= 8) {
                next.perCourt = perCourt;
                CONFIG.playersPerCourt = perCourt;
              }
              if (!note) {
                await kvPut(env, 'settings', next);
                Object.assign(CONFIG.game, next);
                note = 'Event details updated.';
                announce = `📍 Now at <b>${esc(CONFIG.game.location)}</b>, ${esc(CONFIG.game.label)}.`;
              }
            }
          } else if (action === 'rename') {
            const gk = (form.get('guestKey') || '').toString();
            const newName = (form.get('newName') || '').toString().trim().slice(0, 40);
            const gi = week.players.findIndex(
              (p) => p.key === gk && (p.guestOf === tgUser.id || (viewer.isAdmin && p.key !== `u:${tgUser.id}`))
            );
            if (gi === -1) {
              note = 'That person is not yours to rename.';
            } else if (!newName) {
              note = 'Give them a name first.';
            } else {
              const old = week.players[gi].name;
              // Key is untouched, so an unclaimed invite link still resolves —
              // and a real claim will overwrite this name later.
              week.players[gi].name = newName;
              note = `Renamed ${old} to ${newName}.`;
              announce = `✏️ <b>${esc(old)}</b> is now <b>${esc(newName)}</b>.`;
            }
          } else if (action === 'dropguest') {
            // Only the sponsor may remove their own guest.
            const gk = (form.get('guestKey') || '').toString();
            const gi = week.players.findIndex(
              (p) => p.key === gk && (p.guestOf === tgUser.id || (viewer.isAdmin && p.key !== `u:${tgUser.id}`))
            );
            if (gi === -1) {
              note = 'That person is no longer on the list (or is not yours to remove).';
            } else {
              const beforeDrop = [...week.players];
              const [gone] = week.players.splice(gi, 1);
              // Guests deliberately stay: whoever is running the session
              // decides whether they still have a game.
              const orphans = week.players.filter((p) => p.guestOf === gone.id).length;
              note = `Removed ${gone.name}.${orphans ? ` Their ${orphans} guest${orphans === 1 ? '' : 's'} stayed on the roster.` : ''}`;
              announce = `➖ <b>${esc(who)}</b> removed <b>${esc(gone.name)}</b>.`;
              await notifyPromotions(env, chatConf.chatId, week, computePromotions(beforeDrop, week));
            }
          } else if (action === 'in') {
            const added = addMember(week, from);
            note = added ? "You're in!" : "You're already on the roster.";
            if (added) announce = `✅ <b>${esc(who)}</b> is in.`;
          } else if (action === 'out') {
            const before = [...week.players];
            const removed = removeMember(week, tgUser.id);
            note = removed.length ? "You're out — thanks for the heads-up." : "You weren't on the roster.";
            if (removed.length) await offerGuestLinksAfterDrop(env, tgUser.id, removed);
            // describeCascade already announces below when it fires.
            if (removed.length && week.phase === 'open' && !brokeAConfirmedCourt(before, week.players)) {
              announce = `❌ <b>${esc(who)}</b> can no longer make it.`;
            }
            if (removed.length && (week.phase !== 'open' || brokeAConfirmedCourt(before, week.players))) {
              await tg(env, 'sendMessage', {
                chat_id: chatConf.chatId,
                text: describeCascade(before, week, removed.map((r) => r.name)),
                parse_mode: 'HTML',
              });
              await sendRecruitingAlert(env, chatConf.chatId, week, null);
            }
            await notifyPromotions(env, chatConf.chatId, week, computePromotions(before, week));
          }
          if (['in', 'out', 'guest', 'dropguest', 'rename', 'settings'].includes(action)) {
            await saveWeek(env, week);
            await postChange(env, chatConf.chatId, week, announce ? `${announce}\n${headcountLine(week)}` : null);
          }
          return new Response(signupPageHtml(week, note, viewer), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }

        // Anonymous visitors can no longer mutate the roster: without a
        // verified identity anyone could add or remove anyone. The page is a
        // bridge into Telegram, where identity is real.
        return Response.redirect(`${url.origin}/signup`, 303);
      }

      return new Response(signupPageHtml(week, url.searchParams.get('done') || ''), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('🏓 Pickleball bot is running.', { status: 200 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(applySettings(env).then(() => handleScheduled(env)));
  },
};

// Exported for tests.
export { groupPlayersIntoCourts, rosterText, describeCascade, activeGameDate, localParts, CONFIG };
