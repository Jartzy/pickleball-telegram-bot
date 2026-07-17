# 🏓 Pickleball Reservation Bot (Telegram + Cloudflare Workers)

A serverless weekly reservation system with a waitlist for a recurring pickleball game
(**Thursdays 6:00 AM Pacific** by default). Runs entirely on Cloudflare's free tier —
no servers, no monthly cost, and it can be set up and managed **entirely from your phone**.

## What it does

**Players tap buttons in your Telegram group** — no Google Form needed:

- **✅ I'm in / ❌ I'm out** buttons on a live roster message that edits itself in place
- Courts fill in **strict blocks of 4** in sign-up order: the first 4 are `Court 1 (CONFIRMED)`,
  the next block shows `Waitlist / Filling Court 2 (needs X more)` until its 4th player
  confirms, then upgrades — and so on for Court 3+
- **Drop cascade:** if someone drops, everyone shifts up and the bot announces exactly who
  moved ("Eve moves up to Court 1") and which court is now short
- **/guest Jake** — add a guest under your name (guests don't need Telegram); this is the main
  tool for recruiting that 8th player
- **/standby** — join the standby pool; when a spot opens after the roll call, the bot pings
  the pool with a first-to-tap **Claim a spot** button

**Weekly automation** (all times Pacific, DST-aware):

| When | What |
|---|---|
| Thu 8:00 AM | Next week's sign-up opens (right after the game) |
| Wed 7:00 PM | Night-before roll call with confirm buttons |
| Wed 9:30 PM | Cutoff: recruiting push for partial courts + standby ping |
| Thu 5:15 AM | Final roster posted |

Change any of this in the `CONFIG` block at the top of `worker.js`.

## Setup (~15 minutes, doable from a phone)

### 1. Create the Telegram bot

1. In Telegram, message **@BotFather** → send `/newbot` → pick a name (e.g. *Pickleball Crew Bot*)
   and a username (e.g. `PickleballCrewBot`).
2. Copy the **bot token** it gives you (looks like `123456789:AAF...`).
3. Still in BotFather: `/setprivacy` → select your bot → **Disable** (so the bot can see
   `/guest` commands in the group).

### 2. Deploy the Worker (Cloudflare dashboard — works in a mobile browser)

1. Sign up / log in at [dash.cloudflare.com](https://dash.cloudflare.com) (free plan is fine).
2. **Storage & Databases → KV** → Create namespace → name it `PICKLE_KV`.
3. **Workers & Pages → Create → Worker** → name it `pickleball-bot` → deploy the hello-world,
   then **Edit code** → replace everything with the contents of `worker.js` → **Deploy**.
4. In the Worker's **Settings**:
   - **Bindings → Add → KV namespace**: variable name `PICKLE_KV`, select the namespace from step 2.
   - **Variables & Secrets → Add**: secret `TELEGRAM_BOT_TOKEN` = your BotFather token; secret
     `WEBHOOK_SECRET` = any random string you make up (letters/numbers, e.g. 30 chars).
   - **Triggers → Cron Triggers → Add**: `*/15 * * * *`
5. Note your worker URL, e.g. `https://pickleball-bot.yourname.workers.dev`.

*(Prefer the command line? `npm install`, fill in the KV id in `wrangler.toml`,
`npx wrangler secret put TELEGRAM_BOT_TOKEN`, `npx wrangler secret put WEBHOOK_SECRET`,
then `npm run deploy`.)*

### 3. Point Telegram at your worker

Open this URL in any browser (paste in your token, worker URL, and secret):

```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_WORKER_URL>/webhook&secret_token=<YOUR_WEBHOOK_SECRET>
```

You should see `{"ok":true,"result":true,"description":"Webhook was set"}`.

### 4. Connect your group

1. Add the bot to your pickleball Telegram group.
2. Make the bot a **group admin** (needed so it can pin the live roster).
3. In the group, send **/setup** (you must be a group admin). The bot confirms and posts
   the first roster message.

Done. From here everything is automatic.

## Commands

| Command | Effect |
|---|---|
| `/in`, `/out` | Same as the buttons |
| `/guest Name` | Add a guest under your name |
| `/unguest Name` | Remove your guest |
| `/standby` | Toggle yourself in/out of the standby pool |
| `/status` | Repost the live roster |
| `/help` | Show help |

## How drops are handled (the "8th player problem")

The roster is one ordered queue; courts are just slices of 4. When someone drops from a
confirmed court, everyone below shifts up — early sign-ups keep their priority, and the
hole always lands on the **bottom court**, where it's cheapest to fill. The bot then:

1. Announces the cascade by name (who dropped, who got promoted, which court is short)
2. @mentions the short court's members with the `/guest` recruiting prompt
3. Pings the standby pool with a first-to-tap **Claim a spot** button

After the Wednesday 9:30 PM cutoff this happens instantly on every drop, including drops
after the final roster is posted.

## Costs & limits

Cloudflare free tier: 100,000 requests/day and 5 cron triggers (this uses one). A pickleball
group generates a few hundred requests a week — effectively 0% of the free quota. Telegram's
Bot API is free. Total: **$0/month**.

## Testing

```bash
npm test
```

Covers the blocks-of-4 court math, roster rendering (incl. guests), the drop-promotion
cascade, and the Pacific-time game-date math across PDT/PST.
