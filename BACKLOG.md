# Backlog

## ✅ `/ed recap` not working on mobile — fixed

**Root cause:** Switching to Bolt's `respond()` didn't actually fix anything — ephemeral responses sent via `response_url` use the exact same client-session delivery as `chat.postEphemeral`. Both are only ever delivered to whichever client is "active" at the moment Slack pushes them, so a stale/backgrounded mobile session can miss them entirely.

**Fix:** `/ed recap` now always delivers its result via a persistent DM (`chat.postMessage` to the user), not an ephemeral. DMs are stored and sync across every device, which is exactly what recap needs. If the command was run in a channel, a short ephemeral note points the user to their DMs.

---

## ✅ `/ed send` opens a modal — done

`/ed send` now opens the same rich-text modal used by the "Translate & Reply" thread shortcut (`translateReplyModalView`), instead of requiring the message to be typed inline in the command box. Opened via `client.views.open({ trigger_id: command.trigger_id, ... })`.

- Run inside a thread → modal title reads "Translate & Reply" and the reply goes to that thread (via `command.thread_ts`)
- Run at the top level of a channel or DM → modal title reads "Translate & Send" and posts to the channel root
- The optional language field in the modal replaces the old `/ed send [language]` "set default" shortcut and the `lang:` prefix override — both are removed since the modal covers the same need per-send
- The per-channel `CHANNEL_LANGUAGES` env fallback is preserved and now lives in the shared modal-submit handler, used by both `/ed send` and the thread reply shortcut

**Trade-off to be aware of:** the previous `/ed send [language]` command that set a *persistent* default outgoing language for a user+channel is gone — there's no replacement for "always default to X without picking it each time." If that's missed, worth adding back as a separate `/ed lang-out [language]` command.
