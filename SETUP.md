# Slack Translator Bot — Setup Guide

## What it does
- **Incoming**: Every message posted in your monitored channels is silently translated to English and shown only to you.
- **Outgoing `/send`**: Type in any language → bot translates and posts to the channel.
- **On-demand `/translate`**: Paste a Slack message link → bot fetches and translates it privately (nothing posted).
- **Forwarded messages**: Forward a message into a watched channel and, if it's not already in that channel's outgoing language, the bot posts a visible translation in the same thread — automatic, no command needed. ⚠️ Not yet verified against a real forward from this workspace; see Troubleshooting if it doesn't fire.

---

## Step 1 — Create Your Slack App

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. Name it (e.g. "My Translator") and pick your workspace

### OAuth & Permissions → Bot Token Scopes
Add these scopes:
- `channels:history` — read messages in public channels
- `groups:history` — read messages in private channels
- `channels:read` — list public channels the bot has joined (needed for auto-watch)
- `groups:read` — list private channels the bot has joined (needed for auto-watch)
- `im:history` — read messages in 1:1 DMs
- `im:write` — send DM messages (bot DMs you the translation)
- `chat:write` — post messages
- `chat:write.customize` — show messages under the sender's name/avatar instead of the bot's
- `commands` — register slash commands

### Install App
- Click **Install to Workspace** → copy the **Bot User OAuth Token** (starts with `xoxb-`)

### Basic Information
- Copy the **Signing Secret**

### App Home → Enable DMs to the bot
- Scroll to **Show Tabs** → toggle on **Messages Tab**
- Check **"Allow users to send Slash commands and messages from the messages tab"**
- Without this, the DM tab with the bot shows but the message box stays disabled — no reinstall needed, just refresh Slack after saving

### App Home → Enable the settings Home tab
- In the same **Show Tabs** section, toggle on **Home Tab**
- This powers the visual settings screen (subscribe/unsubscribe, language, watched channels, viewers) — an alternative to typing `/ed` commands
- Requires the `member_joined_channel`-adjacent event below (`app_home_opened`) to actually render

---

## Step 2 — Configure Event Subscriptions

1. In your app settings → **Event Subscriptions** → toggle **Enable Events**
2. **Request URL**: `https://YOUR-RAILWAY-URL.railway.app/slack/events`
   - ⚠️ Must be `https://`, not `http://`
   - ⚠️ Must include `/slack/events` at the end
   - Come back to fill this after deploying in Step 4
3. Under **Subscribe to bot events**, add: `message.channels`, `message.groups`, `message.im`, `member_joined_channel`, and `app_home_opened`
4. Save changes

> `member_joined_channel` powers auto-watch: any channel the bot is added to is automatically monitored, no `/ed watch` needed. `/ed watch`/`/ed unwatch` still work for manual control.

---

## Step 3 — Add Slash Command

In your app settings → **Slash Commands** → **Create New Command**:

- Command: `/ed`
- Request URL: `https://YOUR-RAILWAY-URL.railway.app/slack/events`
- Description: Translate messages — use `send` or `trans` as subcommands
- Usage hint: `send | trans | recap | join | watch`

> All bot actions go through a single `/ed` command. The word after `/ed` determines what it does.

---

## Step 4 — Deploy to Railway

1. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**
2. Select your `slack-translator-bot` repo
3. Add environment variables under the **Variables** tab:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `SUBSCRIBER_USER_IDS` — comma-separated Slack user IDs to seed as initial subscribers (users can also self-register with `/ed join`)
   - `MONITORED_CHANNEL_IDS`
   - `CHANNEL_LANGUAGES` (optional — e.g. `{"C012AB3CD":"Japanese"}`) — one-time seed only; once set, it's stored in Redis and from then on can be changed live from the Home tab's Watched Channels section instead
   - `OUTGOING_LANGUAGE` (optional, default: English)
   - `PROTECTED_TERMS` (optional — comma-separated brand/product/person names that should never be translated, e.g. `YourBrand,ClientName`)
   - `CANVAS_URL` (optional — link to an internal onboarding canvas/doc; shown in `/ed newbie` and the Home tab if set, omitted otherwise)
