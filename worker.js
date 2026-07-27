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

  // Automation moments, in local (Pacific) time. Each fires once per game
  // week (idempotent), matched within a 15-minute cron window.
  slots: [
    { id: 'open', weekday: 'Thu', hour: 8, minute: 0 },
    { id: 'rollcall', weekday: 'Wed', hour: 19, minute: 0 },
    { id: 'cutoff', weekday: 'Wed', hour: 21, minute: 30 },
    { id: 'final', weekday: 'Thu', hour: 5, minute: 15 },
  ],
};

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

function rosterKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "✅ I'm in", callback_data: 'in' },
        { text: "❌ I can't make it", callback_data: 'out' },
      ],
      [{ text: '➕ Bring a guest', callback_data: 'guest' }],
      [{ text: '🌐 Sign-up page', url: CONFIG.miniAppUrl || CONFIG.webUrl }],
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
  lines.push(`📍 <a href="${CONFIG.game.mapUrl}">${CONFIG.game.location}</a>`);
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
  b += `<p class="loc">📍 <a href="${CONFIG.game.mapUrl}" target="_blank" rel="noopener">${esc(CONFIG.game.location)}</a></p>`;
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
      const tag = p.key.startsWith('u:') ? ' <span class="tag">Telegram</span>' : '';
      // Only a verified Mini App viewer can be identified — this is the "(me)"
      // a shared Telegram group message can never show.
      const me = viewer && p.key === `u:${viewer.id}` ? ' <span class="me">(me)</span>' : '';
      // A sponsor can drop each of their own guests individually.
      const mine = viewer && p.guestOf === viewer.id;
      const drop = mine
        ? `<form method="POST" action="/signup" class="x"><input type="hidden" name="initData" value="${esc(viewer.initData)}"/><input type="hidden" name="guestKey" value="${esc(p.key)}"/><button name="action" value="dropguest" class="xbtn" title="Remove this guest">✕</button></form>`
        : '';
      b += `<li>${displayName(p)}${tag}${me}${drop}</li>`;
    }
    b += '</ol>';
    if (!c.isConfirmed) {
      const n = c.playersNeeded;
      b += `<p class="need">Needs ${n} more player${n === 1 ? '' : 's'} to unlock this court</p>`;
    }
  }
  b += `<p>👥 ${week.players.length} signed up</p>`;
  // After adding a guest, surface the message to forward to them.
  if (done.startsWith('Added ') && CONFIG.telegramInviteUrl) {
    b += `<div class="share">
      <h2>📨 Invite them</h2>
      <p>Send your guest this so they can confirm and get updates:</p>
      <p class="snippet">Pickleball ${esc(fmtGameDate(week.date))} at ${esc(CONFIG.game.label)}, ${esc(CONFIG.game.location)}. Join the group: ${CONFIG.telegramInviteUrl}</p>
      <p><a href="${CONFIG.telegramInviteUrl}" target="_blank" rel="noopener">Open the group invite ↗</a></p>
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
          : `<button name="action" value="in" class="in wide">✅ I'm in</button>`
      }
      <button name="action" value="guest" class="guest wide">➕ Bring a guest</button>
    </form>`;
  } else {
    b += `<form method="POST" action="/signup" class="f">
      <input name="name" placeholder="Your name" required maxlength="40" autocomplete="name"/>
      <div class="btns">
        <button name="action" value="in" class="in">✅ I'm in</button>
        <button name="action" value="out" class="out">❌ I'm out</button>
      </div>
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
    b += `<div class="tg">
      <h2>📲 Get realtime updates</h2>
      <p>Roll call, last-minute open spots, and roster changes post live in our Telegram group.</p>
      <ol>
        <li>Install Telegram: <a href="https://telegram.org/apps" target="_blank" rel="noopener">telegram.org/apps</a></li>
        ${joinStep}
      </ol></div>`;
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
  .share{margin-top:20px;padding:14px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px}
  .share h2{font-size:1rem;margin:0 0 6px}
  .share p{margin:0 0 8px;font-size:.9rem}
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
  const keyboard = week.phase === 'final' ? undefined : rosterKeyboard();

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
  if (partial) s += ` · Court ${partial.courtNumber} needs ${partial.playersNeeded} more`;
  return s;
}

// ---------------------------------------------------------------------------
// DIRECT MESSAGES
// A bot may only DM someone who has already opened it and pressed Start, so we
// record each opted-in user's private chat id and fall back to a group mention.
// ---------------------------------------------------------------------------

async function getDmChat(env, userId) {
  const v = await kvGet(env, `dm:${userId}`);
  return v ? v.chatId : null;
}

