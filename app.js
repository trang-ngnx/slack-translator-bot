require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const https = require('https');
const http = require('http');
const Redis = require('ioredis');
const nlp = require('compromise');

// ── Config ─────────────────────────────────────────────────────────────────
const CHANNEL_LANGUAGES = JSON.parse(process.env.CHANNEL_LANGUAGES || '{}');
const DEFAULT_OUTGOING_LANG = process.env.OUTGOING_LANGUAGE || 'English';
const CANVAS_URL = process.env.CANVAS_URL || '';

// ── Redis persistent store ─────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL);

const KEYS = {
  subscribers:            'subscribers',
  monitoredChannels:      'monitored_channels',
  userIncomingLang:       'user_incoming_lang',
  userTokens:             'user_tokens',   // hash: userId → user OAuth token
  channelOutgoingLang:    'channel_outgoing_lang', // hash: channelId → language code
};

// Per-user per-channel translation viewers (Redis set per key)
function viewersKey(userId, channelId) { return `viewers:${userId}:${channelId}`; }
async function viewersAdd(userId, channelId, viewerIds)  { await redis.sadd(viewersKey(userId, channelId), ...viewerIds); }
async function viewersRemove(userId, channelId, viewerId){ await redis.srem(viewersKey(userId, channelId), viewerId); }
async function viewersList(userId, channelId)            { return redis.smembers(viewersKey(userId, channelId)); }
async function viewersClear(userId, channelId)           { await redis.del(viewersKey(userId, channelId)); }

// Per-user muted channels — separate from the global monitoredChannels set.
// Watching a channel (via auto-watch or /ed watch) is a workspace-wide setting;
// muting is a personal "don't send me translations from this one" preference
// that doesn't affect any other subscriber.
function mutedChannelsKey(userId)                     { return `muted_channels:${userId}`; }
async function isChannelMutedForUser(userId, channelId) { return (await redis.sismember(mutedChannelsKey(userId), channelId)) === 1; }
async function muteChannelForUser(userId, channelId)    { await redis.sadd(mutedChannelsKey(userId), channelId); }
async function unmuteChannelForUser(userId, channelId)  { await redis.srem(mutedChannelsKey(userId), channelId); }

// Send ephemeral notifications to all viewers of a translation in a channel
async function notifyViewers(client, { senderId, channelId, threadTs, senderName, senderAvatarUrl, originalText, translatedBlocks, targetLabel }) {
  const ids = await viewersList(senderId, channelId);
  if (!ids.length) return;
  for (const viewerId of ids) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: viewerId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      // Show as the sender, not the bot's app identity — easier to recognize who sent it
      username: senderName,
      icon_url: senderAvatarUrl,
      text: `👁 *[${senderName} → ${targetLabel}]* ${originalText}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `👁 Sent a translated message (→ ${targetLabel}):\n*Original:* ${originalText}` } },
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
}

// One-time migration/seed: CHANNEL_LANGUAGES env var → Redis, so existing
// config isn't lost. Only fills in channels not already set in Redis — once
// someone picks a language from the Home tab, that value is the source of
// truth and this won't overwrite it on the next restart.
async function seedChannelLanguagesFromEnv() {
  for (const [channelId, lang] of Object.entries(CHANNEL_LANGUAGES)) {
    const existing = await hashGet(KEYS.channelOutgoingLang, channelId);
    if (!existing) await hashSet(KEYS.channelOutgoingLang, channelId, getLangCode(lang));
  }
}

// ── User token helpers ─────────────────────────────────────────────────────
async function getUserToken(userId) {
  return hashGet(KEYS.userTokens, userId);
}

// Encode userId in state directly — avoids Redis timing issues
function buildOAuthUrl(userId) {
  const nonce = Math.random().toString(36).slice(2);
  const state = Buffer.from(`${userId}:${nonce}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const redirectUri = encodeURIComponent(process.env.SLACK_OAUTH_REDIRECT_URI);
  return `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&user_scope=chat:write&redirect_uri=${redirectUri}&state=${state}`;
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

// The bot's own Slack user ID (distinct from bot_id) — used to tell "the bot itself
// joined a channel" apart from any other member joining. Cached, never changes.
let ownUserId = null;
async function getOwnUserId(client) {
  if (ownUserId) return ownUserId;
  const auth = await client.auth.test();
  ownUserId = auth.user_id;
  return ownUserId;
}

// Auto-watch every public/private channel the bot is currently a member of —
// run once at startup so channels the bot was already added to before this
// feature shipped get picked up too, not just new invites going forward.
async function syncWatchedChannelsFromMembership(client) {
  let cursor;
  let addedCount = 0;
  do {
    const result = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const channel of result.channels || []) {
      if (channel.is_member && !(await setHas(KEYS.monitoredChannels, channel.id))) {
        await setAdd(KEYS.monitoredChannels, channel.id);
        addedCount++;
      }
    }
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return addedCount;
}

// Subtypes that are never real conversation content — channel/membership
// housekeeping and edit/delete markers. Deliberately NOT excluding by bot_id:
// a shared channel can have real human content relayed through all sorts of
// bots — this app's own translated replies (posted via postAsUser's fallback,
// which Slack tags with subtype "bot_message"), but also messages from other
// companies' own bot/app integrations in a cross-org channel. There's no way
// to allowlist every legitimate bot in advance, so any message with real text
// is treated as recap-worthy regardless of which app posted it.
const NON_CONVERSATIONAL_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'group_join', 'group_leave',
  'channel_topic', 'channel_purpose', 'channel_name',
  'channel_archive', 'channel_unarchive',
  'pinned_item', 'unpinned_item',
  'message_changed', 'message_deleted',
]);

function isRecapWorthy(m) {
  return (!m.subtype || !NON_CONVERSATIONAL_SUBTYPES.has(m.subtype)) && !!m.text?.trim();
}

