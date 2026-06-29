# Slack Translator Bot — Setup Guide

## What it does
- **Incoming**: Every message posted in your monitored channels is silently translated to English and shown only to you as an ephemeral message.
- **Outgoing `/send`**: Type in any language → bot translates and posts to the channel.
- **Preview `/translate`**: Translate any text to English privately (never posts).

---

## Step 1 — Create Your Slack App

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. Name it (e.g. "My Translator") and pick your workspace

### OAuth & Permissions → Bot Token Scopes
Add these scopes:
- `channels:history` — read messages in public channels
- `groups:history` — read messages in private channels (if needed)
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
   - (Come back to fill this after deploying in Step 4)
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
- Description: Translate text to English (only you see it, nothing posted)
- Usage hint: `[text to translate]`

---

## Step 4 — Deploy to Railway

1. Push this folder to a new GitHub repo
2. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**
3. Select your repo
4. Add environment variables (from your `.env.example` values):
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `ANTHROPIC_API_KEY`
   - `MY_SLACK_USER_ID`
   - `MONITORED_CHANNEL_IDS`
   - `CHANNEL_LANGUAGES` (optional)
   - `OUTGOING_LANGUAGE` (optional, default: English)
5. Railway auto-deploys. Copy the generated URL (e.g. `https://slack-translator-bot-production.up.railway.app`)

6. **Go back to Step 2 & 3** and paste your Railway URL into Slack's Event Subscriptions and Slash Command request URLs

---

## Step 5 — Find Your IDs

**Your Slack User ID:**
- Open Slack → click your profile photo → **Profile** → **⋮ More** → **Copy Member ID**

**Channel IDs:**
- Right-click any channel → **View channel details** → scroll to bottom → copy the ID (starts with `C`)
- Or: open the channel in browser, the ID is the last part of the URL

---

## Step 6 — Invite the Bot to Your Channels

In each channel you want to monitor, type:
```
/invite @My Translator
```

---

## Usage

| What you want | What to do |
|---|---|
| Read a translation | Just read — they appear automatically below messages |
| Post a message in the channel's language | `/send Hello I'll join in 5 minutes` |
| Post in a specific language | `/send Japanese: Hello I'll join in 5 minutes` |
| Preview a translation without posting | `/translate Bonjour tout le monde` |

---

## Troubleshooting

- **Bot not translating**: Make sure it's invited to the channel (`/invite @botname`) and the channel ID is in `MONITORED_CHANNEL_IDS`
- **"dispatch_failed" error**: Your Railway URL is wrong in Slack's event subscription settings
- **Translations appearing for wrong person**: Double-check `MY_SLACK_USER_ID`
