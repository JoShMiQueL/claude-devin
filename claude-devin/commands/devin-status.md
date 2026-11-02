---
description: Show claude-devin proxy + credential status
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/cli.mjs:*)
---

Report the status of the local Devin→Anthropic proxy and the stored Devin credential.

!`node ${CLAUDE_PLUGIN_ROOT}/cli.mjs status`

If it reports missing credentials or a down proxy, tell the user to run `/devin:login`.