/** DMs an opted-in user. Returns true when actually delivered. */
async function dmUser(env, userId, text, extra = {}) {
  const chatId = await getDmChat(env, userId);
  if (!chatId) return false;
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
  if (await dmUser(env, user.id, text, extra)) return 'dm';
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

async function mintGuestInvite(env, chatId, week, player) {
  const res = await tg(env, 'createChatInviteLink', {
    chat_id: chatId,
    name: player.name.slice(0, 32),
    member_limit: 1, // single use: a forwarded link dies after the first join
  });
  if (!res.ok) return null;
  const link = res.result.invite_link;
  await kvPut(env, `invite:${link}`, { date: week.date, key: player.key });
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

  const week = await getWeek(env, rec.date);
  const idx = week.players.findIndex((p) => p.key === rec.key);
  await env.PICKLE_KV.delete(`invite:${link}`); // one claim only
  if (idx === -1) return; // placeholder already gone

  const chatConf = await kvGet(env, 'chat');
  if (!chatConf) return;
  const user = upd.new_chat_member.user;
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

/** Posts a real (notifying) message about a roster change made off-Telegram. */
async function announceWeb(env, chatId, week, line) {
  await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: `${line}\n${headcountLine(week)}`,
    parse_mode: 'HTML',
    // Carry the actions so people can respond right here rather than hunting
    // for the pinned roster.
    reply_markup: week.phase === 'final' ? undefined : rosterKeyboard(),
  });
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
      { id: targetId, name: player.guestOfName || player.name },
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
    lines.push(`Court ${partial.courtNumber} now needs <b>${n}</b> more player${n === 1 ? '' : 's'}.`);
  }
  return lines.join('\n');
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
  const answer = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: false });

  if (!chatConf) return answer('Bot not set up yet — an admin must run /setup in the group.');

  const week = await getWeek(env, activeGameDate(new Date()));
  const from = cb.from;

  if (cb.data === 'guest') {
    // One tap holds the spot under a placeholder name — no typing, no command.
    const sponsor = fullName(from);
    const label = nextGuestLabel(week, sponsor);
    week.players.push({ key: `g:${from.id}:${label.toLowerCase()}`, name: label, guestOf: from.id, guestOfName: sponsor });
    await saveWeek(env, week);
    await refreshRoster(env, chatConf.chatId, week);

    // One-use link bound to THIS placeholder: tapping it joins the group and
    // claims this exact spot.
    const player = week.players[week.players.length - 1];
    const link = await mintGuestInvite(env, chatConf.chatId, week, player);

    const personal = link
      ? `➕ You added <b>${esc(label)}</b>.\n\nSend them this link — it's unique to this guest and works once:\n${link}\n\nWhen they tap it they'll join the group and take over this spot automatically.`
      : `➕ You added <b>${esc(label)}</b>. (Couldn't create an invite link — check I'm an admin with "Invite Users via Link".)`;

    // Instructions are for the sponsor only; the group just needs the count.
    const sentPrivately = await dmUser(env, from.id, personal);
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
    if (!addMember(week, from)) return answer("You're already on the roster!");
    await saveWeek(env, week);
    await refreshRoster(env, chatConf.chatId, week);
    const pos = week.players.length;
    const court = Math.floor((pos - 1) / CONFIG.playersPerCourt) + 1;
    return answer(`You're in — #${pos}, Court ${court}.`);
  }

  if (cb.data === 'out') {
    const before = [...week.players];
    const removed = removeMember(week, from.id);
    if (removed.length === 0) return answer("You weren't on the roster.");
    await saveWeek(env, week);
    await refreshRoster(env, chatConf.chatId, week);
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
    await kvPut(env, `dm:${from.id}`, { chatId, name: fullName(from) });
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
    buttons.push([{ text: '🌐 Sign-up page', url: CONFIG.miniAppUrl || CONFIG.webUrl }]);
    return say(
      `🔔 <b>You're set up for personal updates.</b>\nI'll message you here when a spot opens for you, when you're promoted onto a court, or when your guest claims their spot — instead of filling up the group chat.`,
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
    }
    return;
  }

  if (cmd === '/guest') {
    const name = args.join(' ').trim();
    if (!name) return say('Usage: /guest FirstName — adds a guest under your name.');
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
    // Fires Thu 8am — activeGameDate has already rolled to NEXT week.
    week.msgId = null; // force a fresh message
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `🏓 <b>Sign-ups are open for ${label}!</b>\nLock in early — first to confirm, first on Court 1.`,
      parse_mode: 'HTML',
    });
    await refreshRoster(env, chatId, week, { repost: true });
    await saveWeek(env, week);
  }

  if (slotId === 'rollcall') {
    week.phase = 'rollcall';
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `🌙 <b>Roll call — pickleball tomorrow, ${CONFIG.game.label}!</b>\nConfirm below. No response by 9:30pm = your spot may go to standby.`,
      parse_mode: 'HTML',
    });
    await refreshRoster(env, chatId, week, { repost: true });
    await saveWeek(env, week);
  }

  if (slotId === 'cutoff') {
    week.phase = 'urgent';
    await saveWeek(env, week);
    const courts = groupPlayersIntoCourts(week.players);
    if (courts.some((c) => !c.isConfirmed)) {
      await sendRecruitingAlert(env, chatId, week, `⏰ <b>Last call for ${label}!</b>`);
    }
  }

  if (slotId === 'final') {
    week.phase = 'final';
    week.msgId = null; // fresh, un-editable final post
    await refreshRoster(env, chatId, week, { repost: true });
    await saveWeek(env, week);
  }
}