// Temporary diagnostic for tracking down why some real, persisted messages
// aren't surviving recap's filter — logs exactly what each raw message looked
// like and whether/why it was kept, so a failure is visible in Railway logs
// instead of requiring another guess-and-check round.
function logRecapFilter(logger, label, rawMessages) {
  const summary = rawMessages.map(m => ({
    ts: m.ts,
    user: m.user || null,
    username: m.username || null,
    bot_id: m.bot_id || null,
    subtype: m.subtype || null,
    hasText: !!m.text?.trim(),
    textPreview: m.text ? m.text.slice(0, 40) : null,
    kept: isRecapWorthy(m),
  }));
  logger.info(`[recap:${label}] fetched=${rawMessages.length} ${JSON.stringify(summary)}`);
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

    // Refresh their Home tab so it reflects "Authorized" without a manual reload
    await publishHomeView(app.client, userId, console);

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

// Recognized language names/codes (e.g. "Japanese" or "ja") — used to tell whether
// the first word of an inline command is a language prefix or just the message itself.
const KNOWN_LANG_TOKENS = new Set([...Object.keys(LANG_CODES), ...Object.values(LANG_CODES)]);

// Google's language detector tags Chinese with a region suffix (e.g. "zh-CN"/"zh-TW")
// that never equals our bare "zh" from LANG_CODES, so a detected-vs-preferred-language
// equality check would always report "different" for Chinese even when they match.
// Only used for comparing a *detected* code against one of ours — not for codes sent
// to Google as a translation target, where region-suffixed forms are valid as-is.
function normalizeDetectedLang(code) {
  return code ? code.split('-')[0] : code;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Brand names, product names, or person names that must never be translated —
// configured via PROTECTED_TERMS (comma-separated, case-insensitive, e.g. "YourBrand,ClientName").
const PROTECTED_TERMS = (process.env.PROTECTED_TERMS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const PROTECT_PATTERNS = [
  /```[\s\S]*?```/g,
  /`[^`]+`/g,
  /<(?:[@#!]|https?:\/\/)[^>]*>/g,  // Slack entities: <@U...>, <#C...>, <http...>, <!...>
  /:[a-z0-9_+\-']+:/g,
  ...(PROTECTED_TERMS.length
    ? [new RegExp(`\\b(?:${PROTECTED_TERMS.map(escapeRegex).join('|')})\\b`, 'gi')]
    : []),
];

// Auto-detect brand/person names via POS tagging rather than a naive
// "capitalized word" check — compromise resolves the sentence-initial
// ambiguity (e.g. "Welcome"/"Congratulations"/"Thanks" are recognized as
// common words, not names, even capitalized at position zero) using its own
// lexicon + context rules, which a hand-rolled stopword list can't cover.
function detectProperNouns(text) {
  // Match single #ProperNoun tokens rather than a greedy "+" chunk: compromise
  // also tags "I" (as in "I'm") with #ProperNoun since it's always capitalized,
  // and a "+" span would merge it into an adjacent real name (e.g. "I'm Sylvia"
  // collapsing into one protected block, leaving "I'm" untranslated). Excluding
  // #Pronoun filters that out; matching term-by-term instead of chunked still
  // protects every word of a multi-word name, just as separate placeholders.
  const terms = nlp(text).match('#ProperNoun').not('#Pronoun').out('array');
  return terms
    .map(t => t.replace(/^[^\w]+|[^\w]+$/g, ''))  // strip stray leading/trailing punctuation
    .filter(Boolean);
}

function protect(text) {
  const stash = [];
  let result = text;
  for (const pattern of PROTECT_PATTERNS) {
    result = result.replace(pattern, (match) => {
      stash.push(match);
      return `<!--z${stash.length - 1}-->`;  // HTML comments are never touched by Google Translate
    });
  }
  // Run proper-noun detection only after Slack entities (@mentions, #channels,
  // code, emoji) and PROTECTED_TERMS are already masked out above — this keeps
  // Slack's native @user/#channel mention/tagging behavior completely untouched;
  // the tagger never even sees that raw syntax, just an opaque placeholder.
  for (const term of detectProperNouns(result)) {
    const re = new RegExp(`\\b${escapeRegex(term)}\\b`, 'g');
    result = result.replace(re, (match) => {
      stash.push(match);
      return `<!--z${stash.length - 1}-->`;
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

// Best-effort extraction of a forwarded message's quoted content. Slack's
// "Forward message" feature renders the quoted original as a message-share
// attachment (is_msg_unfurl, or a channel_id+ts pair identifying the source
// message) rather than in event.text — so a forward with no added comment
// would otherwise look like an empty message and get silently skipped.
// NOT verified against a real forward payload from this workspace — built
// from Slack's general attachment-based share/unfurl shape. If it doesn't
// match, the [msg] diagnostic log (blocks/attachments dump) will show the
// actual shape to fix this against.
function extractForwardedContent(event) {
  if (!event.attachments?.length) return null;
  for (const att of event.attachments) {
    const looksLikeForward = att.is_msg_unfurl === true || (att.channel_id && att.ts);
    if (!looksLikeForward) continue;

    let text = (att.text || att.fallback || '').trim();
    if (!text && Array.isArray(att.message_blocks)) {
      const allBlocks = att.message_blocks.flatMap(mb => mb.message?.blocks || mb.blocks || []);
      text = allBlocks.filter(b => b.type === 'rich_text').map(b => richTextToPlain(b)).join('\n').trim();
    }
    if (text) {
      return { text, authorName: att.author_name || null };
    }
  }
  return null;
}

// ── Shared modal definition ────────────────────────────────────────────────
function translateReplyModalView(channelId, threadTs) {
  return {
    type: 'modal',
    callback_id: 'translate_reply_modal',
    private_metadata: JSON.stringify({ channelId, threadTs }),
    title: { type: 'plain_text', text: threadTs ? 'Translate & Reply' : 'Translate & Send' },
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

function translateTransModalView() {
  return {
    type: 'modal',
    callback_id: 'translate_trans_modal',
    title: { type: 'plain_text', text: 'Translate' },
    submit: { type: 'plain_text', text: 'Translate' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'text_block',
        label: { type: 'plain_text', text: 'Message or Slack link' },
        element: {
          type: 'plain_text_input',
          action_id: 'text_input',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'Paste text, or a Slack message link…' },
        },
      },
      {
        type: 'input',
        block_id: 'lang_block',
        label: { type: 'plain_text', text: 'Target language (optional)' },
        hint: { type: 'plain_text', text: 'e.g. en, ja, vi — leave blank to use your /ed lang setting' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'lang_input',
          placeholder: { type: 'plain_text', text: 'en' },
        },
      },
    ],
  };
}

function translateTransResultView({ original, translated, targetCode }) {
  return {
    type: 'modal',
    callback_id: 'translate_trans_result',
    title: { type: 'plain_text', text: 'Translation' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*Original:*\n${original}` } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*Translation (→ ${targetCode}):*\n${translated}` } },
    ],
  };
}

// ── App Home: settings tab (join / language / watched channels / viewers) ──
function langDisplayName(code) {
  const entry = Object.entries(LANG_CODES).find(([, c]) => c === code);
  const name = entry ? entry[0] : code;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// multi_users_select only works inside an `input` block, which only modals
// support — Home tab views reject it outright ("unsupported element:
// multiselect"). So adding/removing viewers has to go through a modal; the
// Home tab's "Clear all" button is the one bulk action that can stay inline
// since a plain button has no such restriction.
function viewersModalView(channelId, currentViewerIds) {
  const element = {
    type: 'multi_users_select',
    action_id: 'viewers_input',
    placeholder: { type: 'plain_text', text: 'Select teammates' },
  };
  if (currentViewerIds.length) element.initial_users = currentViewerIds;

  return {
    type: 'modal',
    callback_id: 'home_viewers_modal',
    private_metadata: JSON.stringify({ channelId }),
    title: { type: 'plain_text', text: 'Manage Viewers' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `Choose who can privately see your translations in <#${channelId}>.` } },
      {
        type: 'input',
        block_id: 'viewers_block',
        optional: true,
        label: { type: 'plain_text', text: 'Viewers' },
        element,
      },
    ],
  };
}

