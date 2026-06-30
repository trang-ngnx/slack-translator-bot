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

// Per-user per-channel translation viewers (Redis set per key)
function viewersKey(userId, channelId) { return `viewers:${userId}:${channelId}`; }
async function viewersAdd(userId, channelId, viewerIds)  { await redis.sadd(viewersKey(userId, channelId), ...viewerIds); }
async function viewersRemove(userId, channelId, viewerId){ await redis.srem(viewersKey(userId, channelId), viewerId); }
async function viewersList(userId, channelId)            { return redis.smembers(viewersKey(userId, channelId)); }
async function viewersClear(userId, channelId)           { await redis.del(viewersKey(userId, channelId)); }

// Send ephemeral notifications to all viewers of a translation in a channel
async function notifyViewers(client, { senderId, channelId, threadTs, senderName, originalText, translatedBlocks, targetLabel }) {
  const ids = await viewersList(senderId, channelId);
  if (!ids.length) return;
  for (const viewerId of ids) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: viewerId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: `👁 *[${senderName} → ${targetLabel}]* ${originalText}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `👁 *${senderName}* sent a translated message (→ ${targetLabel}):\n*Original:* ${originalText}` } },
        { type: 'divider' },
        { type: 'rich_text', elements: translatedBlocks },
      ],
    });
  }
}

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
  /<(?:[@#!]|https?:\/\/)[^>]*>/g,  // Slack entities: <@U...>, <#C...>, <http...>, <!...>
  /:[a-z0-9_+\-']+:/g,
];

function protect(text) {
  const stash = [];
  let result = text;
  for (const pattern of PROTECT_PATTERNS) {
    result = result.replace(pattern, (match) => {
      stash.push(match);
      return `<!--z${stash.length - 1}-->`;  // HTML comments are never touched by Google Translate
    });
  }
  return { masked: result, stash };
}

function restore(masked, stash) {
  return masked.replace(/<!--z(\d+)-->/g, (_, i) => stash[Number(i)] ?? _);
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
// Expand any :emoji_name: shortcodes in a string into a mix of text/emoji elements,
// preserving the style of the original text element.
function expandEmojiShortcodes(text, style) {
  const EMOJI_RE = /:[a-z0-9_+\-']+:/g;
  const result = [];
  let last = 0;
  let m;
  while ((m = EMOJI_RE.exec(text)) !== null) {
    if (m.index > last) {
      const el = { type: 'text', text: text.slice(last, m.index) };
      if (style) el.style = style;
      result.push(el);
    }
    result.push({ type: 'emoji', name: m[0].slice(1, -1) });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const el = { type: 'text', text: text.slice(last) };
    if (style) el.style = style;
    result.push(el);
  }
  return result.length ? result : [{ type: 'text', text, ...(style ? { style } : {}) }];
}

async function translateRichText(richText, targetLang) {
  const targetCode = getLangCode(targetLang);
  const clone = JSON.parse(JSON.stringify(richText));

  for (const block of clone.elements || []) {
    const lists = block.type === 'rich_text_list' ? (block.elements || []) : [block];
    for (const section of lists) {
      const newElements = [];
      for (const el of (section.elements || [])) {
        if (el.type === 'text' && el.text?.trim() && !el.style?.code) {
          const { masked, stash } = protect(el.text);
          const json = await googleTranslateRaw(masked, targetCode);
          const restored = restore(json[0].map(c => c[0]).join(''), stash);
          // Expand :emoji: shortcodes into proper emoji elements so they render in Slack
          newElements.push(...expandEmojiShortcodes(restored, el.style));
        } else {
          newElements.push(el);
        }
      }
      section.elements = newElements;
    }
  }

  return clone;
}

// Convert mrkdwn string to a rich_text block structure so it can be translated
// element-by-element and posted as a native rich_text block (avoids marker rendering issues)
function mrkdwnToRichText(text) {
  const elements = [];
  // Match Slack links, formatting markers, and emoji shortcodes
  const TOKEN_RE = /<(https?:\/\/[^|>]+)\|([^>]+)>|<(https?:\/\/[^>]+)>|(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`)|(:([a-z0-9_+\-']+):)/g;
  let last = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) elements.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1]) {
      elements.push({ type: 'link', url: m[1], text: m[2] });
    } else if (m[3]) {
      elements.push({ type: 'link', url: m[3] });
    } else if (m[4]) {
      const marker = m[4][0];
      const inner = m[4].slice(1, -1);
      const style = marker === '*' ? { bold: true }
                  : marker === '_' ? { italic: true }
                  : marker === '~' ? { strike: true }
                  : { code: true };
      elements.push({ type: 'text', text: inner, style });
    } else {
      // :emoji_name: → native emoji element
      elements.push({ type: 'emoji', name: m[6] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) elements.push({ type: 'text', text: text.slice(last) });
  return { type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] };
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

    // Fetch sender's display name once for all subscribers
    const senderInfo = await client.users.info({ user: event.user });
    const senderName = senderInfo.user?.profile?.display_name || senderInfo.user?.profile?.real_name || 'Someone';

    for (const userId of allSubscribers) {
      if (userId === event.user) continue;
      const targetLang = await hashGet(KEYS.userIncomingLang, userId) || 'en';

      if (isMonitoredDM) {
        const translated = await translate(event.text, targetLang);
        await client.chat.postMessage({
          channel: userId,
          text: `🌐 *[${senderName} — DM Translation]*\n${translated}`,
        });
      } else if (isThreadReply) {
        const translated = await translate(event.text, targetLang);
        await client.chat.postEphemeral({
          channel: event.channel,
          user: userId,
          thread_ts: event.thread_ts,
          text: `🌐 *[${senderName}]* ${translated}`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `🌐 *[${senderName}]* ${translated}` },
            },
            {
              type: 'actions',
              elements: [
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
          text: `🌐 *[${senderName}]* ${translated}`,
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

  const USAGE = 'Available commands:\n• `/ed join` — subscribe to auto-translations\n• `/ed leave` — unsubscribe\n• `/ed lang [language]` — set your preferred incoming translation language\n• `/ed watch` — monitor this channel\n• `/ed unwatch` — stop monitoring this channel\n• `/ed dm-watch @user` — monitor DMs from a user sent to the bot\n• `/ed dm-unwatch @user` — stop monitoring\n• `/ed send [language]` — set default outgoing language for this channel\n• `/ed send [message]` — translate and post to channel\n• `/ed trans [link or text]` — translate privately\n• `/ed viewers add @alice @bob` — let colleagues privately see your translations here\n• `/ed viewers remove @alice` | `list` | `clear`\n• `/ed login` — authorize so your messages send without the "App" badge\n• `/ed logout` — remove your authorization';

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

      if (isDM) {
        const translated = await translate(messageText, targetCode);
        await reply(`📋 *Translation (→ ${targetLabel}):*\n\n${translated}`);
      } else {
        const richText = mrkdwnToRichText(messageText);
        const translatedRichText = await translateRichText(richText, targetCode);
        const plainFallback = richTextToPlain(translatedRichText);

        const profileRes = await client.users.info({ user: command.user_id });
        const profile = profileRes.user?.profile;
        const displayName = profile?.display_name || profile?.real_name || 'Unknown';
        const avatarUrl = profile?.image_72;

        const sent = await postAsUser(client, command.user_id, {
          channel: command.channel_id,
          text: plainFallback,
          username: displayName,
          icon_url: avatarUrl,
          blocks: [{ type: 'rich_text', elements: translatedRichText.elements }],
          ...(command.thread_ts ? { thread_ts: command.thread_ts } : {}),
        });

        // Ephemeral in the thread of the sent message — only visible to sender
        const sentTs = sent?.ts || sent?.message?.ts;
        logger.info(`[ed send] sent.ts=${sentTs}`, sent);
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          thread_ts: sentTs,
          username: displayName,
          icon_url: avatarUrl,
          text: `✅ *Sent (→ ${targetLabel})* — only you see this\n*Original:* ${messageText}`,
        });

        // Notify viewers — post in the thread of the sent message
        await notifyViewers(client, {
          senderId: command.user_id,
          channelId: command.channel_id,
          threadTs: sentTs,
          senderName: displayName,
          originalText: messageText,
          translatedBlocks: translatedRichText.elements,
          targetLabel,
        });
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

    // ── ed viewers ─────────────────────────────────────────────────────────
    } else if (subcommand === 'viewers') {
      if (isDM) { await reply('❌ Run `/ed viewers` inside a channel.'); return; }
      const [action, ...rest] = args.split(/\s+/);
      const vKey = viewersKey(command.user_id, command.channel_id);

      if (action === 'add') {
        const ids = rest.join(' ').match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g);
        if (!ids?.length) { await reply('❌ Usage: `/ed viewers add @alice @bob`'); return; }
        const parsed = ids.map(m => m.match(/<@([A-Z0-9]+)/)[1]);
        await viewersAdd(command.user_id, command.channel_id, parsed);
        const names = parsed.map(id => `<@${id}>`).join(', ');
        await reply(`✅ Added ${names} as translation viewer(s) in this channel.\nThey will privately see your outgoing translations here.`);

      } else if (action === 'remove') {
        const match = rest.join(' ').match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);
        if (!match) { await reply('❌ Usage: `/ed viewers remove @alice`'); return; }
        await viewersRemove(command.user_id, command.channel_id, match[1]);
        await reply(`✅ Removed <@${match[1]}> from your viewers in this channel.`);

      } else if (action === 'list') {
        const ids = await viewersList(command.user_id, command.channel_id);
        if (!ids.length) { await reply('No viewers set for this channel.'); return; }
        await reply(`👥 *Your translation viewers in this channel:*\n${ids.map(id => `• <@${id}>`).join('\n')}`);

      } else if (action === 'clear') {
        await viewersClear(command.user_id, command.channel_id);
        await reply('✅ Cleared all viewers for this channel.');

      } else {
        await reply('Usage:\n• `/ed viewers add @alice @bob`\n• `/ed viewers remove @alice`\n• `/ed viewers list`\n• `/ed viewers clear`');
      }

    } else if (subcommand === 'newbie') {
      await reply(
        `👋 *Welcome to the ED Translator Bot!*\n\nHere's how to get started:\n\n` +
        `*1. Authorize yourself (required)*\n` +
        `Run \`/ed login\` and follow the link in your DMs. This lets your messages appear as *you* — not as the bot app. This is important when communicating with clients and partners.\n\n` +
        `*2. Subscribe to translations*\n` +
        `Run \`/ed join\` — you'll start receiving private translations for new messages in monitored channels.\n\n` +
        `*3. Set your language*\n` +
        `Run \`/ed lang Vietnamese\` (or any language) to receive translations in your preferred language.\n\n` +
        `*4. Monitor a channel*\n` +
        `In the channel you want to watch, run \`/ed watch\`. Every new message there will be privately translated for subscribers.\n\n` +
        `*5. Send translated messages*\n` +
        `Use \`/ed send [your message]\` to translate and post your message in this channel.\n` +
        `Or right-click any message → *More message shortcuts* → *Translate & Reply* to reply in thread.\n\n` +
        `*6. Let teammates see your translations*\n` +
        `Run \`/ed viewers add @alice @bob\` so they privately see what you send (translated) in this channel.\n\n` +
        `Run \`/ed\` anytime to see all available commands.\n\n` +
        `📖 *Full setup guide:* <https://ownego.slack.com/docs/T024TKZ7R/F0BDWRBA8LR|View the Slack canvas>`
      );

    } else if (!subcommand) {
      await reply(USAGE);

    } else {
      await reply(`❌ Unknown command \`${subcommand}\`.\n\n${USAGE}`);
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

    // Get sender name for context
    let senderLabel = '';
    if (message.user) {
      const senderInfo = await client.users.info({ user: message.user });
      const name = senderInfo.user?.profile?.display_name || senderInfo.user?.profile?.real_name;
      if (name) senderLabel = ` — *${name}*`;
    }

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: threadTs,
      text: `🌐 *Translation${senderLabel}* (only you see this):\n${translated}`,
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

    const sent = await postAsUser(client, body.user.id, {
      channel: channelId,
      thread_ts: threadTs,
      text: plainFallback,
      username: displayName,
      icon_url: avatarUrl,
      blocks: [{ type: 'rich_text', elements: translatedRichText.elements }],
    });

    // Ephemeral in the thread of the sent message — only visible to sender
    const originalPlain = richTextToPlain(richTextValue);
    const sentTs = sent?.ts || sent?.message?.ts;
    logger.info(`[modal send] sent.ts=${sentTs}`, sent);
    await client.chat.postEphemeral({
      channel: channelId,
      user: body.user.id,
      thread_ts: sentTs || threadTs,
      username: displayName,
      icon_url: avatarUrl,
      text: `✅ *Sent (→ ${targetCode})* — only you see this\n*Original:* ${originalPlain}`,
    });

    // Notify viewers — post in the thread of the sent message
    await notifyViewers(client, {
      senderId: body.user.id,
      channelId,
      threadTs: sentTs || threadTs,
      senderName: displayName,
      originalText: originalPlain,
      translatedBlocks: translatedRichText.elements,
      targetLabel: targetCode,
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
