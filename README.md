# AGY for Claude (agy-bridge)

English | [繁體中文](README.zh-TW.md)

A Claude Code mod that lets Claude drive **Antigravity CLI (`agy`)** on the same machine as a
sub-agent, with a live output pane in the Claude Code session. Works wherever Claude Code and agy
are installed together: macOS, Windows, Linux. No server, no network, no token: the plugin
spawns `agy` directly.

```
Claude ──tool mcp__agy-bridge__run──▶ plugin ──spawn──▶ agy --output-format stream-json ... -p "<prompt>"
                                        ▲                          │
                            pane "Antigravity" ◀── NDJSON lines ◀──┘
```

## What the plugin gives Claude

| Piece | Name | Notes |
| --- | --- | --- |
| Tool | `mcp__agy-bridge__run` | Runs one agy task; parameters below |
| Command | `/agy` | `/agy` opens the pane and checks that agy runs; `/agy <prompt>` runs agy; `/agy cancel` stops the current run |
| Pane | `Antigravity` | agy status, the current run (state, clock, directory, conversation, mode, effort, tokens), its tool calls, live output, the final answer as Markdown, a Cancel button, earlier runs |
| System prompt | `agy-bridge:delegate` | A short section telling Claude when and how to delegate to agy |

### Tool parameters

| Parameter | agy flag | Meaning |
| --- | --- | --- |
| `prompt` (required) | `-p` | The task, written as a complete instruction |
| `cwd` | working directory | Defaults to the `default_cwd` option, else the session directory |
| `continue_conversation` | `--conversation <last id>` | Follow up on the previous run from this session |
| `conversation` | `--conversation` | Resume an explicit conversation id |
| `model` | `--model` | Model slug; empty uses the `model` option, else agy's default |
| `effort` | `--effort` | `low`, `medium`, `high`, `xhigh` or `max`; empty uses the `effort` option |
| `mode` | `--mode` | `plan`: agy only plans, changes nothing. `accept-edits`: agy may edit files but not run commands. Empty: full access |
| `agent` | `--agent` | An agent defined in agy (`agy agents`); empty uses the `agent` option |
| `project` | `--project` | agy project id or name |
| `add_dirs` | `--add-dir` (repeated) | Extra directories agy may read and edit besides `cwd` |
| `json_schema` | `--json-schema` | JSON schema text, or a path to a schema file, the final answer must conform to |
| `sandbox` | `--sandbox` | Run with terminal restrictions; empty uses the `sandbox` option |
| `timeout_minutes` | `--print-timeout` | Default 10, at most 60 |

The tool result Claude reads is a one-line header (`agy done in Ns | conversation <id> | mode plan |
tools: ... | N tokens`) followed by agy's final response, or an `ERROR:` block. One agy run at a time;
a second call while one is running is answered with a message instead of starting another.

## How a run works

Each tool call spawns exactly:

```
agy --output-format stream-json --dangerously-skip-permissions
    [--model X] [--effort E] [--mode M] [--agent A] [--project P] [--add-dir D]... [--sandbox]
    [--json-schema S] [--conversation ID] --print-timeout <N>m -p "<prompt>"
```

with stdin closed (agy otherwise waits on it). stdout is read as it arrives and cut into whole
NDJSON lines; the plugin understands agy's `init`, `step_update` (`text_delta`, `tool_info`,
`subagent_info`, `usage`) and `result` events, as documented at
https://antigravity.google/docs/cli/headless/ . Leaving the loop (the pane's Cancel button,
`/agy cancel`, an interrupted turn, the mod unloading) kills the agy process.

## Setup

1. Install agy and sign in once interactively (`agy`), so headless runs find cached credentials.
2. Load the mod (below). At session start it looks for agy and shows the result at the top of the
   Antigravity pane; `/agy` re-checks it.
3. Options are optional. They live in `~/.claude/settings.json` under
   `pluginConfigs.agy-bridge.options`, or in `/config` once the mod is loaded:

   ```json
   {
     "pluginConfigs": {
       "agy-bridge": {
         "options": {
           "agy_path": "agy",
           "default_cwd": "",
           "model": "",
           "effort": "",
           "agent": "",
           "sandbox": false
         }
       }
     }
   }
   ```

   | Option | Meaning |
   | --- | --- |
   | `agy_path` | Command or full path of agy. Usually not needed: see "Finding agy" |
   | `default_cwd` | Directory agy runs in when a tool call gives none; empty means the session directory |
   | `model` | Default `--model` slug |
   | `effort` | Default `--effort` |
   | `agent` | Default `--agent` |
   | `sandbox` | Pass `--sandbox` by default |

### Finding agy

The plugin first tries `agy_path` (default `agy`, on the PATH Claude Code inherited). A desktop app
on macOS often starts with a minimal PATH, so when that fails it tries the usual install locations
by full path: `~/.agy/bin/agy`, `~/.local/bin/agy`, `~/bin/agy`, `/opt/homebrew/bin/agy`,
`/usr/local/bin/agy`, and on Windows `%LOCALAPPDATA%\agy\bin\agy.exe`. The pane header says which
one answered. If agy lives somewhere else, set `agy_path` to its full path.

### Loading the mod

- Terminal: `claude --plugin-dir <this folder>`
- Desktop app: add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
  `~/.claude/settings.json`, for example:

  ```json
  { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/Users/me/AGYforClaude" } }
  ```

  Several folders are separated by `:` on macOS and Linux, `;` on Windows. A new session picks it
  up; restart the app if it does not.

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
hooks/register.tsx           tool, command, pane, system-prompt section, agy lookup, the run loop
tsconfig.json                extends the types the engine writes beside the mod once it has loaded
types/index.d.ts             the $.state contract (runs, lastConversation, health)
tests/run.test.ts            plugin tests
```