// Channels the given user belongs to that are also currently watched —
// shared by both the Watched Channels and Viewers sections below.
async function getMyWatchedChannels(client, userId) {
  const watchedChannels = await setAll(KEYS.monitoredChannels);
  try {
    const result = await client.users.conversations({
      user: userId,
      types: 'public_channel,private_channel',
      limit: 200,
    });
    return (result.channels || []).filter(c => watchedChannels.has(c.id));
  } catch (_) {
    return [];
  }
}

async function buildHomeView(client, userId) {
  const isAuthorized = !!(await getUserToken(userId));
  const isSubscribed = await setHas(KEYS.subscribers, userId);
  const currentLangCode = getLangCode(await hashGet(KEYS.userIncomingLang, userId) || 'en');
  const knownCode = Object.values(LANG_CODES).includes(currentLangCode);
  const myChannels = await getMyWatchedChannels(client, userId);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '⚙️ Ed Translator Settings', emoji: true } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: isAuthorized
        ? '🔑 *Authorized* — your messages send as you, with no "App" badge.'
        : '🔑 *Not authorized* — messages currently send via the bot with your name and avatar.' },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: isAuthorized ? 'Log out' : 'Authorize', emoji: true },
        style: isAuthorized ? 'danger' : 'primary',
        action_id: 'home_toggle_login',
        value: isAuthorized ? 'logout' : 'login',
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: isSubscribed
        ? '✅ *You\'re subscribed* — you receive private translations in watched channels.'
        : 'You\'re *not subscribed* to auto-translations yet.' },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: isSubscribed ? 'Unsubscribe' : 'Subscribe', emoji: true },
        style: isSubscribed ? 'danger' : 'primary',
        action_id: 'home_toggle_subscribe',
        value: isSubscribed ? 'leave' : 'join',
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Translate incoming messages into:*' },
      accessory: {
        type: 'static_select',
        action_id: 'home_set_lang',
        ...(knownCode ? { initial_option: {
          text: { type: 'plain_text', text: langDisplayName(currentLangCode) },
          value: currentLangCode,
        } } : {}),
        options: Object.entries(LANG_CODES).map(([name, code]) => ({
          text: { type: 'plain_text', text: name.charAt(0).toUpperCase() + name.slice(1) },
          value: code,
        })),
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text:
        '*How to use Ed:*\n' +
        '• *Receive translations* — subscribe above and join a watched channel; new messages there are privately translated for you.\n' +
        '• *Send translated messages* — run `/ed send` (opens a modal) to write in your own language and post it translated into a channel. For a quick private translation without posting, use `/ed trans`.' },
    },
    ...(CANVAS_URL ? [{
      type: 'section',
      text: { type: 'mrkdwn', text: '📖 Want the full walkthrough?' },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Open Canvas', emoji: true },
        url: CANVAS_URL,
        action_id: 'home_open_canvas',
      },
    }] : []),
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: '📡 Watched Channels', emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Channels are watched automatically as soon as the bot is added — no setup needed. "Mute for me" stops translations from a channel for you personally without affecting other subscribers. The outgoing language applies to everyone using `/ed send` here.' }] },
  ];

  if (!myChannels.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No watched channels you\'re a member of yet. Channels are watched automatically once the bot is added to them — or ask an admin to run `/ed watch`._' },
    });
  } else {
    for (const channel of myChannels) {
      const muted = await isChannelMutedForUser(userId, channel.id);
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${muted ? '🔕' : '🔔'} <#${channel.id}>${muted ? ' _(muted for you)_' : ''}` },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: muted ? 'Unmute for me' : 'Mute for me' },
          action_id: 'home_toggle_mute',
          value: `${muted ? 'unmute' : 'mute'}:${channel.id}`,
        },
      });

      // Outgoing language for /ed send in this channel — shared across everyone
      // who sends there, same as /ed watch itself. Stored in Redis so picking
      // one here takes effect immediately, no redeploy required.
      const channelLangCode = getLangCode(
        (await hashGet(KEYS.channelOutgoingLang, channel.id)) || CHANNEL_LANGUAGES[channel.id] || DEFAULT_OUTGOING_LANG
      );
      const channelKnownCode = Object.values(LANG_CODES).includes(channelLangCode);
      blocks.push({
        type: 'section',
        block_id: `channel_lang:${channel.id}`,
        text: { type: 'mrkdwn', text: `Outgoing language for \`/ed send\` here:` },
        accessory: {
          type: 'static_select',
          action_id: 'home_set_channel_lang',
          ...(channelKnownCode ? { initial_option: {
            text: { type: 'plain_text', text: langDisplayName(channelLangCode) },
            value: channelLangCode,
          } } : {}),
          options: Object.entries(LANG_CODES).map(([name, code]) => ({
            text: { type: 'plain_text', text: name.charAt(0).toUpperCase() + name.slice(1) },
            value: code,
          })),
        },
      });
    }
  }

  blocks.push(
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: '👥 Viewers', emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Let specific colleagues privately see the translated messages you send in a channel with `/ed send` — everyone else only sees your original message.' }] },
  );

  if (!myChannels.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_Viewers let colleagues privately see the translations you send in a channel. Once you\'re in a watched channel, it\'ll show up here._' },
    });
  } else {
    for (const channel of myChannels) {
      const currentViewers = await viewersList(userId, channel.id);
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: currentViewers.length
          ? `*<#${channel.id}>* — ${currentViewers.map(id => `<@${id}>`).join(', ')}`
          : `*<#${channel.id}>* — _no viewers set_` },
      });
      const actionElements = [{
        type: 'button',
        text: { type: 'plain_text', text: 'Manage viewers' },
        action_id: 'home_manage_viewers',
        value: channel.id,
      }];
      if (currentViewers.length) {
        actionElements.push({
          type: 'button',
          text: { type: 'plain_text', text: 'Clear all' },
          style: 'danger',
          action_id: 'home_viewers_clear',
          value: channel.id,
        });
      }
      blocks.push({ type: 'actions', block_id: `viewers_actions:${channel.id}`, elements: actionElements });
    }
  }

  return { type: 'home', blocks };
}

