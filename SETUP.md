# Slack Translator Bot — Setup Guide

## What it does
- **Incoming**: Every message posted in your monitored channels is silently translated to English and shown only to you.
- **Outgoing `/send`**: Type in any language → bot translates and posts to the channel.
- **On-demand `/translate`**: Paste a Slack message link → bot fetches and translates it privately (nothing posted).

---

## Step 1 — Create Your Slack App

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. Name it (e.g. "My Translator") and pick your workspace

### OAuth & Permissions → Bot Token Scopes
Add these scopes:
- `channels:history` — read messages in public channels
- `groups:history` — read messages in private channels
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

---

## Step 2 — Configure Event Subscriptions

1. In your app settings → **Event Subscriptions** → toggle **Enable Events**
2. **Request URL**: `https://YOUR-RAILWAY-URL.railway.app/slack/events`
   - ⚠️ Must be `https://`, not `http://`
   - ⚠️ Must include `/slack/events` at the end
   - Come back to fill this after deploying in Step 4
3. Under **Subscribe to bot events**, add: `message.channels`, `message.groups`, and `message.im`
4. Save changes

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
   - `CHANNEL_LANGUAGES` (optional — e.g. `{"C012AB3CD":"Japanese"}`)
   - `OUTGOING_LANGUAGE` (optional, default: English)
   - `PROTECTED_TERMS` (optional — comma-separated brand/product/person names that should never be translated, e.g. `Papabubble,Ownego`)
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
> The bot must be in a channel to read messages from it — this applies to both auto-translation and `/translate` link lookups.

---

## Usage

### Subscription
| What you want | What to do |
|---|---|
| Subscribe to auto-translations | `/ed join` |
| Unsubscribe | `/ed leave` |

### Channel monitoring
| What you want | What to do |
|---|---|
| Monitor this channel (run inside the channel) | `/ed watch` |
| Stop monitoring this channel | `/ed unwatch` |

### Translation
| What you want | What to do |
|---|---|
| Translate a message or link privately | `/ed trans` → opens a modal, paste text or a Slack message link, pick a language (optional) |
| Post a translated message in a channel or thread | `/ed send` → opens a modal, write your message, pick a language (optional) |

## For new users / colleagues

Anyone in the workspace can use the bot — no setup needed:
1. Find the bot in Slack (search "INT Translator" or your bot name)
2. `/ed join` — subscribe to auto-translations
3. Go to each channel you want monitored → `/ed watch`
4. `/ed leave` to unsubscribe anytime

---

## Troubleshooting

- **"Your URL didn't respond with the challenge parameter"**: Make sure the URL is `https://` (not `http://`) and ends with `/slack/events`. Also confirm Railway shows the deployment as **Active**.
- **Bot not translating automatically**: Make sure it's invited to the channel (`/invite @botname`) and the channel ID is in `MONITORED_CHANNEL_IDS`.
- **`/ed trans` says "could not fetch message"**: The bot isn't in that channel — run `/invite @botname` there first.
- **"dispatch_failed" error**: Your Railway URL in Slack's event/slash command settings is incorrect.
- **Translations going to wrong person**: Double-check `MY_SLACK_USER_ID`.
