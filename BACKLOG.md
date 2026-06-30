# Backlog

## 🔴 `/ed recap` not working on mobile

**Problem:** The recap command returns no visible response on mobile Slack, despite working on desktop.

**What's been tried:**
- Switched from `chat.postEphemeral` to Bolt's `respond()` (uses `response_url`) — still not working
- Hypothesis was timing: recap is slow (history fetch + name lookups + translations), ephemeral gets dropped by the time it's sent

**Next steps to investigate:**
- Check server logs to confirm the command is actually reaching the bot and completing without error
- Try responding with a plain `respond({ text })` first (no translation, no API calls) to isolate whether the issue is delivery or processing
- Consider sending the result as a direct `chat.postMessage` to the user's DM instead of an ephemeral — this is persistent and cross-device, which fits the use case anyway
- Check if the bot has the correct OAuth scopes on mobile (`chat:write`, `channels:history`, `groups:history`, `im:history`)

---

## 🟡 `/ed send` should open a modal

**Problem:** `/ed send [message]` requires the user to type their message inline in the command box, which is limiting (no rich text, no formatting, easy to mistype).

**Desired behaviour:** Running `/ed send` (with or without text) should open a modal identical to the "Translate & Reply" modal used in thread shortcuts — with a rich text input and an optional target language field. On submit, it posts the translated message to the current channel (same as the current `/ed send` behaviour).

**Implementation notes:**
- Slash commands receive a `trigger_id` in the payload — use `client.views.open({ trigger_id, view: ... })` to open the modal
- Reuse or extend `translateReplyModalView(channelId, threadTs)` — need a variant that targets the channel root (no thread) for non-thread sends
- The modal submit handler (`translate_reply_modal`) already handles posting; may need a separate `callback_id` (e.g. `send_modal`) to distinguish channel-post vs thread-reply behaviour, or pass context via `private_metadata`
- If `/ed send` is called with inline text already (e.g. `/ed send Hello`), decide whether to: (a) ignore the inline text and always open modal, or (b) pre-populate the modal input with the inline text