4. Railway auto-deploys. Go to **Settings → Networking → Generate Domain** to get your URL
5. **Go back to Steps 2 & 3** and paste your Railway URL into Slack's Event Subscriptions and Slash Command request URLs

---

## Step 5 — Find Your IDs

**Your Slack User ID:**
- Open Slack → click your profile photo → **Profile** → **⋮ More** → **Copy Member ID**

**Channel IDs:**
- Right-click any channel → **View channel details** → scroll to bottom → copy the ID (starts with `C`)
- Or: open the channel in browser — the ID is the last segment of the URL

**Other people's user IDs (e.g. for seeding `SUBSCRIBER_USER_IDS`):**
- Click their profile → **⋮ More** → **Copy Member ID**

---

## Step 6 — Invite the Bot to Your Channels

In each channel you want to monitor or use `/translate` in, type:
```
/invite @My Translator
```
> The bot must be in a channel to read messages from it — this applies to both auto-translation and `/translate` link lookups. Inviting the bot automatically starts monitoring that channel (see auto-watch above) — no separate `/ed watch` step needed.

---

## Usage

### Settings tab (recommended for most users)
Open the bot's **Home** tab (click its name → Home) for a visual settings screen: subscribe/unsubscribe, pick your incoming language, and see the channels you're in that are watched — with a per-channel menu to **mute translations for yourself** (personal, doesn't affect other subscribers) or manage viewers. Everything below also works as a slash command for anyone who prefers typing.

### Subscription
| What you want | What to do |
|---|---|
| Subscribe to auto-translations | `/ed join` |
| Unsubscribe | `/ed leave` |

### Channel monitoring
> Channels are watched automatically as soon as the bot is added to them — this is a workspace-wide setting. `/ed watch`/`/ed unwatch` (or the Home tab) change that for everyone. To opt out personally without affecting other subscribers, use "Mute for me" in the Home tab instead.

| What you want | What to do |
|---|---|
| Monitor this channel (run inside the channel) | `/ed watch` |
| Stop monitoring this channel (affects all subscribers) | `/ed unwatch` |
| Stop translations from this channel for yourself only | Home tab → channel menu → **Mute for me** |

### Translation
| What you want | What to do |
|---|---|
| Translate a message or link privately | `/ed trans` → opens a modal, paste text or a Slack message link, pick a language (optional) |
| Post a translated message in a channel or thread | `/ed send` → opens a modal, write your message, pick a language (optional) |

## For new users / colleagues

Anyone in the workspace can use the bot — no setup needed:
1. Find the bot in Slack (search "INT Translator" or your bot name)
2. `/ed join` — subscribe to auto-translations
3. Channels are watched automatically once the bot is added — invite it to any channel you want monitored (`/ed watch`/`/ed unwatch` for manual control)
4. `/ed leave` to unsubscribe anytime

---

## Troubleshooting

- **"Your URL didn't respond with the challenge parameter"**: Make sure the URL is `https://` (not `http://`) and ends with `/slack/events`. Also confirm Railway shows the deployment as **Active**.
- **Bot not translating automatically**: Make sure it's invited to the channel (`/invite @botname`) — inviting it auto-watches the channel. If it was invited before `member_joined_channel` was added to Event Subscriptions, it won't have been picked up automatically; run `/ed watch` there once, or restart the app (it re-syncs channel membership on every startup).
- **`/ed trans` says "could not fetch message"**: The bot isn't in that channel — run `/invite @botname` there first.
- **"dispatch_failed" error**: Your Railway URL in Slack's event/slash command settings is incorrect.
- **Translations going to wrong person**: Double-check `MY_SLACK_USER_ID`.
- **Forwarded messages aren't getting translated**: This feature's detection logic was built from Slack's general attachment-based share/unfurl shape, not verified against a real forward from this workspace. Check Railway logs for a `[msg]` line at the time of the forward — it dumps `event.blocks`/`event.attachments` (truncated) so the actual payload shape can be compared against `extractForwardedContent()` in `app.js` and adjusted if it doesn't match.