async function publishHomeView(client, userId, logger) {
  try {
    const view = await buildHomeView(client, userId);
    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    logger.error('Error publishing home view:', err);
  }
}

// ── Incoming: auto-translate messages in monitored channels ────────────────
app.event('message', async ({ event, client, logger }) => {
  try {
    logger.info(`[msg] channel=${event.channel} user=${event.user} subtype=${event.subtype} bot_id=${event.bot_id} thread_ts=${event.thread_ts} textLen=${event.text?.length || 0} hasBlocks=${!!event.blocks?.length} hasAttachments=${!!event.attachments?.length}`);
    // Temporary: forwarded messages render their quoted content as blocks rather
    // than plain text, so event.text may be empty or miss the forwarded content
    // entirely. Logging the raw shape here to confirm before deciding how (or
    // whether) to extract forwarded text for translation.
    if (event.blocks?.length || event.attachments?.length) {
      logger.info(`[msg] blocks/attachments=${JSON.stringify({ blocks: event.blocks, attachments: event.attachments }).slice(0, 800)}`);
    }

    // ── Forwarded message → visible, in-thread translation for the whole channel ──
    // Checked before the subtype/bot_id skip below, since it's unconfirmed whether
    // Slack tags forwards with a subtype. Handled as its own exclusive path — a
    // detected forward never also goes through the per-subscriber ephemeral flow.
    if (!event.bot_id) {
      const forwarded = extractForwardedContent(event);
      if (forwarded) {
        try {
          const isWatched = await setHas(KEYS.monitoredChannels, event.channel);
          if (isWatched) {
            const channelLangCode = getLangCode(
              (await hashGet(KEYS.channelOutgoingLang, event.channel)) || CHANNEL_LANGUAGES[event.channel] || DEFAULT_OUTGOING_LANG
            );

            let detectedLang = null;
            try {
              const detectJson = await googleTranslateRaw(forwarded.text.slice(0, 200), 'en');
              detectedLang = normalizeDetectedLang(detectJson[2]) || null;
            } catch (_) {}

            if (!detectedLang || detectedLang !== channelLangCode) {
              // If the forward itself is a reply within an existing thread,
              // post into that same thread rather than starting a new one
              // anchored on the reply — matches how the rest of the bot
              // threads its replies (event.thread_ts || event.ts).
              const replyThreadTs = event.thread_ts || event.ts;
              const translated = await translate(forwarded.text, channelLangCode);
              const authorLabel = forwarded.authorName ? ` from *${forwarded.authorName}*` : '';
              await client.chat.postMessage({
                channel: event.channel,
                thread_ts: replyThreadTs,
                text: `🌐 *Forwarded message${authorLabel} (→ ${channelLangCode}):*\n${translated}`,
              });
              logger.info(`[forward] translated and posted in thread ${replyThreadTs} of ${event.channel}`);
            } else {
              logger.info('[forward] skipped: already in channel outgoing language');
            }
          } else {
            logger.info('[forward] skipped: channel not watched');
          }
        } catch (err) {
          logger.error('Error translating forwarded message:', err);
        }
        return;
      }
    }

    if (event.subtype || event.bot_id) { logger.info('[msg] skipped: subtype/bot'); return; }
    if (!event.text?.trim()) { logger.info('[msg] skipped: no text'); return; }

    const isMonitoredChannel = await setHas(KEYS.monitoredChannels, event.channel);

    logger.info(`[msg] isMonitoredChannel=${isMonitoredChannel}`);
    if (!isMonitoredChannel) return;

    const allSubscribers = await setAll(KEYS.subscribers);
    const isThreadReply = !!event.thread_ts && event.thread_ts !== event.ts;
    const threadTs = event.thread_ts || event.ts;
    const ctx = JSON.stringify({ channelId: event.channel, threadTs, messageTs: event.ts });

    // Detect source language once (used to skip messages already in user's target language)
    let detectedLang = null;
    try {
      const detectJson = await googleTranslateRaw(event.text.slice(0, 200), 'en');
      detectedLang = normalizeDetectedLang(detectJson[2]) || null;
    } catch (_) {}

    // Fetch sender's display name once for all subscribers
    const senderInfo = await client.users.info({ user: event.user });
    const senderName = senderInfo.user?.profile?.display_name || senderInfo.user?.profile?.real_name || 'Someone';

    for (const userId of allSubscribers) {
      if (userId === event.user) continue;

      // Isolated per-subscriber: subscribing is global, not scoped to specific
      // channels, so a subscriber who isn't actually a member of this channel
      // is expected (postEphemeral will just fail for them). Without this,
      // one such failure would throw out of the loop and silently skip every
      // other, legitimate subscriber for this message too.
      try {
        // Personal opt-out — the channel stays watched for everyone else
        if (await isChannelMutedForUser(userId, event.channel)) continue;

        const targetLang = await hashGet(KEYS.userIncomingLang, userId) || 'en';
        const targetCode = getLangCode(targetLang);

        // Skip if message is already in the user's target language
        if (detectedLang && detectedLang === targetCode) continue;

        const translated = await translate(event.text, targetLang);
        const actionButtons = [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✏️ Reply with translation', emoji: true },
            style: 'primary',
            action_id: 'thread_open_reply_modal',
            value: ctx,
          },
        ];
        await client.chat.postEphemeral({
          channel: event.channel,
          user: userId,
          ...(isThreadReply ? { thread_ts: threadTs } : {}),
          text: `🌐 *[${senderName}]* ${translated}`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `🌐 *[${senderName}]* ${translated}` },
            },
            { type: 'actions', elements: actionButtons },
          ],
        });
      } catch (err) {
        logger.error(`Error notifying subscriber ${userId}:`, err);
      }
    }
  } catch (err) {
    logger.error('Error translating incoming message:', err);
  }
});