async function handleScheduled(env) {
  const now = new Date();
  const local = localParts(now);

  for (const slot of CONFIG.slots) {
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
      const valid = CONFIG.slots.map((s) => s.id);
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
          const viewer = { id: tgUser.id, initData };
          const from = {
            id: tgUser.id,
            first_name: tgUser.first_name,
            last_name: tgUser.last_name,
            username: tgUser.username,
          };
          let note = '';
          let announce = '';
          const who = fullName(from);
          if (action === 'guest') {
            const label = nextGuestLabel(week, who);
            week.players.push({
              key: `g:${tgUser.id}:${label.toLowerCase()}`,
              name: label,
              guestOf: tgUser.id,
              guestOfName: who,
            });
            note = `Added ${label}.`;
            announce = `➕ <b>${esc(who)}</b> added <b>${esc(label)}</b>.`;
          } else if (action === 'dropguest') {
            // Only the sponsor may remove their own guest.
            const gk = (form.get('guestKey') || '').toString();
            const gi = week.players.findIndex((p) => p.key === gk && p.guestOf === tgUser.id);
            if (gi === -1) {
              note = 'That guest is no longer on the list.';
            } else {
              const [gone] = week.players.splice(gi, 1);
              note = `Removed ${gone.name}.`;
              announce = `➖ <b>${esc(who)}</b> removed <b>${esc(gone.name)}</b>.`;
            }
          } else if (action === 'in') {
            const added = addMember(week, from);
            note = added ? "You're in!" : "You're already on the roster.";
            if (added) announce = `✅ <b>${esc(who)}</b> is in.`;
          } else if (action === 'out') {
            const before = [...week.players];
            const removed = removeMember(week, tgUser.id);
            note = removed.length ? "You're out — thanks for the heads-up." : "You weren't on the roster.";
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
          if (['in', 'out', 'guest', 'dropguest'].includes(action)) {
            await saveWeek(env, week);
            await refreshRoster(env, chatConf.chatId, week);
            if (announce) {
              await tg(env, 'sendMessage', {
                chat_id: chatConf.chatId,
                text: `${announce}\n${headcountLine(week)}`,
                parse_mode: 'HTML',
                reply_markup: week.phase === 'final' ? undefined : rosterKeyboard(),
              });
            }
          }
          return new Response(signupPageHtml(week, note, viewer), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }

        let msg = '';
        if (name) {
          const key = `w:${name.toLowerCase()}`;
          const idx = week.players.findIndex((p) => p.key === key);
          if (action === 'guest') {
            const label = nextGuestLabel(week, name);
            week.players.push({
              key: `wg:${name.toLowerCase()}:${label.toLowerCase()}`,
              name: label,
              guestOf: key, // sponsor's web key — drops together with them
              guestOfName: name,
            });
            await saveWeek(env, week);
            await refreshRoster(env, chatConf.chatId, week);
            await announceWeb(env, chatConf.chatId, week, `➕ <b>${esc(name)}</b> added <b>${esc(label)}</b>.`);
            msg = `Added ${label}.`;
          } else if (action === 'in' && idx === -1) {
            week.players.push({ key, name });
            await saveWeek(env, week);
            await refreshRoster(env, chatConf.chatId, week);
            await announceWeb(env, chatConf.chatId, week, `✅ <b>${esc(name)}</b> is in (via the sign-up page).`);
            msg = `You're in, ${name}!`;
          } else if (action === 'out' && idx !== -1) {
            // Take their guests with them, mirroring the Telegram cascade.
            week.players = week.players.filter((p, i) => i !== idx && p.guestOf !== key);
            await saveWeek(env, week);
            await refreshRoster(env, chatConf.chatId, week);
            await announceWeb(env, chatConf.chatId, week, `❌ <b>${esc(name)}</b> can no longer make it.`);
            msg = `You're out, ${name}.`;
          } else if (action === 'in') {
            msg = `${name}, you're already on the list.`;
          } else {
            // action 'out' with no web-added match. If the name matches a
            // Telegram member or a sponsored guest, it's protected — the web
            // page can't drop it. Explain rather than say "not found".
            const lower = name.toLowerCase();
            const locked = week.players.find(
              (p) => p.name.toLowerCase() === lower && (p.key.startsWith('u:') || p.key.startsWith('g:'))
            );
            if (locked && locked.guestOf) {
              msg = `${name} is a guest — only the member who added them can remove them, in Telegram.`;
            } else if (locked) {
              msg = `${name} is in via Telegram — only they can drop themselves, in the group.`;
            } else {
              msg = `${name} wasn't found on the list.`;
            }
          }
        }
        return Response.redirect(`${url.origin}/signup?done=${encodeURIComponent(msg)}`, 303);
      }

      return new Response(signupPageHtml(week, url.searchParams.get('done') || ''), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('🏓 Pickleball bot is running.', { status: 200 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};

// Exported for tests.
export { groupPlayersIntoCourts, rosterText, describeCascade, activeGameDate, localParts, CONFIG };
