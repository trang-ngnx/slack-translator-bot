# Slack Translator Bot — Setup Guide

## What it does
- **Incoming**: Every message posted in your monitored channels and 1:1 DMs is silently translated to English and shown only to you.
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
- `commands` — register slash commands

### Install App
- Click **Install to Workspace** → copy the **Bot User OAuth Token** (starts with `xoxb-`)

### Basic Information
- Copy the **Signing Secret**

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

## Step 3 — Add Slash Commands

In your app settings → **Slash Commands** → **Create New Command**:

**Command 1:**
- Command: `/send`
- Request URL: `https://YOUR-RAILWAY-URL.railway.app/slack/events`
- Description: Translate your message and post it to the channel
- Usage hint: `[your message in any language]`

**Command 2:**
- Command: `/translate`
- Request URL: `https://YOUR-RAILWAY-URL.railway.app/slack/events`
- Description: Translate a message by link (only you see it, nothing posted)
- Usage hint: `[Slack message link]`

---

## Step 4 — Deploy to Railway

1. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**
2. Select your `slack-translator-bot` repo
3. Add environment variables under the **Variables** tab:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `GEMINI_API_KEY` — from https://aistudio.google.com → Get API key (free, no credit card)
   - `MY_SLACK_USER_ID`
   - `MONITORED_CHANNEL_IDS`
   - `MONITORED_DM_USER_IDS` (optional — user IDs of people whose DMs you want translated)
   - `CHANNEL_LANGUAGES` (optional — e.g. `{"C012AB3CD":"Japanese"}`)
   - `OUTGOING_LANGUAGE` (optional, default: English)
4. Railway auto-deploys. Go to **Settings → Networking → Generate Domain** to get your URL
5. **Go back to Steps 2 & 3** and paste your Railway URL into Slack's Event Subscriptions and Slash Command request URLs

---

## Step 5 — Find Your IDs

**Your Slack User ID:**
- Open Slack → click your profile photo → **Profile** → **⋮ More** → **Copy Member ID**

**Channel IDs:**
- Right-click any channel → **View channel details** → scroll to bottom → copy the ID (starts with `C`)
- Or: open the channel in browser — the ID is the last segment of the URL

**Other people's user IDs (for DM monitoring):**
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

| What you want | What to do |
|---|---|
| Read a translation (channels) | Automatic — appears below each message, only you see it |
| Read a translation (DMs) | Automatic — bot sends you a separate DM with the translation |
| Translate a specific message | Right-click message → **Copy link** → `/translate [paste link]` |
| Post a message in the channel's language | `/send Hello I'll join in 5 minutes` |
| Post in a specific language | `/send Japanese: Hello I'll join in 5 minutes` |

---

## Troubleshooting

- **"Your URL didn't respond with the challenge parameter"**: Make sure the URL is `https://` (not `http://`) and ends with `/slack/events`. Also confirm Railway shows the deployment as **Active**.
- **Bot not translating automatically**: Make sure it's invited to the channel (`/invite @botname`) and the channel ID is in `MONITORED_CHANNEL_IDS`.
- **`/translate` says "could not fetch message"**: The bot isn't in that channel — run `/invite @botname` there first.
- **"dispatch_failed" error**: Your Railway URL in Slack's event/slash command settings is incorrect.
- **Translations going to wrong person**: Double-check `MY_SLACK_USER_ID`.
