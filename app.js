require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const https = require('https');
const http = require('http');
const Redis = require('ioredis');

// ── Config ─────────────────────────────────────────────────────────────────
const CHANNEL_LANGUAGES = JSON.parse(process.env.CHANNEL_LANGUAGES || '{}');
const DEFAULT_OUTGOING_LANG = process.env.OUTGOING_LANGUAGE || 'English';

// ── Redis persistent store ─────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL);

const KEYS = {
  subscribers:            'subscribers',
  monitoredChannels:      'monitored_channels',
  monitoredDmUsers:       'monitored_dm_users',
  userIncomingLang:       'user_incoming_lang',
  userChannelOutgoingLang:'user_channel_outgoing_lang',
  userTokens:             'user_tokens',   // hash: userId → user OAuth token
};

async function setAdd(key, value)    { await redis.sadd(key, value); }
async function setRemove(key, value) { await redis.srem(key, value); }
async function setHas(key, value)    { return (await redis.sismember(key, value)) === 1; }
async function setAll(key)           { return new Set(await redis.smembers(key)); }

async function seedSet(key, envValue) {
  const count = await redis.scard(key);
  if (count === 0 && envValue) {
    const members = envValue.split(',').map(s => s.trim()).filter(Boolean);
    if (members.length) await redis.sadd(key, ...members);
  }
}

async function hashSet(key, field, value) { await redis.hset(key, field, value); }
async function hashGet(key, field)        { return redis.hget(key, field); }
async function hashDel(key, field)        { await redis.hdel(key, field); }

async function seedFromEnv() {
  await seedSet(KEYS.subscribers,       process.env.SUBSCRIBER_USER_IDS);
  await seedSet(KEYS.monitoredChannels, process.env.MONITORED_CHANNEL_IDS);
  await seedSet(KEYS.monitoredDmUsers,  process.env.MONITORED_DM_USER_IDS);
}

// ── User token helpers ─────────────────────────────────────────────────────
async function getUserToken(userId) {
  return hashGet(KEYS.userTokens, userId);
}

// Returns a WebClient using the user's own token if available, otherwise bot token
async function clientFor(userId) {
  const userToken = await getUserToken(userId);
  return userToken ? new WebClient(userToken) : null;
}

// Post a message as the real user (no App badge) if they've done /ed login,
// otherwise fall back to posting with their name/avatar via the bot token.
async function postAsUser(botClient, userId, params) {
  const userClient = await clientFor(userId);
  if (userClient) {
    // Post directly as the user — no App badge, no custom username needed
    const { username, icon_url, ...rest } = params;
    return userClient.chat.postMessage(rest);
  }
  // Fallback: bot posts with user's display name and avatar
  return botClient.chat.postMessage(params);
}

// ── Slack app (ExpressReceiver for custom OAuth route) ─────────────────────
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: process.env.SOCKET_MODE === 'true',
});

// ── OAuth callback route ───────────────────────────────────────────────────
receiver.router.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error || !code || !state) {
    return res.send('<p>Authorization failed or was cancelled. You can close this tab.</p>');
  }

  // Decode userId from state (base64url encoded as "userId:nonce")
  let userId;
  try {
    const padded = state.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((state.length * 3) % 4);
    const decoded = Buffer.from(padded, 'base64').toString();
    userId = decoded.split(':')[0];
    if (!userId) throw new Error('empty');
  } catch {
    return res.send('<p>Invalid state parameter. Please run <b>/ed login</b> again in Slack.</p>');
  }

  try {
    // Exchange code for user token
    const result = await exchangeOAuthCode(code);
    const userToken = result.authed_user?.access_token;

    if (!userToken) throw new Error('No user token in response');

    await hashSet(KEYS.userTokens, userId, userToken);

    // Notify user in Slack
    await app.client.chat.postMessage({
      channel: userId,
      text: '✅ *You\'re all set!* Your messages will now be sent directly from you — no more "App" badge.',
    });

    res.send('<p>✅ Authorization successful! You can close this tab and return to Slack.</p>');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.send('<p>Something went wrong. Please try <b>/ed login</b> again in Slack.</p>');
  }
});

