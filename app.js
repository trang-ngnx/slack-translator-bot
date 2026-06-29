require('dotenv').config();
const { App } = require('@slack/bolt');
const https = require('https');

// ── Config ─────────────────────────────────────────────────────────────────
// Comma-separated channel IDs to monitor (public/private channels), e.g. C012AB3CD,C045EF6GH
const MONITORED_CHANNELS = (process.env.MONITORED_CHANNEL_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Comma-separated DM user IDs to monitor, e.g. U012AB3CD,U045EF6GH
// These are the OTHER person's user IDs, not yours
const MONITORED_DM_USERS = (process.env.MONITORED_DM_USER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Your Slack user ID (e.g. U012AB3CD) — only you get ephemeral translations
const MY_USER_ID = process.env.MY_SLACK_USER_ID;

// Per-channel outgoing language: JSON like {"C012AB3CD":"Japanese","C045EF6GH":"French"}
// Falls back to OUTGOING_LANGUAGE or "English" if not set
const CHANNEL_LANGUAGES = JSON.parse(process.env.CHANNEL_LANGUAGES || '{}');
const DEFAULT_OUTGOING_LANG = process.env.OUTGOING_LANGUAGE || 'English';

// ── Clients ────────────────────────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN, // only needed for Socket Mode
  socketMode: process.env.SOCKET_MODE === 'true',
});

// ── Translation helper (Google Translate — free, no API key needed) ────────
const LANG_CODES = {
  english: 'en', japanese: 'ja', french: 'fr', spanish: 'es',
  german: 'de', korean: 'ko', chinese: 'zh', vietnamese: 'vi',
  thai: 'th', italian: 'it', portuguese: 'pt', dutch: 'nl',
};

function getLangCode(name) {
  return LANG_CODES[name.toLowerCase()] || name.toLowerCase().slice(0, 2);
}

function googleTranslateRaw(text, targetCode) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetCode}&dt=t&dt=ld&q=${encodeURIComponent(text)}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Translation failed')); }
      });
    }).on('error', reject);
  });
}

async function translate(text, targetLanguage) {
  const targetCode = getLangCode(targetLanguage);
  const json = await googleTranslateRaw(text, targetCode);
  return json[0].map(chunk => chunk[0]).join('');
}

// Fetch recent non-English messages from a channel and detect their language.
// Returns an ISO language code (e.g. 'ja', 'vi') or null if undetermined.
async function detectChannelLanguage(client, channelId) {
  const result = await client.conversations.history({ channel: channelId, limit: 20 });
  const messages = (result.messages || []).filter(m => !m.bot_id && !m.subtype && m.text?.trim());

  for (const msg of messages) {
    const json = await googleTranslateRaw(msg.text, 'en');
    const detectedLang = json[2]; // e.g. 'ja', 'vi', 'en'
    if (detectedLang && detectedLang !== 'en') return detectedLang;
  }
  return null;
}

// ── Incoming: auto-translate messages in monitored channels ────────────────
app.event('message', async ({ event, client, logger }) => {
  try {
    // Skip bot messages, edits, deletes, and your own messages
    if (event.subtype || event.bot_id || event.user === MY_USER_ID) return;
    if (!event.text?.trim()) return;

    const isMonitoredChannel = MONITORED_CHANNELS.includes(event.channel);
    // DMs have channel_type === 'im'; the sender is event.user
    const isMonitoredDM = event.channel_type === 'im' && MONITORED_DM_USERS.includes(event.user);

    if (!isMonitoredChannel && !isMonitoredDM) return;

    const translated = await translate(event.text, 'English');

    if (isMonitoredDM) {
      // In DMs, ephemeral messages aren't supported — post as a bot DM to yourself instead
      await client.chat.postMessage({
        channel: MY_USER_ID, // sends a DM to you from the bot
        text: `🌐 *[Translation from DM]*\n${translated}`,
      });
    } else {
      // In channels, use ephemeral (only you see it, inline)
      await client.chat.postEphemeral({
        channel: event.channel,
        user: MY_USER_ID,
        text: `🌐 *[Translation]*\n${translated}`,
        ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
      });
    }
  } catch (err) {
    logger.error('Error translating incoming message:', err);
  }
});