// ── Auto-watch: monitor a channel automatically when the bot is added to it ──
app.event('member_joined_channel', async ({ event, client, logger }) => {
  try {
    const myUserId = await getOwnUserId(client);
    if (event.user !== myUserId) return; // only care about the bot itself joining
    await setAdd(KEYS.monitoredChannels, event.channel);
    logger.info(`[auto-watch] bot added to ${event.channel} — now monitored`);
  } catch (err) {
    logger.error('Error in member_joined_channel handler:', err);
  }
});

// ── /ed — single entry point for all commands ─────────────────────────────
app.command('/ed', async ({ command, ack, client, logger }) => {
  await ack();

  const USAGE = 'Available commands:\n• `/ed join` — subscribe to auto-translations\n• `/ed leave` — unsubscribe\n• `/ed lang [language]` — set your preferred incoming translation language\n• `/ed watch` — monitor this channel (also happens automatically when the bot is added to a channel)\n• `/ed unwatch` — stop monitoring this channel\n• `/ed send` — open a modal to compose, translate, and post a message (replies in-thread if run inside a thread)\n• `/ed send [language] [link or text]` — skip the modal and post directly\n• `/ed trans` — translate privately (opens an input modal in DMs; shows usage in channels)\n• `/ed trans [link or text]` — translate privately (defaults to your `/ed lang` setting) — result pops up as a modal in DMs, or an ephemeral reply in channels/threads\n• `/ed trans [language] [link or text]` — same, but override with a specific language\n• `/ed recap [N]` — DM you the last N translated messages here (default 10; works in DMs, channels, and threads)\n• `/ed recap [message link]` — DM you the full translated thread for a specific message (paste a Slack message link)\n• `/ed viewers add @user1 @user2` — let colleagues privately see your translations here\n• `/ed viewers remove @user1` | `list` | `clear`\n• `/ed login` — authorize so your messages send without the "App" badge\n• `/ed logout` — remove your authorization';

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
      const authUrl = buildOAuthUrl(command.user_id);

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

    } else if (subcommand === 'send') {
      if (!args) {
        await client.views.open({
          trigger_id: command.trigger_id,
          view: translateReplyModalView(command.channel_id, command.thread_ts),
        });
        return;
      }

      // Inline "[language] [link or text]" — skip the modal and post directly.
      const [langToken, ...rest] = args.split(/\s+/);
      let messageText = rest.join(' ').trim();
      if (!messageText) {
        await reply('❌ Usage: `/ed send [language] [link or text]` — e.g. `/ed send ja Hello!` or `/ed send vi [Slack message link]`');
        return;
      }

      const targetCode = getLangCode(langToken);

      const linkMatch = messageText.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
      if (linkMatch) {
        const linkedChannelId = linkMatch[1];
        const ts = `${linkMatch[2]}.${linkMatch[3]}`;
        let linkedMessage;
        try {
          const linkResult = await client.conversations.history({ channel: linkedChannelId, latest: ts, inclusive: true, limit: 1 });
          linkedMessage = linkResult.messages?.[0];
        } catch (_) {
          linkedMessage = null;
        }
        if (!linkedMessage?.text) {
          await reply('❌ Could not fetch that message. Make sure the bot is invited to that channel.');
          return;
        }
        messageText = linkedMessage.text;
      }

      const translated = await translate(messageText, targetCode);

      const profileRes = await client.users.info({ user: command.user_id });
      const profile = profileRes.user?.profile;
      const displayName = profile?.display_name || profile?.real_name || 'Unknown';
      const avatarUrl = profile?.image_72;

      const sent = await postAsUser(client, command.user_id, {
        channel: command.channel_id,
        text: translated,
        username: displayName,
        icon_url: avatarUrl,
        ...(command.thread_ts ? { thread_ts: command.thread_ts } : {}),
      });

      // Confirmation with the original text — only visible to the sender.
      // DMs get a persistent DM instead of an ephemeral (unreliable in DMs,
      // same fix already applied for recap/trans); channels keep the ephemeral
      // reply anchored to the thread of the sent message.
      const sentTs = sent?.ts || sent?.message?.ts;
      if (isDM) {
        await client.chat.postMessage({
          channel: command.user_id,
          text: `✅ *Sent (→ ${targetCode})* — only you see this\n*Original:* ${messageText}`,
        });
      } else {
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          thread_ts: sentTs,
          username: displayName,
          icon_url: avatarUrl,
          text: `✅ *Sent (→ ${targetCode})* — only you see this\n*Original:* ${messageText}`,
        });
      }

      await notifyViewers(client, {
        senderId: command.user_id,
        channelId: command.channel_id,
        threadTs: sentTs,
        senderName: displayName,
        senderAvatarUrl: avatarUrl,
        originalText: messageText,
        translatedBlocks: [{ type: 'rich_text_section', elements: [{ type: 'text', text: translated }] }],
        targetLabel: targetCode,
      });

    } else if (subcommand === 'trans') {
      // Modal is DM-only (that's where ephemeral delivery is unreliable); in a
      // channel — top-level or inside a thread — keep the original ephemeral reply.
      if (!args) {
        if (isDM) {
          await client.views.open({
            trigger_id: command.trigger_id,
            view: translateTransModalView(),
          });
        } else {
          await reply('❌ Usage:\n• `/ed trans [Slack message link]` — translate a message by link\n• `/ed trans [any text]` — translate text directly\n• `/ed trans [language] [link or text]` — translate to a specific language');
        }
        return;
      }

      // Inline "[language] [link or text]" or plain "[link or text]" (→ your /ed lang
      // preference). A leading word only counts as a language override if it's a
      // recognized name/code — otherwise it's ambiguous with the first word of an
      // ordinary message.
      const [firstToken, ...transRest] = args.split(/\s+/);
      let targetLabel = await hashGet(KEYS.userIncomingLang, command.user_id) || 'en';
      let textToTranslate = args;
      if (transRest.length && KNOWN_LANG_TOKENS.has(firstToken.toLowerCase())) {
        targetLabel = firstToken;
        textToTranslate = transRest.join(' ').trim();
      }

      const match = textToTranslate.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
      if (match) {
        const channelId = match[1];
        const ts = `${match[2]}.${match[3]}`;
        let message;
        try {
          const result = await client.conversations.history({ channel: channelId, latest: ts, inclusive: true, limit: 1 });
          message = result.messages?.[0];
        } catch (_) {
          message = null;
        }
        if (!message?.text) {
          await reply('❌ Could not fetch that message. Make sure the bot is invited to that channel.\n\nTip: for DM messages, copy the text directly and use `/ed trans [paste text]` instead.');
          return;
        }
        textToTranslate = message.text;
      }

      const targetCode = getLangCode(targetLabel);
      const translated = await translate(textToTranslate, targetLabel);

      if (isDM) {
        await client.views.open({
          trigger_id: command.trigger_id,
          view: translateTransResultView({ original: textToTranslate, translated, targetCode }),
        });
      } else {
        // Ephemeral in the thread if run from inside one, otherwise a plain
        // channel ephemeral — matches the original pre-modal /ed trans behavior.
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          ...(command.thread_ts ? { thread_ts: command.thread_ts } : {}),
          text: `🌐 *Translation (→ ${targetCode})* — only you see this:\n*Original:* ${textToTranslate}\n${translated}`,
        });
      }

    // ── ed recap ───────────────────────────────────────────────────────────
    } else if (subcommand === 'recap') {
      // Ephemeral (postEphemeral / respond via response_url) delivery is tied to
      // whichever client session is active when Slack delivers it — it does not
      // sync across devices. A DM is persistent and reachable from any device,
      // which is the whole point of recap, so results — including failures — are
      // always sent via DM instead of the generic reply() helper (which falls
      // back to an ephemeral in channel context, the exact delivery this command
      // exists to avoid).
      const sendRecapResult = (text) => client.chat.postMessage({ channel: command.user_id, text });

      try {
      const targetLang = await hashGet(KEYS.userIncomingLang, command.user_id) || 'en';
      const targetCode = getLangCode(targetLang);

      let rawMessages = [];
      let contextLabel = '';
      let originalLink = null;

      // Detect a Slack message link anywhere in args.
      // Parent link:  .../archives/CHANNEL/p0123456789012345
      // Reply link:   .../archives/CHANNEL/p0123456789012345?thread_ts=0123456789.012345&cid=...
      const linkMatch = args.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);

      if (linkMatch) {
        const targetChannelId = linkMatch[1];
        const messageTs = `${linkMatch[2]}.${linkMatch[3]}`;
        originalLink = args.split(/\s+/).find(w => w.startsWith('http') || w.includes('/archives/')) || null;

        // thread_ts query param (present on reply links) points straight at the root.
        // Without it, messageTs itself works just as well: conversations.replies
        // accepts the ts of any message in a thread (parent or reply) and returns
        // the whole thread either way — no need to pre-resolve the root ourselves.
        const threadTsParam = args.match(/[?&]thread_ts=([\d.]+)/)?.[1];
        const threadTs = threadTsParam || messageTs;

        // Count may be passed alongside the link: "/ed recap [link] 15"
        const argsWithoutLink = args.split(/\s+/).filter(w => !w.startsWith('http') && !w.includes('/archives/')).join(' ');
        const count = Math.min(Math.max(parseInt(argsWithoutLink) || 20, 1), 20);

        try {
          const result = await client.conversations.replies({
            channel: targetChannelId,
            ts: threadTs,
            limit: count + 15,
          });
          logRecapFilter(logger, 'linked thread', result.messages || []);
          rawMessages = (result.messages || [])
            .filter(m => isRecapWorthy(m))
            .slice(-count);
          contextLabel = 'linked thread';
        } catch (err) {
          await sendRecapResult('❌ Could not fetch that thread. Make sure the bot is in that channel.\n\nTip: if you linked to a thread reply, try sharing the parent message link instead.');
          return;
        }
      } else if (command.thread_ts) {
        const count = Math.min(Math.max(parseInt(args) || 10, 1), 20);
        const result = await client.conversations.replies({
          channel: command.channel_id,
          ts: command.thread_ts,
          limit: count + 15,
        });
        logRecapFilter(logger, 'thread', result.messages || []);
        rawMessages = (result.messages || [])
          .filter(m => isRecapWorthy(m))
          .slice(-count);
        contextLabel = 'thread';
      } else {
        const count = Math.min(Math.max(parseInt(args) || 10, 1), 20);
        const result = await client.conversations.history({
          channel: command.channel_id,
          limit: count + 15,
        });
        logRecapFilter(logger, 'channel/DM', result.messages || []);
        rawMessages = (result.messages || [])
          .filter(m => isRecapWorthy(m))
          .slice(0, count)
          .reverse();
        contextLabel = isDM ? 'DM' : 'channel';
      }

      if (!rawMessages.length) {
        await sendRecapResult('❌ No messages found.');
        return;
      }

      // Cache user display names to avoid duplicate API calls
      const nameCache = {};
      const resolveDisplayName = async (userId) => {
        if (nameCache[userId]) return nameCache[userId];
        try {
          const info = await client.users.info({ user: userId });
          const name = info.user?.profile?.display_name || info.user?.profile?.real_name || 'Unknown';
          nameCache[userId] = name;
          return name;
        } catch (_) {
          nameCache[userId] = 'Unknown';
          return 'Unknown';
        }
      };

      // Translate all messages concurrently rather than one at a time — sequential
      // Google Translate round-trips (up to 2 per message: detect + translate) for
      // a full recap could add up to several seconds, which on a slow connection
      // can look indistinguishable from the command having silently failed.
      const lines = await Promise.all(rawMessages.map(async (msg) => {
        const senderName = msg.user ? await resolveDisplayName(msg.user) : (msg.username || 'Unknown');
        const timeStr = new Date(parseFloat(msg.ts) * 1000)
          .toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        let translatedText = msg.text;
        try {
          const detectJson = await googleTranslateRaw(msg.text.slice(0, 200), targetCode);
          const detectedLang = normalizeDetectedLang(detectJson[2]);
          if (detectedLang && detectedLang !== targetCode) {
            translatedText = await translate(msg.text, targetLang);
          }
        } catch (_) {}

        return translatedText !== msg.text
          ? `*${senderName}* (${timeStr}):\n_${msg.text}_\n→ ${translatedText}`
          : `*${senderName}* (${timeStr}):\n${msg.text}`;
      }));

      const linkLine = originalLink ? `\n${originalLink}` : '';
      await sendRecapResult(`📋 *Last ${lines.length} messages in this ${contextLabel} (→ ${targetCode}):*${linkLine}\n\n${lines.join('\n\n─────\n')}`);
      if (!isDM) {
        await reply('📨 Sent the recap to your DMs with me — check there so it\'s available on any device.');
      }
      } catch (err) {
        logger.error('Error in /ed recap:', err);
        await sendRecapResult(`❌ Something went wrong generating your recap: ${err.message}`);
      }

    // ── ed viewers ─────────────────────────────────────────────────────────
    } else if (subcommand === 'viewers') {
      if (isDM) { await reply('❌ Run `/ed viewers` inside a channel.'); return; }
      const [action, ...rest] = args.split(/\s+/);
      const vKey = viewersKey(command.user_id, command.channel_id);

      if (action === 'add') {
        const ids = rest.join(' ').match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g);
        if (!ids?.length) { await reply('❌ Usage: `/ed viewers add @user1 @user2`'); return; }
        const parsed = ids.map(m => m.match(/<@([A-Z0-9]+)/)[1]);
        await viewersAdd(command.user_id, command.channel_id, parsed);
        const names = parsed.map(id => `<@${id}>`).join(', ');
        await reply(`✅ Added ${names} as translation viewer(s) in this channel.\nThey will privately see your outgoing translations here.`);

      } else if (action === 'remove') {
        const match = rest.join(' ').match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);
        if (!match) { await reply('❌ Usage: `/ed viewers remove @user1`'); return; }
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
        await reply('Usage:\n• `/ed viewers add @user1 @user2`\n• `/ed viewers remove @user1`\n• `/ed viewers list`\n• `/ed viewers clear`');
      }

    } else if (subcommand === 'newbie') {
      await reply(
        `👋 *Welcome to the ED Translator Bot!*\n\nHere's how to get started:\n\n` +
        `*1. Open your settings*\n` +
        `Click the bot's name → *Home* tab for a visual settings screen. From there:\n` +
        `• *Authorize* yourself — lets your messages appear as *you*, not the bot app. Important when talking with clients and partners.\n` +
        `• *Subscribe* to auto-translations — you'll start receiving private translations automatically, no further action needed.\n` +
        `• *Set your language* — pick what language incoming translations should be delivered in.\n\n` +
        `*2. Monitor a channel*\n` +
        `Channels are watched automatically as soon as the bot is added to them — no extra step needed. Prefer manual control? Run \`/ed watch\`/\`/ed unwatch\`, or use the *Watched Channels* section in your Home tab (also lets you mute a channel for just yourself).\n\n` +
        `*3. Send translated messages*\n` +
        `Run \`/ed send\` to open a modal — write your message, pick a language (optional), and post it translated to this channel.\n` +
        `Or right-click any message → *More message shortcuts* → *Translate & Reply* to reply in thread the same way.\n` +
        `💡 *Tip:* \`/ed send\` and \`/ed trans\` also work directly inside a 1:1 DM with a colleague, not just channels — handy for translating a private conversation between just the two of you.\n\n` +
        `*4. Let teammates see your translations*\n` +
        `Run \`/ed viewers add @user1 @user2\`, or manage viewers directly from the *Viewers* section in your Home tab.\n\n` +
        `*5. Catch up on missed translations*\n` +
        `Run \`/ed recap\` to get your last several messages here, translated, sent straight to your DMs — works in channels, threads, and DMs alike. Paste a specific Slack message link (\`/ed recap [link]\`) to recap that exact thread instead, from anywhere.\n\n` +
        `Run \`/ed\` anytime to see all available commands.` +
        (CANVAS_URL ? `\n\n📖 *Full setup guide:* <${CANVAS_URL}|View the Slack canvas>` : '')
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
    // Ephemeral delivery is unreliable specifically in DM threads, so DMs get a
    // modal (works via trigger_id regardless of context); channels keep the
    // original ephemeral-in-thread reply.
    const isDM = channelId?.startsWith('D');

    if (!messageText?.trim()) {
      if (isDM) {
        await client.views.open({
          trigger_id: shortcut.trigger_id,
          view: {
            type: 'modal',
            title: { type: 'plain_text', text: 'Translation' },
            close: { type: 'plain_text', text: 'Close' },
            blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '❌ This message has no text to translate.' } }],
          },
        });
      } else {
        await client.chat.postEphemeral({ channel: channelId, user: userId, text: '❌ This message has no text to translate.' });
      }
      return;
    }

    const targetLang = await hashGet(KEYS.userIncomingLang, userId) || 'en';
    const targetCode = getLangCode(targetLang);
    const translated = await translate(messageText, targetLang);

    if (isDM) {
      await client.views.open({
        trigger_id: shortcut.trigger_id,
        view: translateTransResultView({ original: messageText, translated, targetCode }),
      });
    } else {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        text: `🌐 *Translation (only you see this):*\n${translated}`,
      });
    }
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
    if (!targetCode) targetCode = await hashGet(KEYS.channelOutgoingLang, channelId);
    if (!targetCode) targetCode = getLangCode(CHANNEL_LANGUAGES[channelId] || DEFAULT_OUTGOING_LANG);

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

    // Confirmation with the original text — only visible to the sender.
    // Ephemeral delivery is unreliable in DMs (same issue fixed elsewhere for
    // recap/trans), so DMs get a persistent DM from the bot instead; channels
    // keep the ephemeral reply anchored to the thread of the sent message.
    const originalPlain = richTextToPlain(richTextValue);
    const sentTs = sent?.ts || sent?.message?.ts;
    logger.info(`[modal send] sent.ts=${sentTs}`, sent);
    if (channelId.startsWith('D')) {
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ *Sent (→ ${targetCode})* — only you see this\n*Original:* ${originalPlain}`,
      });
    } else {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        thread_ts: sentTs || threadTs,
        username: displayName,
        icon_url: avatarUrl,
        text: `✅ *Sent (→ ${targetCode})* — only you see this\n*Original:* ${originalPlain}`,
      });
    }

    // Notify viewers — post in the thread of the sent message
    await notifyViewers(client, {
      senderId: body.user.id,
      channelId,
      threadTs: sentTs || threadTs,
      senderName: displayName,
      senderAvatarUrl: avatarUrl,
      originalText: originalPlain,
      translatedBlocks: translatedRichText.elements,
      targetLabel: targetCode,
    });
  } catch (err) {
    logger.error('Error in translate_reply_modal submit:', err);
  }
});

// ── Modal submit: translate & show result in-place ─────────────────────────
app.view('translate_trans_modal', async ({ view, ack, client, body, logger }) => {
  try {
    const textInput = view.state.values.text_block.text_input.value?.trim();
    const langInput = view.state.values.lang_block.lang_input.value?.trim();

    if (!textInput) {
      await ack({ response_action: 'errors', errors: { text_block: 'Please enter a message or Slack link.' } });
      return;
    }

    let textToTranslate = textInput;
    const match = textInput.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
    if (match) {
      const channelId = match[1];
      const ts = `${match[2]}.${match[3]}`;
      let message;
      try {
        const result = await client.conversations.history({ channel: channelId, latest: ts, inclusive: true, limit: 1 });
        message = result.messages?.[0];
      } catch (_) {
        message = null;
      }
      if (!message?.text) {
        await ack({ response_action: 'errors', errors: { text_block: 'Could not fetch that message. Make sure the bot is invited to that channel.' } });
        return;
      }
      textToTranslate = message.text;
    }

    const targetLabel = langInput || await hashGet(KEYS.userIncomingLang, body.user.id) || 'en';
    const targetCode = getLangCode(targetLabel);
    const translated = await translate(textToTranslate, targetLabel);

    await ack({
      response_action: 'update',
      view: translateTransResultView({ original: textToTranslate, translated, targetCode }),
    });
  } catch (err) {
    logger.error('Error in translate_trans_modal submit:', err);
    await ack({ response_action: 'errors', errors: { text_block: 'Something went wrong translating this. Please try again.' } });
  }
});

// ── App Home tab: publish settings view when opened ─────────────────────────
app.event('app_home_opened', async ({ event, client, logger }) => {
  if (event.tab !== 'home') return;
  await publishHomeView(client, event.user, logger);
});

// ── App Home: authorize/log out toggle ──────────────────────────────────────
app.action('home_toggle_login', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const userId = body.user.id;
    const action = body.actions[0].value;

    if (action === 'logout') {
      await hashDel(KEYS.userTokens, userId);
      await publishHomeView(client, userId, logger);
      return;
    }

    // login: send the OAuth link via DM, same as /ed login — the Home view
    // itself won't flip to "Authorized" until the OAuth callback completes
    const authUrl = buildOAuthUrl(userId);
    await client.chat.postMessage({
      channel: userId,
      text: `🔑 *Authorize the translator to post as you*\n\nClick the link below — it only asks for permission to post messages on your behalf:\n\n<${authUrl}|Click here to authorize>\n\nThis link expires in 10 minutes.`,
    });
  } catch (err) {
    logger.error('Error in home_toggle_login:', err);
  }
});

// ── App Home: subscribe/unsubscribe toggle ──────────────────────────────────
app.action('home_toggle_subscribe', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const userId = body.user.id;
    const action = body.actions[0].value;
    if (action === 'join') await setAdd(KEYS.subscribers, userId);
    else await setRemove(KEYS.subscribers, userId);
    await publishHomeView(client, userId, logger);
  } catch (err) {
    logger.error('Error in home_toggle_subscribe:', err);
  }
});

// ── App Home: incoming-language select ──────────────────────────────────────
app.action('home_set_lang', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const userId = body.user.id;
    const selectedCode = body.actions[0].selected_option.value;
    await hashSet(KEYS.userIncomingLang, userId, selectedCode);
    await publishHomeView(client, userId, logger);
  } catch (err) {
    logger.error('Error in home_set_lang:', err);
  }
});

// ── App Home: mute/unmute a watched channel for yourself ───────────────────
app.action('home_toggle_mute', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const userId = body.user.id;
    const [action, channelId] = body.actions[0].value.split(':');
    if (action === 'mute') await muteChannelForUser(userId, channelId);
    else await unmuteChannelForUser(userId, channelId);
    await publishHomeView(client, userId, logger);
  } catch (err) {
    logger.error('Error in home_toggle_mute:', err);
  }
});

// ── App Home: set a channel's outgoing language for /ed send ───────────────
app.action('home_set_channel_lang', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const userId = body.user.id;
    const channelId = body.actions[0].block_id.split(':')[1];
    const selectedCode = body.actions[0].selected_option.value;
    await hashSet(KEYS.channelOutgoingLang, channelId, selectedCode);
    await publishHomeView(client, userId, logger);
  } catch (err) {
    logger.error('Error in home_set_channel_lang:', err);
  }
});

// ── App Home: link-out button — no-op, just needs to be acknowledged ───────
app.action('home_open_canvas', async ({ ack }) => { await ack(); });

// ── App Home: "Manage viewers" opens a modal (multi-select requires one) ───
app.action('home_manage_viewers', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const userId = body.user.id;
    const channelId = body.actions[0].value;
    const currentViewers = await viewersList(userId, channelId);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: viewersModalView(channelId, currentViewers),
    });
  } catch (err) {
    logger.error('Error in home_manage_viewers:', err);
  }
});

// ── App Home: viewers modal submit — replaces the full viewer set ──────────
app.view('home_viewers_modal', async ({ ack, view, body, client, logger }) => {
  try {
    const { channelId } = JSON.parse(view.private_metadata);
    const userId = body.user.id;
    const selected = view.state.values.viewers_block.viewers_input.selected_users || [];

    await viewersClear(userId, channelId);
    if (selected.length) await viewersAdd(userId, channelId, selected);

    await ack();
    await publishHomeView(client, userId, logger);
  } catch (err) {
    logger.error('Error in home_viewers_modal submit:', err);
    await ack();
  }
});

// ── App Home: clear all viewers for a channel in one click ─────────────────
app.action('home_viewers_clear', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const userId = body.user.id;
    const channelId = body.actions[0].value;
    await viewersClear(userId, channelId);
    await publishHomeView(client, userId, logger);
  } catch (err) {
    logger.error('Error in home_viewers_clear:', err);
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
(async () => {
  await seedFromEnv();
  await seedChannelLanguagesFromEnv();
  const port = process.env.PORT || 3000;
  await app.start(port);
  const addedCount = await syncWatchedChannelsFromMembership(app.client);
  if (addedCount) console.log(`📡 Auto-watch: picked up ${addedCount} already-joined channel(s)`);
  const channels = await setAll(KEYS.monitoredChannels);
  console.log(`⚡️ Slack Translator Bot is running on port ${port}`);
  console.log(`📡 Monitoring channels: ${[...channels].join(', ') || '(none configured)'}`);
})();