function exchangeOAuthCode(code) {
  const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI;
  const body = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    client_secret: process.env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'slack.com',
      path: '/api/oauth.v2.access',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) reject(new Error(json.error));
          else resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Translation helpers ────────────────────────────────────────────────────
const LANG_CODES = {
  english: 'en', japanese: 'ja', french: 'fr', spanish: 'es',
  german: 'de', korean: 'ko', chinese: 'zh', vietnamese: 'vi',
  thai: 'th', italian: 'it', portuguese: 'pt', dutch: 'nl',
};

function getLangCode(input) {
  const lower = input.toLowerCase().trim();
  return LANG_CODES[lower] || lower;
}

const PROTECT_PATTERNS = [
  /```[\s\S]*?```/g,
  /`[^`]+`/g,
  /<[^\s][^>]*>/g,
  /:[a-z0-9_+\-']+:/g,
];

function protect(text) {
  const stash = [];
  let result = text;
  for (const pattern of PROTECT_PATTERNS) {
    result = result.replace(pattern, (match) => {
      stash.push(match);
      return `‹${stash.length - 1}›`;
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

async function translateSegment(text, targetCode) {
  const { masked, stash } = protect(text);
  const json = await googleTranslateRaw(masked, targetCode);
  return restore(json[0].map(c => c[0]).join(''), stash);
}

async function translate(text, targetLanguage) {
  const targetCode = getLangCode(targetLanguage);
  const FORMAT_RE = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;

  const segments = [];
  let last = 0;
  let m;
  while ((m = FORMAT_RE.exec(text)) !== null) {
    if (m.index > last) segments.push({ fmt: null, text: text.slice(last, m.index) });
    const marker = m[0][0];
    segments.push({ fmt: marker, text: m[0].slice(1, -1) });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ fmt: null, text: text.slice(last) });

  const parts = await Promise.all(segments.map(async seg => {
    if (!seg.text.trim()) return seg.text;
    const translated = await translateSegment(seg.text, targetCode);
    return seg.fmt ? `${seg.fmt}${translated}${seg.fmt}` : translated;
  }));

  return parts.join('');
}

async function detectChannelLanguage(client, channelId) {
  const result = await client.conversations.history({ channel: channelId, limit: 20 });
  const messages = (result.messages || []).filter(m => !m.bot_id && !m.subtype && m.text?.trim());
  for (const msg of messages) {
    const json = await googleTranslateRaw(msg.text, 'en');
    const detectedLang = json[2];
    if (detectedLang && detectedLang !== 'en') return detectedLang;
  }
  return null;
}

// ── Rich text helpers ──────────────────────────────────────────────────────

// Translate a rich_text block in-place: only text elements are translated,
// all style/structure (bold, italic, strike, links, emoji) is preserved.
async function translateRichText(richText, targetLang) {
  const targetCode = getLangCode(targetLang);
  const clone = JSON.parse(JSON.stringify(richText));

  for (const block of clone.elements || []) {
    const items = block.type === 'rich_text_list'
      ? (block.elements || []).flatMap(li => li.elements || [])
      : (block.elements || []);

    for (const el of items) {
      if (el.type === 'text' && el.text?.trim() && !el.style?.code) {
        const json = await googleTranslateRaw(el.text, targetCode);
        el.text = json[0].map(c => c[0]).join('');
      }
    }
  }

  return clone;
}

// Plain-text fallback for chat.postMessage `text` field (used alongside blocks)
function richTextToPlain(richText) {
  if (!richText?.elements) return '';
  const parts = [];
  for (const block of richText.elements || []) {
    const items = block.type === 'rich_text_list'
      ? (block.elements || []).flatMap(li => li.elements || [])
      : (block.elements || []);
    for (const el of items) {
      if (el.type === 'text') parts.push(el.text || '');
      else if (el.type === 'emoji') parts.push(`:${el.name}:`);
    }
  }
  return parts.join('');
}

// ── Shared modal definition ────────────────────────────────────────────────
function translateReplyModalView(channelId, threadTs) {
  return {
    type: 'modal',
    callback_id: 'translate_reply_modal',
    private_metadata: JSON.stringify({ channelId, threadTs }),
    title: { type: 'plain_text', text: 'Translate & Reply' },
    submit: { type: 'plain_text', text: 'Translate & Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'message_block',
        label: { type: 'plain_text', text: 'Your message' },
        element: {
          type: 'rich_text_input',
          action_id: 'message_input',
          placeholder: { type: 'plain_text', text: 'Type your message here…' },
        },
      },
      {
        type: 'input',
        block_id: 'lang_block',
        label: { type: 'plain_text', text: 'Target language (optional)' },
        hint: { type: 'plain_text', text: 'e.g. ja, en, vi — leave blank to auto-detect from channel' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'lang_input',
          placeholder: { type: 'plain_text', text: 'ja' },
        },
      },
    ],
  };
}

// ── Incoming: auto-translate messages in monitored channels ────────────────
app.event('message', async ({ event, client, logger }) => {
  try {
    if (event.subtype || event.bot_id) return;
    if (!event.text?.trim()) return;

    const isMonitoredChannel = await setHas(KEYS.monitoredChannels, event.channel);
    const isMonitoredDM = event.channel_type === 'im' && await setHas(KEYS.monitoredDmUsers, event.user);

    if (!isMonitoredChannel && !isMonitoredDM) return;

    const allSubscribers = await setAll(KEYS.subscribers);
    const isThreadReply = !!event.thread_ts && event.thread_ts !== event.ts;
    const ctx = JSON.stringify({ channelId: event.channel, threadTs: event.thread_ts || event.ts, messageTs: event.ts });

    for (const userId of allSubscribers) {
      if (userId === event.user) continue;
      const targetLang = await hashGet(KEYS.userIncomingLang, userId) || 'en';

      if (isMonitoredDM) {
        const translated = await translate(event.text, targetLang);
        await client.chat.postMessage({
          channel: userId,
          text: `🌐 *[Translation from DM]*\n${translated}`,
        });
      } else if (isThreadReply) {
        await client.chat.postEphemeral({
          channel: event.channel,
          user: userId,
          thread_ts: event.thread_ts,
          text: '💬 New thread message — what would you like to do?',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '💬 *New message in thread* — only you see this.' },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: '🌐 Translate this message', emoji: true },
                  action_id: 'thread_translate_msg',
                  value: ctx,
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: '✏️ Reply with translation', emoji: true },
                  style: 'primary',
                  action_id: 'thread_open_reply_modal',
                  value: ctx,
                },
              ],
            },
          ],
        });
      } else {
        const translated = await translate(event.text, targetLang);
        await client.chat.postEphemeral({
          channel: event.channel,
          user: userId,
          text: `🌐 *[Translation]*\n${translated}`,
        });
      }
    }
  } catch (err) {
    logger.error('Error translating incoming message:', err);
  }
});

// ── /ed — single entry point for all commands ─────────────────────────────
app.command('/ed', async ({ command, ack, client, logger }) => {
  await ack();

  const USAGE = 'Available commands:\n• `/ed join` — subscribe to auto-translations\n• `/ed leave` — unsubscribe\n• `/ed lang [language]` — set your preferred incoming translation language\n• `/ed watch` — monitor this channel\n• `/ed unwatch` — stop monitoring this channel\n• `/ed dm-watch @user` — monitor DMs from a user sent to the bot\n• `/ed dm-unwatch @user` — stop monitoring\n• `/ed send [language]` — set default outgoing language for this channel\n• `/ed send [message]` — translate and post to channel\n• `/ed trans [link or text]` — translate privately\n• `/ed login` — authorize so your messages send without the "App" badge\n• `/ed logout` — remove your authorization';

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

    // ── ed login ───────────────────────────────────────────────────────────
    if (subcommand === 'login') {
      const existingToken = await getUserToken(command.user_id);
      if (existingToken) {
        await reply('✅ You\'re already authorized. Your messages are sent directly from you.\nUse `/ed logout` to remove authorization.');
        return;
      }
      // Encode userId in state directly — avoids Redis timing issues
      const nonce = Math.random().toString(36).slice(2);
      const state = Buffer.from(`${command.user_id}:${nonce}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

      const redirectUri = encodeURIComponent(process.env.SLACK_OAUTH_REDIRECT_URI);
      const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&user_scope=chat:write&redirect_uri=${redirectUri}&state=${state}`;

      await client.chat.postMessage({
        channel: command.user_id,
        text: `🔑 *Authorize the translator to post as you*\n\nClick the link below — it only asks for permission to post messages on your behalf:\n\n<${authUrl}|Click here to authorize>\n\nThis link expires in 10 minutes.`,
      });
      await reply('📨 Check your DMs with the bot — I sent you a private authorization link.');

    // ── ed logout ──────────────────────────────────────────────────────────
    } else if (subcommand === 'logout') {
      await hashDel(KEYS.userTokens, command.user_id);
      await reply('✅ Authorization removed. Messages will now be sent via the bot with your name and avatar.');

    // ── ed join ────────────────────────────────────────────────────────────
    } else if (subcommand === 'join') {
      if (await setHas(KEYS.subscribers, command.user_id)) {
        await reply('✅ You\'re already subscribed to auto-translations.');
      } else {
        await setAdd(KEYS.subscribers, command.user_id);
        await reply('✅ Subscribed! You\'ll now receive translations for messages in monitored channels.');
      }

    } else if (subcommand === 'leave') {
      if (!await setHas(KEYS.subscribers, command.user_id)) {
        await reply('You\'re not currently subscribed.');
      } else {
        await setRemove(KEYS.subscribers, command.user_id);
        await reply('👋 Unsubscribed. You\'ll no longer receive auto-translations.');
      }

    } else if (subcommand === 'lang') {
      if (!args) {
        const current = await hashGet(KEYS.userIncomingLang, command.user_id) || 'en';
        await reply(`Your current incoming translation language is *${current}*.\nUsage: \`/ed lang [language or code]\` — e.g. \`/ed lang vi\` or \`/ed lang Vietnamese\``);
        return;
      }
      const langCode = getLangCode(args);
      await hashSet(KEYS.userIncomingLang, command.user_id, langCode);
      await reply(`✅ Done! Auto-translations will now be delivered to you in *${langCode}*.`);

    } else if (subcommand === 'watch') {
      if (isDM) { await reply('❌ Run `/ed watch` inside a channel, not a DM.'); return; }
      if (await setHas(KEYS.monitoredChannels, command.channel_id)) {
        await reply('✅ This channel is already being monitored.');
      } else {
        await setAdd(KEYS.monitoredChannels, command.channel_id);
        await reply('✅ This channel is now monitored — subscribers will receive auto-translations for new messages here.');
      }

    } else if (subcommand === 'unwatch') {
      if (isDM) { await reply('❌ Run `/ed unwatch` inside a channel, not a DM.'); return; }
      if (!await setHas(KEYS.monitoredChannels, command.channel_id)) {
        await reply('This channel is not currently being monitored.');
      } else {
        await setRemove(KEYS.monitoredChannels, command.channel_id);
        await reply('✅ This channel has been removed from monitoring.');
      }

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

    } else if (subcommand === 'dm-unwatch') {
      const userMatch = args.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);
      if (!userMatch) { await reply('❌ Usage: `/ed dm-unwatch @username`'); return; }
      const targetUserId = userMatch[1];
      if (!await setHas(KEYS.monitoredDmUsers, targetUserId)) {
        await reply(`<@${targetUserId}> is not currently being monitored.`);
      } else {
        await setRemove(KEYS.monitoredDmUsers, targetUserId);
        await reply(`✅ Stopped monitoring DMs from <@${targetUserId}>.`);
      }

    } else if (subcommand === 'send') {
      if (!args) {
        await reply('❌ Usage:\n• `/ed send [language]` — set default outgoing language for this channel\n• `/ed send [message]` — translate and post');
        return;
      }

      const isLangOnly = args.split(' ').length === 1 &&
        (Object.keys(LANG_CODES).includes(args.toLowerCase()) || /^[a-zA-Z]{2,5}$/.test(args));

      if (isLangOnly) {
        const langCode = getLangCode(args);
        const key = `${command.user_id}:${command.channel_id}`;
        await hashSet(KEYS.userChannelOutgoingLang, key, langCode);
        await reply(`✅ Default outgoing language for this channel set to *${langCode}*.`);
        return;
      }

      let messageText = args;
      let targetCode = null;
      let targetLabel = null;

      const langOverrideMatch = args.match(/^([A-Za-z\s]{2,20}):\s+([\s\S]+)$/);
      if (langOverrideMatch) {
        targetLabel = langOverrideMatch[1].trim();
        targetCode = getLangCode(targetLabel);
        messageText = langOverrideMatch[2].trim();
      }

      if (!targetCode) {
        const key = `${command.user_id}:${command.channel_id}`;
        targetCode = await hashGet(KEYS.userChannelOutgoingLang, key) || null;
      }

      if (!targetCode && !isDM) {
        targetCode = await detectChannelLanguage(client, command.channel_id);
      }

      if (!targetCode) {
        targetLabel = CHANNEL_LANGUAGES[command.channel_id] || DEFAULT_OUTGOING_LANG;
        targetCode = getLangCode(targetLabel);
      }

      targetLabel = targetLabel || targetCode;
      const translated = await translate(messageText, targetCode);

      if (isDM) {
        await reply(`📋 *Translation (→ ${targetLabel}):*\n\n${translated}`);
      } else {
        const profileRes = await client.users.info({ user: command.user_id });
        const profile = profileRes.user?.profile;
        const displayName = profile?.display_name || profile?.real_name || 'Unknown';
        const avatarUrl = profile?.image_72;

        await postAsUser(client, command.user_id, {
          channel: command.channel_id,
          text: translated,
          username: displayName,
          icon_url: avatarUrl,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: translated } }],
          ...(command.thread_ts ? { thread_ts: command.thread_ts } : {}),
        });

        await reply(`✅ *Sent (→ ${targetLabel})*\n*Original:* ${messageText}\n*Translated:* ${translated}`);
      }

    } else if (subcommand === 'trans') {
      if (!args) {
        await reply('❌ Usage:\n• `/ed trans [Slack message link]` — translate a message by link\n• `/ed trans [any text]` — translate text directly');
        return;
      }

      let textToTranslate = args;

      const match = args.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
      if (match) {
        const channelId = match[1];
        const ts = `${match[2]}.${match[3]}`;
        const result = await client.conversations.history({ channel: channelId, latest: ts, inclusive: true, limit: 1 });
        const message = result.messages?.[0];
        if (!message?.text) {
          await reply('❌ Could not fetch that message. Make sure the bot is invited to that channel.\n\nTip: for DM messages, copy the text directly and use `/ed trans [paste text]` instead.');
          return;
        }
        textToTranslate = message.text;
      }

      const translated = await translate(textToTranslate, 'English');
      await reply(`🌐 *Translation (only you see this):*\n${translated}`);

    } else {
      await reply(`❌ Unknown command \`${subcommand}\`.\n${USAGE}`);
    }
  } catch (err) {
    logger.error('Error in /ed:', err);
    await reply(`❌ Error: ${err.message}`);
  }
});

