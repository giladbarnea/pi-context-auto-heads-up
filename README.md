<div align="center">

# pi-context-auto-heads-up

> Keep the agent aware of its remaining context window.

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi)
[![npm version](https://img.shields.io/npm/v/%40giladbarnea%2Fpi-context-auto-heads-up?logo=npm)](https://www.npmjs.com/package/@giladbarnea/pi-context-auto-heads-up)
[![tests](https://img.shields.io/github/actions/workflow/status/giladbarnea/pi-context-auto-heads-up/test.yml?branch=main&label=tests&logo=github)](https://github.com/giladbarnea/pi-context-auto-heads-up/actions/workflows/test.yml)
[![license](https://img.shields.io/github/license/giladbarnea/pi-context-auto-heads-up)](LICENSE)

</div>

Long coding sessions can run out of context before the work is done. This Pi extension gives the agent one hidden heads-up when usage crosses 50%, 75%, or 90%.

The agent gets the guidance inside its model context. The user sees only a small notification that names the crossed threshold.

## Install

```sh
pi install npm:@giladbarnea/pi-context-auto-heads-up
```

Run `/reload` in an existing Pi session after installation.

## What each heads-up does

| Usage | Guidance |
| --- | --- |
| 50% | Compare progress with remaining context. Consider delegating noisy read-only work. |
| 75% | Inform the user when substantial work remains. Delegate more implementation work. |
| 90% | Warn the user and other agents. Write a handoff when unattended. Move direct work to fresh agents. |

The wording is intentionally opinionated. It treats delegation and handoffs as context-management tools, not as automatic responses to every large task.

## Behavior

- Each threshold fires once per upward crossing.
- A jump across several thresholds emits only the highest crossed threshold.
- Compaction clears pending delivery. A later measured decrease can rearm thresholds; warnings already written are not retracted.
- Mid-run heads-ups are appended persistently after the completed assistant/tool turn. The next natural model call sees them; no extra response is forced.
- A crossing on a final answer is recorded in the session at once, keeping the answer as the last message (so `pi -p` still prints it). The next prompt delivers the heads-up, including after the process exits and the session resumes, unless compaction happens first.
- Delivery appends new context without rewriting earlier prompt or tool messages. A heads-up remains in history instead of disappearing after one request.
- Resuming a session starts from its current percentage. The extension does not emit retrospective heads-ups.

## Timing and compaction

A heads-up records the crossing when the turn finishes, **before** Pi's next automatic-compaction decision. Compaction may retain an earlier warning, so treat it as a historical crossing—not a guarantee of current usage. The extension does not retroactively remove delivered warnings or invent a percentage while Pi reports usage as unknown.

Persistent delivery avoids a subtle failure of temporary `context`-hook messages: returning a changed conversation list can fold historical system/tool declarations into a new leading prompt and break preserved-thinking or cache prefixes. See [issue #2](https://github.com/giladbarnea/pi-context-auto-heads-up/issues/2) for the general failure category, official Pi references and controlled evidence.

## Development

```sh
npm ci
./setup.sh
npm run check
npm pack --dry-run
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for the release process and manual test flow.
