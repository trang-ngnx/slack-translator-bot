require('dotenv').config();
const { App } = require('@slack/bolt');
const https = require('https');
const Redis = require('ioredis');

// ── Config ─────────────────────────────────────────────────────────────────
const CHANNEL_LANGUAGES = JSON.parse(process.env.CHANNEL_LANGUAGES || '{}');
const DEFAULT_OUTGOING_LANG = process.env.OUTGOING_LANGUAGE || 'English';

// ── Redis persistent store ─────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL);

// Keys used in Redis
const KEYS = {
  subscribers:            'subscribers',
  monitoredChannels:      'monitored_channels',
  monitoredDmUsers:       'monitored_dm_users',
  userIncomingLang:       'user_incoming_lang',
  userChannelOutgoingLang:'user_channel_outgoing_lang',
};

// Set helpers (stored as Redis sets)
async function setAdd(key, value)    { await redis.sadd(key, value); }
async function setRemove(key, value) { await redis.srem(key, value); }
async function setHas(key, value)    { return (await redis.sismember(key, value)) === 1; }
async function setAll(key)           { return new Set(await redis.smembers(key)); }

// Seed a Redis set from comma-separated env var if the set is empty
async function seedSet(key, envValue) {
  const count = await redis.scard(key);
  if (count === 0 && envValue) {
    const members = envValue.split(',').map(s => s.trim()).filter(Boolean);
    if (members.length) await redis.sadd(key, ...members);
  }
}

// Hash helpers (stored as Redis hashes)
async function hashSet(key, field, value) { await redis.hset(key, field, value); }
async function hashGet(key, field)        { return redis.hget(key, field); }
async function hashDel(key, field)        { await redis.hdel(key, field); }

// Seed initial data from env vars (only runs when Redis keys are empty)
async function seedFromEnv() {
  await seedSet(KEYS.subscribers,       process.env.SUBSCRIBER_USER_IDS);
  await seedSet(KEYS.monitoredChannels, process.env.MONITORED_CHANNEL_IDS);
  await seedSet(KEYS.monitoredDmUsers,  process.env.MONITORED_DM_USER_IDS);
}

// ── Clients ────────────────────────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN, // only needed for Socket Mode
  socketMode: process.env.SOCKET_MODE === 'true',
});

// ── Translation helpers ────────────────────────────────────────────────────
const LANG_CODES = {
  english: 'en', japanese: 'ja', french: 'fr', spanish: 'es',
  german: 'de', korean: 'ko', chinese: 'zh', vietnamese: 'vi',
  thai: 'th', italian: 'it', portuguese: 'pt', dutch: 'nl',
};

// Accepts both full names ("Japanese") and ISO codes ("ja")
function getLangCode(input) {
  const lower = input.toLowerCase().trim();
  return LANG_CODES[lower] || lower;
}