// ── Thread button: "Translate this message" ───────────────────────────────
app.action('thread_translate_msg', async ({ body, ack, client, logger }) => {
  await ack();
  try {
    const { channelId, threadTs, messageTs } = JSON.parse(body.actions[0].value);
    const userId = body.user.id;

    const result = await client.conversations.replies({ channel: channelId, ts: threadTs, inclusive: true, limit: 100 });
    const message = result.messages?.find(m => m.ts === messageTs);
    if (!message?.text) {
      await client.chat.postEphemeral({ channel: channelId, user: userId, thread_ts: threadTs, text: '❌ Could not fetch the message.' });
      return;
    }

    const targetLang = await hashGet(KEYS.userIncomingLang, userId) || 'en';
    const translated = await translate(message.text, targetLang);

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: threadTs,
      text: `🌐 *Translation (only you see this):*\n${translated}`,
    });
  } catch (err) {
    logger.error('Error in thread_translate_msg:', err);
  }
});

// ── Thread button: "Reply with translation" ────────────────────────────────
app.action('thread_open_reply_modal', async ({ body, ack, client, logger }) => {
  await ack();
  try {
    const { channelId, threadTs } = JSON.parse(body.actions[0].value);
    await client.views.open({ trigger_id: body.trigger_id, view: translateReplyModalView(channelId, threadTs) });
  } catch (err) {
    logger.error('Error in thread_open_reply_modal:', err);
  }
});

