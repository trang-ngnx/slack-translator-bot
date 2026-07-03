# Slack Translator Bot — Setup Guide

## What it does
- **Incoming**: Every message posted in your monitored channels is silently translated to English and shown only to you.
- **Outgoing replies**: Right-click a message → **Translate & Reply** (or the ✏️ button on an auto-translation) → write in your own language, and the bot posts the translation in that thread under your name. With `ANTHROPIC_API_KEY` set, these translations are done by Claude using the surrounding thread as context — noticeably more natural than machine translation, especially for business Japanese.
- **On-demand `/translate`**: Paste a Slack message link → bot fetches and translates it privately (nothing posted).
- **Forwarded messages**: Forward a message into a watched channel — as a new message or as a reply into an existing thread — and, if it's not already in that channel's outgoing language, the bot posts a visible translation in the same thread. Automatic, no command needed.

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
- Description: Translate messages — use `trans`, `recap`, `join` as subcommands
- Usage hint: `trans | recap | join | watch`

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
   - `ANTHROPIC_API_KEY` (optional, recommended — routes **outgoing** translated replies (*Translate & Reply*) through Claude instead of Google. Claude reads the surrounding thread for context and produces natural, business-appropriate phrasing. Get a key at https://platform.claude.com. If unset or a request fails, outgoing messages silently fall back to Google Translate. `CLAUDE_MODEL` optionally overrides the model, default `claude-opus-4-8`.)
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
| Stop auto-translating a language everyone in the channel already understands (e.g. the team's own internal language) | Home tab → channel menu → **Exclude languages** |

> "Exclude languages" is channel-wide and only affects the regular incoming auto-translate — it doesn't touch forwarded messages, which are always translated per the channel's outgoing language regardless. This is meant for internal channels where the team communicates in one language day-to-day but still forwards messages from other languages in for translation.

### Translation
| What you want | What to do |
|---|---|
| Translate a message or link privately | `/ed trans` → opens a modal, paste text or a Slack message link, pick a language (optional) |
| Post a translated reply in a thread | Right-click a message → **Translate & Reply** (or the ✏️ button on an auto-translation) → write your message, pick a language (optional) |

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
- **Forwarded messages aren't getting translated**: Slack uses two different shapes depending on how the message was forwarded — a new top-level forward arrives as an `attachments` unfurl (`extractForwardedContent()`), while forwarding as a reply into an existing thread arrives as a `message_mention` rich-text element with no text at all, resolved by fetching the source message (`findForwardedMention()` / `resolveForwardedMention()`). If a third variant shows up, check Railway logs for the `[msg]` line at the time of the forward — it dumps `event.blocks`/`event.attachments` (truncated) so the actual payload shape can be compared against `app.js` and adjusted.
