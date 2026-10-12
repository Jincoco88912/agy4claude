# agy-bridge

A Claude Code mod that lets Claude drive **Antigravity CLI (`agy`)** on the same machine as a
sub-agent, with a live output pane in the Claude Code session. Works wherever Claude Code and agy
are installed together: macOS, Windows, Linux.

```
Claude ──tool mcp__agy-bridge__run──▶ plugin ──spawn──▶ agy --output-format stream-json ... -p "<prompt>"
                                        ▲                          │
                            pane "Antigravity" ◀── NDJSON lines ◀──┘
```

## What the plugin gives Claude

| Piece | Name | Notes |
| --- | --- | --- |
| Tool | `mcp__agy-bridge__run` | `prompt` (required), `cwd`, `continue_conversation`, `conversation`, `model`, `timeout_minutes` |
| Command | `/agy` | `/agy` opens the pane and checks that agy runs; `/agy <prompt>` runs agy; `/agy cancel` stops the current run |
| Pane | `Antigravity` | agy status, the current run (state, clock, directory, conversation, tokens), its tool calls, live output, the final answer as Markdown, a Cancel button, earlier runs |
| System prompt | `agy-bridge:delegate` | A short section telling Claude when and how to delegate to agy |

The tool result Claude reads is `agy done in Ns | conversation <id> | tools: ...` followed by agy's
final response, or an `ERROR:` block. The conversation id of the last run is kept, so
`continue_conversation: true` resumes it with `--conversation`. One agy run at a time; a second
call while one is running is answered with a message instead of starting another.

## How a run works

Each tool call spawns exactly:

```
agy --output-format stream-json --dangerously-skip-permissions [--model X] [--conversation ID] --print-timeout <N>m -p "<prompt>"
```

with stdin closed (agy otherwise waits on it), in the given `cwd`, else the configured
`default_cwd`, else the Claude Code session's own directory. stdout is read as it arrives and cut
into whole NDJSON lines; the plugin understands agy's `init`, `step_update` (`text_delta`,
`tool_info`, `subagent_info`) and `result` events, as documented at
https://antigravity.google/docs/cli/headless/ . Leaving the loop (`/agy cancel`, an interrupted
turn, the mod unloading) kills the agy process.

## Setup

1. Install agy and sign in once interactively (`agy`), so headless runs find cached credentials.
2. Load the mod (see below). On the first session it checks `agy --version` and shows the result
   at the top of the Antigravity pane; `/agy` re-checks it.
3. Options live in `~/.claude/settings.json` under `pluginConfigs.agy-bridge.options`
   (or change them in `/config` once the mod is loaded). All are optional:

   ```json
   {
     "pluginConfigs": {
       "agy-bridge": {
         "options": {
           "agy_path": "agy",
           "default_cwd": "",
           "model": ""
         }
       }
     }
   }
   ```

   | Option | Meaning |
   | --- | --- |
   | `agy_path` | Command or full path of agy. Needed only when `agy` is not on the PATH Claude Code sees, e.g. `/opt/homebrew/bin/agy` or `C:\Users\me\AppData\Local\agy\bin\agy.exe`. |
   | `default_cwd` | Directory agy runs in when a tool call gives none; empty means the session directory. |
   | `model` | agy `--model` slug; empty uses agy's default. |

### Loading the mod

- Terminal: `claude --plugin-dir <this folder>`
- Desktop app: add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
  `~/.claude/settings.json` (several folders are separated by the platform's path-list separator).

## Development

```
claude plugin validate <this folder>
claude plugin test <this folder>
```

The tests stand in for the engine beneath the plugin and answer `process.spawn` with canned
stream-json chunks, so they run without agy installed.

## Layout

```
.claude-plugin/plugin.json   manifest and user options
hooks/hooks.json             names the hooks module
hooks/register.tsx           tool, command, pane, system-prompt section, the agy run loop
tsconfig.json                extends the types the engine writes beside the mod once it has loaded
types/index.d.ts             the $.state contract (runs, lastConversation, health)
tests/run.test.ts            plugin tests
```