// ── /ed — single entry point for all commands ─────────────────────────────
// Usage:
//   /ed send Hello everyone, I'll join in 5 minutes
//   /ed send Japanese: Hello   ← force a specific target language
//   /ed trans https://...slack.com/archives/C.../p...
app.command('/ed', async ({ command, ack, client, logger }) => {
  await ack();

  const USAGE = 'Available commands:\n• `/ed send [your message]` — auto-detect channel language, translate and post\n• `/ed trans [Slack message link]` — translate a message privately';

  // Ephemeral messages don't work in DMs — use a bot DM to the user instead
  const isDM = command.channel_id.startsWith('D');
  async function reply(text) {
    if (isDM) {
      await client.chat.postMessage({ channel: command.user_id, text });
    } else {
      await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text });
    }
  }

  try {
    const [subcommand, ...rest] = (command.text || '').trim().split(/\s+/);
    const args = rest.join(' ').trim();

    // ── ed send ────────────────────────────────────────────────────────────
    if (subcommand === 'send') {
      if (!args) {
        await reply('❌ Usage: `/ed send [your message]`\nOptionally force a language: `/ed send Japanese: your message`');
        return;
      }

      let messageText = args;
      let targetCode = null;
      let targetLabel = null;

      // Allow inline language override: "/ed send Japanese: Hello"
      const langOverrideMatch = args.match(/^([A-Za-z\s]{2,20}):\s+([\s\S]+)$/);
      if (langOverrideMatch) {
        targetLabel = langOverrideMatch[1].trim();
        targetCode = getLangCode(targetLabel);
        messageText = langOverrideMatch[2].trim();
      }

      // No override — auto-detect from recent channel messages
      if (!targetCode) {
        targetCode = await detectChannelLanguage(client, command.channel_id);
      }

      // Final fallback to env config or English
      if (!targetCode) {
        targetLabel = CHANNEL_LANGUAGES[command.channel_id] || DEFAULT_OUTGOING_LANG;
        targetCode = getLangCode(targetLabel);
      }

      targetLabel = targetLabel || targetCode;

      const json = await googleTranslateRaw(messageText, targetCode);
      const translated = json[0].map(chunk => chunk[0]).join('');

      await client.chat.postMessage({
        channel: command.channel_id,
        text: translated,
        ...(command.thread_ts ? { thread_ts: command.thread_ts } : {}),
      });

      await reply(`✅ *Sent (→ ${targetLabel})*\n*Original:* ${messageText}\n*Translated:* ${translated}`);

    // ── ed trans ───────────────────────────────────────────────────────────
    } else if (subcommand === 'trans') {
      if (!args) {
        await reply('❌ Usage: `/ed trans [Slack message link]`\nRight-click any message → Copy link, then paste it here.');
        return;
      }

      // Parse Slack message link: .../archives/CHANNEL_ID/pTIMESTAMP
      const match = args.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
      if (!match) {
        await reply('❌ Invalid link. Right-click a Slack message → *Copy link*, then paste it here.');
        return;
      }

      const channelId = match[1];
      const ts = `${match[2]}.${match[3]}`;

      const result = await client.conversations.history({
        channel: channelId,
        latest: ts,
        inclusive: true,
        limit: 1,
      });

      const message = result.messages?.[0];
      if (!message?.text) {
        await reply('❌ Could not fetch that message. Make sure the bot is invited to that channel.');
        return;
      }

      const translated = await translate(message.text, 'English');
      await reply(`🌐 *Translation (only you see this):*\n${translated}`);

    // ── unknown subcommand ─────────────────────────────────────────────────
    } else {
      await reply(`❌ Unknown command \`${subcommand}\`.\n${USAGE}`);
    }
  } catch (err) {
    logger.error('Error in /ed:', err);
    await reply(`❌ Error: ${err.message}`);
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Slack Translator Bot is running on port ${port}`);
  console.log(`📡 Monitoring channels: ${MONITORED_CHANNELS.join(', ') || '(none configured)'}`);
})();
