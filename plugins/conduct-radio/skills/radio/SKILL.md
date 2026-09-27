---
name: radio
description: Start, stop or check Conduct Radio — lo-fi in your browser that levels up as Claude works — or save the last turn as a tape.
argument-hint: "[start | stop | status | tape [title]]"
disable-model-invocation: true
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/server/radio-ctl.mjs" $ARGUMENTS --data "${CLAUDE_PLUGIN_DATA}" --session "${CLAUDE_SESSION_ID}"`

Pass the line above on to the user in one short sentence. Don't run anything else.
