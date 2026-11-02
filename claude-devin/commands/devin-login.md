---
description: Log in to Devin (PKCE browser flow; pass --manual to paste a code instead)
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/cli.mjs:*)
---

Run the Devin PKCE login flow and show the result to the user.

!`node ${CLAUDE_PLUGIN_ROOT}/cli.mjs login $ARGUMENTS`

If the login output reports an error, tell the user to retry with `/devin:login --manual`.
