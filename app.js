require('dotenv').config();
const { App } = require('@slack/bolt');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const gemini = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// ── Translation helper ─────────────────────────────────────────────────────
async function translate(text, targetLanguage) {
  const result = await gemini.generateContent(
    `Translate the following text to ${targetLanguage}. Return ONLY the translated text with no explanations, labels, or extra punctuation:\n\n${text}`
  );
  return result.response.text().trim();
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

// ── Outgoing: /send [your message] → translated → posted to channel ────────
// Usage:
//   /send Hello everyone, I'll join the meeting in 5 minutes
//   /send Japanese: Hola, me uno en 5 minutos   ← override target language
app.command('/send', async ({ command, ack, client, logger }) => {
  await ack();

  try {
    if (!command.text?.trim()) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: '❌ Usage: `/send [your message]`\nOptionally prefix with a language: `/send Japanese: your message`',
      });
      return;
    }

    // Allow inline language override: "/send Japanese: こんにちは"
    let targetLang = CHANNEL_LANGUAGES[command.channel_id] || DEFAULT_OUTGOING_LANG;
    let messageText = command.text;

    const langOverrideMatch = command.text.match(/^([A-Za-z\s]{2,20}):\s+([\s\S]+)$/);
    if (langOverrideMatch) {
      targetLang = langOverrideMatch[1].trim();
      messageText = langOverrideMatch[2].trim();
    }

    const translated = await translate(messageText, targetLang);

    // Post translated message to the channel as the bot
    await client.chat.postMessage({
      channel: command.channel_id,
      text: translated,
      ...(command.thread_ts ? { thread_ts: command.thread_ts } : {}),
    });

    // Show you a confirmation with both versions (only you see this)
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `✅ *Sent (→ ${targetLang})*\n*Original:* ${messageText}\n*Translated:* ${translated}`,
    });
  } catch (err) {
    logger.error('Error translating outgoing message:', err);
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `❌ Translation failed: ${err.message}`,
    });
  }
});

// ── Preview: /translate [text] → shows translation only (doesn't post) ─────
app.command('/translate', async ({ command, ack, client, logger }) => {
  await ack();

  try {
    if (!command.text?.trim()) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: 'Usage: `/translate [text]` — shows you the English translation without posting',
      });
      return;
    }

    const translated = await translate(command.text, 'English');

    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `🌐 *Translation preview (only you see this):*\n${translated}`,
    });
  } catch (err) {
    logger.error('Error in /translate:', err);
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Slack Translator Bot is running on port ${port}`);
  console.log(`📡 Monitoring channels: ${MONITORED_CHANNELS.join(', ') || '(none configured)'}`);
})();
