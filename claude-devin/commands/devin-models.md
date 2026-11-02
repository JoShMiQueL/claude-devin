---
description: List the Devin models available to your account
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/cli.mjs:*)
---

List every model ID the user's Devin subscription exposes via the Cascade catalog.

!`node ${CLAUDE_PLUGIN_ROOT}/cli.mjs models`

Present the list and suggest setting one via `ANTHROPIC_MODEL=<id>` or `/devin:login` if none appear.