// ── Message shortcut: "Translate this message" ────────────────────────────
app.shortcut('translate_message', async ({ shortcut, ack, client, logger }) => {
  await ack();
  try {
    const channelId = shortcut.channel?.id;
    const userId = shortcut.user.id;
    const messageText = shortcut.message?.text;
    const threadTs = shortcut.message?.thread_ts || shortcut.message?.ts;

    if (!messageText?.trim()) {
      await client.chat.postEphemeral({ channel: channelId, user: userId, text: '❌ This message has no text to translate.' });
      return;
    }

    const targetLang = await hashGet(KEYS.userIncomingLang, userId) || 'en';
    const translated = await translate(messageText, targetLang);

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: threadTs,
      text: `🌐 *Translation (only you see this):*\n${translated}`,
    });
  } catch (err) {
    logger.error('Error in translate_message shortcut:', err);
  }
});

// ── Message shortcut: "Translate & Reply" ─────────────────────────────────
app.shortcut('translate_reply', async ({ shortcut, ack, client, logger }) => {
  await ack();
  try {
    const channelId = shortcut.channel?.id;
    const threadTs = shortcut.message?.thread_ts || shortcut.message?.ts;
    await client.views.open({ trigger_id: shortcut.trigger_id, view: translateReplyModalView(channelId, threadTs) });
  } catch (err) {
    logger.error('Error in translate_reply shortcut:', err);
  }
});

