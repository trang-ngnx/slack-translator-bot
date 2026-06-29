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

// ── Translation helper (MyMemory API — free, no key needed) ───────────────
// Language name → ISO code map for common languages
const LANG_CODES = {
  english: 'en', japanese: 'ja', french: 'fr', spanish: 'es',
  german: 'de', korean: 'ko', chinese: 'zh', vietnamese: 'vi',
  thai: 'th', italian: 'it', portuguese: 'pt', dutch: 'nl',
};

function getLangCode(name) {
  return LANG_CODES[name.toLowerCase()] || name.toLowerCase().slice(0, 2);
}

async function translate(text, targetLanguage) {
  const targetCode = getLangCode(targetLanguage);
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|${targetCode}`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.responseData.translatedText);
        } catch (e) {
          reject(new Error('Translation failed'));
        }
      });
    }).on('error', reject);
  });
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
//   /ed send Japanese: Hola, me uno en 5 minutos   ← override target language
//   /ed translate https://...slack.com/archives/C.../p...
app.command('/ed', async ({ command, ack, client, logger }) => {
  await ack();

  const USAGE = 'Available commands:\n• `/ed send [your message]` — translate and post to channel\n• `/ed translate [Slack message link]` — translate a message privately';

  try {
    const [subcommand, ...rest] = (command.text || '').trim().split(/\s+/);
    const args = rest.join(' ').trim();

    // ── ed send ────────────────────────────────────────────────────────────
    if (subcommand === 'send') {
      if (!args) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: '❌ Usage: `/ed send [your message]`\nOptionally prefix with a language: `/ed send Japanese: your message`',
        });
        return;
      }

      // Allow inline language override: "/ed send Japanese: こんにちは"
      let targetLang = CHANNEL_LANGUAGES[command.channel_id] || DEFAULT_OUTGOING_LANG;
      let messageText = args;

      const langOverrideMatch = args.match(/^([A-Za-z\s]{2,20}):\s+([\s\S]+)$/);
      if (langOverrideMatch) {
        targetLang = langOverrideMatch[1].trim();
        messageText = langOverrideMatch[2].trim();
      }

      const translated = await translate(messageText, targetLang);

      await client.chat.postMessage({
        channel: command.channel_id,
        text: translated,
        ...(command.thread_ts ? { thread_ts: command.thread_ts } : {}),
      });

      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `✅ *Sent (→ ${targetLang})*\n*Original:* ${messageText}\n*Translated:* ${translated}`,
      });

    // ── ed translate ───────────────────────────────────────────────────────
    } else if (subcommand === 'translate') {
      if (!args) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: '❌ Usage: `/ed translate [Slack message link]`\nRight-click any message → Copy link, then paste it here.',
        });
        return;
      }

      // Parse Slack message link: .../archives/CHANNEL_ID/pTIMESTAMP
      const match = args.match(/\/archives\/(C[A-Z0-9]+)\/p(\d{10})(\d{6})/);
      if (!match) {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: '❌ Invalid link. Right-click a Slack message → *Copy link*, then paste it here.',
        });
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
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: '❌ Could not fetch that message. Make sure the bot is invited to that channel.',
        });
        return;
      }

      const translated = await translate(message.text, 'English');

      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `🌐 *Translation (only you see this):*\n${translated}`,
      });

    // ── unknown subcommand ─────────────────────────────────────────────────
    } else {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `❌ Unknown command.\n${USAGE}`,
      });
    }
  } catch (err) {
    logger.error('Error in /ed:', err);
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `❌ Error: ${err.message}`,
    });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Slack Translator Bot is running on port ${port}`);
  console.log(`📡 Monitoring channels: ${MONITORED_CHANNELS.join(', ') || '(none configured)'}`);
})();
