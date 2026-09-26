---
name: radio
description: Start, stop or check Conduct Radio — lo-fi in your browser that levels up as Claude works.
argument-hint: "[start | stop | status]"
disable-model-invocation: true
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/server/radio-ctl.mjs" $ARGUMENTS --data "${CLAUDE_PLUGIN_DATA}"`

Pass the line above on to the user in one short sentence. Don't run anything else.