// ── Modal submit: translate & post to thread ───────────────────────────────
app.view('translate_reply_modal', async ({ view, ack, client, body, logger }) => {
  await ack();
  try {
    const { channelId, threadTs } = JSON.parse(view.private_metadata);
    const langInput = view.state.values.lang_block.lang_input.value?.trim();
    const richTextValue = view.state.values.message_block.message_input.rich_text_value;

    if (!richTextValue) return;

    let targetCode = langInput ? getLangCode(langInput) : null;
    if (!targetCode) targetCode = await detectChannelLanguage(client, channelId);
    if (!targetCode) targetCode = getLangCode(DEFAULT_OUTGOING_LANG);

    // Translate each text element individually — preserves bold/italic/strike structure
    const translatedRichText = await translateRichText(richTextValue, targetCode);
    const plainFallback = richTextToPlain(translatedRichText);

    const profileRes = await client.users.info({ user: body.user.id });
    const profile = profileRes.user?.profile;
    const displayName = profile?.display_name || profile?.real_name || 'Unknown';
    const avatarUrl = profile?.image_72;

    await postAsUser(client, body.user.id, {
      channel: channelId,
      thread_ts: threadTs,
      text: plainFallback,
      username: displayName,
      icon_url: avatarUrl,
      blocks: [{ type: 'rich_text', elements: translatedRichText.elements }],
    });
  } catch (err) {
    logger.error('Error in translate_reply_modal submit:', err);
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