// Protect Slack entities from being mangled by translation (ported from joycetran002/slack-translator)
// Replaces mentions, links, emoji, and code blocks with ‹0›, ‹1›... placeholders
const PROTECT_PATTERNS = [
  /```[\s\S]*?```/g,   // code blocks
  /`[^`]+`/g,          // inline code
  /<[^\s][^>]*>/g,     // mentions (<@U...>), channels (<#C...>), links (<https://...>)
  /:[a-z0-9_+\-']+:/g, // emoji shortcodes :thumbsup:
];

function protect(text) {
  const stash = [];
  let result = text;
  for (const pattern of PROTECT_PATTERNS) {
    result = result.replace(pattern, (match) => {
      stash.push(match);
      return `‹${stash.length - 1}›`; // ‹N›
    });
  }
  return { masked: result, stash };
}

function restore(masked, stash) {
  return masked.replace(/‹(\d+)›/g, (_, i) => stash[Number(i)] ?? _);
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
  const { masked, stash } = protect(text);
  const json = await googleTranslateRaw(masked, targetCode);
  const translatedMasked = json[0].map(chunk => chunk[0]).join('');
  return restore(translatedMasked, stash);
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
    // Skip bot messages, edits, deletes
    if (event.subtype || event.bot_id) return;
    if (!event.text?.trim()) return;

    const isMonitoredChannel = await setHas(KEYS.monitoredChannels, event.channel);
    const isMonitoredDM = event.channel_type === 'im' && await setHas(KEYS.monitoredDmUsers, event.user);

    if (!isMonitoredChannel && !isMonitoredDM) return;

    const allSubscribers = await setAll(KEYS.subscribers);

    // Send translation to every subscribed user except the sender
    for (const userId of allSubscribers) {
      if (userId === event.user) continue;
      const targetLang = await hashGet(KEYS.userIncomingLang, userId) || 'en';
      const translated = await translate(event.text, targetLang);

      if (isMonitoredDM) {
        await client.chat.postMessage({
          channel: userId,
          text: `🌐 *[Translation from DM]*\n${translated}`,
        });
      } else {
        await client.chat.postEphemeral({
          channel: event.channel,
          user: userId,
          text: `🌐 *[Translation]*\n${translated}`,
          ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
        });
      }
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

  const USAGE = 'Available commands:\n• `/ed join` — subscribe to auto-translations\n• `/ed leave` — unsubscribe\n• `/ed lang [language]` — set your preferred incoming translation language (e.g. Vietnamese)\n• `/ed watch` — monitor this channel\n• `/ed unwatch` — stop monitoring this channel\n• `/ed dm-watch @user` — monitor DMs from a user sent to the bot\n• `/ed dm-unwatch @user` — stop monitoring\n• `/ed send [language]` — set default outgoing language for this channel (e.g. Japanese)\n• `/ed send [message]` — translate and post to channel\n• `/ed trans [link or text]` — translate privately';

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

    // ── ed join ────────────────────────────────────────────────────────────
    if (subcommand === 'join') {
      if (await setHas(KEYS.subscribers, command.user_id)) {
        await reply('✅ You\'re already subscribed to auto-translations.');
      } else {
        await setAdd(KEYS.subscribers, command.user_id);
        await reply('✅ Subscribed! You\'ll now receive translations for messages in monitored channels.');
      }

    // ── ed leave ───────────────────────────────────────────────────────────
    } else if (subcommand === 'leave') {
      if (!await setHas(KEYS.subscribers, command.user_id)) {
        await reply('You\'re not currently subscribed.');
      } else {
        await setRemove(KEYS.subscribers, command.user_id);
        await reply('👋 Unsubscribed. You\'ll no longer receive auto-translations.');
      }

    // ── ed lang ────────────────────────────────────────────────────────────
    } else if (subcommand === 'lang') {
      if (!args) {
        const current = await hashGet(KEYS.userIncomingLang, command.user_id) || 'en';
        await reply(`Your current incoming translation language is *${current}*.\nUsage: \`/ed lang [language or code]\` — e.g. \`/ed lang vi\` or \`/ed lang Vietnamese\``);
        return;
      }
      const langCode = getLangCode(args);
      await hashSet(KEYS.userIncomingLang, command.user_id, langCode);
      await reply(`✅ Done! Auto-translations will now be delivered to you in *${langCode}*.`);

    // ── ed watch ───────────────────────────────────────────────────────────
    } else if (subcommand === 'watch') {
      if (isDM) {
        await reply('❌ Run `/ed watch` inside a channel, not a DM.');
        return;
      }
      if (await setHas(KEYS.monitoredChannels, command.channel_id)) {
        await reply('✅ This channel is already being monitored.');
      } else {
        await setAdd(KEYS.monitoredChannels, command.channel_id);
        await reply('✅ This channel is now monitored — subscribers will receive auto-translations for new messages here.');
      }

    // ── ed unwatch ─────────────────────────────────────────────────────────
    } else if (subcommand === 'unwatch') {
      if (isDM) {
        await reply('❌ Run `/ed unwatch` inside a channel, not a DM.');
        return;
      }
      if (!await setHas(KEYS.monitoredChannels, command.channel_id)) {
        await reply('This channel is not currently being monitored.');
      } else {
        await setRemove(KEYS.monitoredChannels, command.channel_id);
        await reply('✅ This channel has been removed from monitoring.');
      }

    // ── ed dm-watch ────────────────────────────────────────────────────────
    } else if (subcommand === 'dm-watch') {
      const userMatch = args.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);
      if (!userMatch) {
        await reply('❌ Usage: `/ed dm-watch @username`\n⚠️ Note: this only translates messages that person sends *to the bot*, not their DMs with you directly (Slack API limitation).');
        return;
      }
      const targetUserId = userMatch[1];
      if (await setHas(KEYS.monitoredDmUsers, targetUserId)) {
        await reply(`✅ <@${targetUserId}> is already being monitored.`);
      } else {
        await setAdd(KEYS.monitoredDmUsers, targetUserId);
        await reply(`✅ Done. When <@${targetUserId}> sends a message to the bot, it will be translated for all subscribers.\n⚠️ Reminder: the bot cannot read DMs between you and them directly — only messages they send to the bot.`);
      }

    // ── ed dm-unwatch ──────────────────────────────────────────────────────
    } else if (subcommand === 'dm-unwatch') {
      const userMatch = args.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);
      if (!userMatch) {
        await reply('❌ Usage: `/ed dm-unwatch @username`');
        return;
      }
      const targetUserId = userMatch[1];
      if (!await setHas(KEYS.monitoredDmUsers, targetUserId)) {
        await reply(`<@${targetUserId}> is not currently being monitored.`);
      } else {
        await setRemove(KEYS.monitoredDmUsers, targetUserId);
        await reply(`✅ Stopped monitoring DMs from <@${targetUserId}>.`);
      }

    // ── ed send ────────────────────────────────────────────────────────────
    } else if (subcommand === 'send') {
      if (!args) {
        await reply('❌ Usage:\n• `/ed send [language]` — set default outgoing language for this channel (e.g. `/ed send Japanese`)\n• `/ed send [message]` — translate and post');
        return;
      }

      // If args is a single word that's a known language name or a 2-5 char ISO code, treat as setting default language
      const isLangOnly = args.split(' ').length === 1 &&
        (Object.keys(LANG_CODES).includes(args.toLowerCase()) || /^[a-zA-Z]{2,5}$/.test(args));

      if (isLangOnly) {
        const langCode = getLangCode(args);
        const key = `${command.user_id}:${command.channel_id}`;
        await hashSet(KEYS.userChannelOutgoingLang, key, langCode);
        await reply(`✅ Default outgoing language for this channel set to *${langCode}*. Your next \`/ed send [message]\` will translate to ${langCode}.`);
        return;
      }

      let messageText = args;
      let targetCode = null;
      let targetLabel = null;

      // Allow inline one-time language override: "/ed send Japanese: Hello"
      const langOverrideMatch = args.match(/^([A-Za-z\s]{2,20}):\s+([\s\S]+)$/);
      if (langOverrideMatch) {
        targetLabel = langOverrideMatch[1].trim();
        targetCode = getLangCode(targetLabel);
        messageText = langOverrideMatch[2].trim();
      }

      // Use user's saved outgoing language for this channel
      if (!targetCode) {
        const key = `${command.user_id}:${command.channel_id}`;
        targetCode = await hashGet(KEYS.userChannelOutgoingLang, key) || null;
      }

      // Auto-detect from recent channel messages (skip in DMs — bot has no access)
      if (!targetCode && !isDM) {
        targetCode = await detectChannelLanguage(client, command.channel_id);
      }

      // Final fallback
      if (!targetCode) {
        targetLabel = CHANNEL_LANGUAGES[command.channel_id] || DEFAULT_OUTGOING_LANG;
        targetCode = getLangCode(targetLabel);
      }

      targetLabel = targetLabel || targetCode;

      const json = await googleTranslateRaw(messageText, targetCode);
      const translated = json[0].map(chunk => chunk[0]).join('');

      if (isDM) {
        // Can't post into a user-to-user DM — show translation in a code block (hover to get copy button)
        await reply(`📋 *Translation (→ ${targetLabel}) — hover to copy:*\n\`\`\`${translated}\`\`\``);
      } else {
        // Fetch sender's profile to post with their name and avatar
        const profileRes = await client.users.info({ user: command.user_id });
        const profile = profileRes.user?.profile;
        const displayName = profile?.display_name || profile?.real_name || 'Unknown';
        const avatarUrl = profile?.image_72;

        await client.chat.postMessage({
          channel: command.channel_id,
          text: translated,
          username: displayName,
          icon_url: avatarUrl,
          ...(command.thread_ts ? { thread_ts: command.thread_ts } : {}),
        });

        await reply(`✅ *Sent (→ ${targetLabel})*\n*Original:* ${messageText}\n*Translated:* ${translated}`);
      }

    // ── ed trans ───────────────────────────────────────────────────────────
    } else if (subcommand === 'trans') {
      if (!args) {
        await reply('❌ Usage:\n• `/ed trans [Slack message link]` — translate a message by link\n• `/ed trans [any text]` — translate text directly');
        return;
      }

      let textToTranslate = args;

      // If it looks like a Slack message link, fetch the message text first
      const match = args.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
      if (match) {
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
          await reply('❌ Could not fetch that message. Make sure the bot is invited to that channel.\n\nTip: for DM messages, copy the text directly and use `/ed trans [paste text]` instead.');
          return;
        }
        textToTranslate = message.text;
      }

      const translated = await translate(textToTranslate, 'English');
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
  await seedFromEnv();
  const port = process.env.PORT || 3000;
  await app.start(port);
  const channels = await setAll(KEYS.monitoredChannels);
  console.log(`⚡️ Slack Translator Bot is running on port ${port}`);
  console.log(`📡 Monitoring channels: ${[...channels].join(', ') || '(none configured)'}`);
})();
