# AGY for Claude (agy-bridge)

[English](README.md) | 繁體中文

讓 Claude Code 把 **Antigravity CLI（`agy`）** 當成子代理使用的 Claude Code mod。Claude 可以把任務
交給同一台機器上的 agy 執行，過程即時顯示在 Claude Code 的側邊 pane 裡。只要 Claude Code 和 agy
裝在同一台機器就能用：macOS、Windows、Linux 都行。沒有伺服器、沒有網路、沒有 token，插件直接啟動
`agy`。

```
Claude ──工具 mcp__agy-bridge__run──▶ 插件 ──spawn──▶ agy --output-format stream-json ... -p "<prompt>"
                                       ▲                          │
                          pane「Antigravity」◀── NDJSON 逐行 ◀────┘
```

## 插件提供給 Claude 的東西

| 項目 | 名稱 | 說明 |
| --- | --- | --- |
| 工具 | `mcp__agy-bridge__run` | 執行一次 agy 任務，參數見下表 |
| 指令 | `/agy` | `/agy` 開啟 pane 並檢查 agy 能不能跑；`/agy <prompt>` 直接執行 agy；`/agy cancel` 中止目前的任務 |
| Pane | `Antigravity` | agy 狀態、目前的任務（狀態、計時、目錄、對話、模式、推理強度、token 用量）、工具呼叫列表、即時輸出、以 Markdown 呈現的最終回答、取消按鈕、歷史紀錄 |
| 系統提示 | `agy-bridge:delegate` | 一小段文字，告訴 Claude 什麼時候該把任務交給 agy、怎麼交 |

### 工具參數

| 參數 | 對應 agy 旗標 | 意義 |
| --- | --- | --- |
| `prompt`（必填） | `-p` | 任務內容，寫成完整的指示 |
| `cwd` | 工作目錄 | 預設用 `default_cwd` 選項，沒設就用目前 session 的目錄 |
| `continue_conversation` | `--conversation <上次的 id>` | 接續這個 session 上一次 agy 的對話 |
| `conversation` | `--conversation` | 指定要接續的對話 id |
| `model` | `--model` | 模型代號；空值用 `model` 選項，再沒有就用 agy 預設 |
| `effort` | `--effort` | `low`、`medium`、`high`、`xhigh`、`max`；空值用 `effort` 選項 |
| `mode` | `--mode` | `plan`：只規劃、不改任何東西。`accept-edits`：可以改檔案但不能跑指令。空值：完整權限 |
| `agent` | `--agent` | agy 裡定義的 agent（`agy agents` 可列出）；空值用 `agent` 選項 |
| `project` | `--project` | agy 專案 id 或名稱 |
| `add_dirs` | `--add-dir`（可多個） | 除了 `cwd` 之外，額外讓 agy 讀寫的目錄 |
| `json_schema` | `--json-schema` | JSON schema 文字或 schema 檔路徑，最終回答必須符合 |
| `sandbox` | `--sandbox` | 在有終端限制的沙箱中執行；空值用 `sandbox` 選項 |
| `timeout_minutes` | `--print-timeout` | 預設 10 分鐘，最多 60 |

Claude 讀到的工具結果是一行標頭（`agy done in Ns | conversation <id> | mode plan | tools: ... | N tokens`），
接著是 agy 的最終回答，或是一段 `ERROR:` 區塊。一次只能跑一個 agy 任務；執行中再呼叫一次，會收到提示
訊息而不會再開一個。

## 一次執行的流程

每次工具呼叫會啟動一條固定的指令：

```
agy --output-format stream-json --dangerously-skip-permissions
    [--model X] [--effort E] [--mode M] [--agent A] [--project P] [--add-dir D]... [--sandbox]
    [--json-schema S] [--conversation ID] --print-timeout <N>m -p "<prompt>"
```

stdin 一開始就關閉（否則 agy 會等待輸入）。stdout 一邊輸出一邊讀，切成完整的 NDJSON 行；插件看得懂
agy 的 `init`、`step_update`（`text_delta`、`tool_info`、`subagent_info`、`usage`）和 `result` 事件，
格式見 https://antigravity.google/docs/cli/headless/ 。離開讀取迴圈（pane 的取消按鈕、`/agy cancel`、
中斷回合、mod 被卸載）都會殺掉 agy 程序。

## 安裝

1. 安裝 agy，並且互動式登入一次（直接執行 `agy`），這樣無頭模式才找得到登入憑證。
2. 載入 mod（見下方）。session 開始時插件會尋找 agy，結果顯示在 Antigravity pane 頂端；`/agy` 可以重新檢查。
3. 選項都是選填。放在 `~/.claude/settings.json` 的 `pluginConfigs.agy-bridge.options`，
   或是 mod 載入後在 `/config` 裡改：

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

   | 選項 | 意義 |
   | --- | --- |
   | `agy_path` | agy 的指令名稱或完整路徑。通常不用設，見「尋找 agy」 |
   | `default_cwd` | 工具呼叫沒給目錄時 agy 執行的目錄；空值代表 session 目錄 |
   | `model` | 預設的 `--model` |
   | `effort` | 預設的 `--effort` |
   | `agent` | 預設的 `--agent` |
   | `sandbox` | 預設是否加 `--sandbox` |

### 尋找 agy

插件先試 `agy_path`（預設 `agy`，用 Claude Code 繼承到的 PATH 找）。macOS 的桌面版 app 啟動時 PATH
常常很精簡，所以找不到時會改用完整路徑試常見的安裝位置：`~/.agy/bin/agy`、`~/.local/bin/agy`、
`~/bin/agy`、`/opt/homebrew/bin/agy`、`/usr/local/bin/agy`，Windows 則是
`%LOCALAPPDATA%\agy\bin\agy.exe`。pane 頂端會顯示實際用的是哪一個。如果 agy 裝在別的地方，把完整路徑
填到 `agy_path`。

### 載入 mod

- 終端機：`claude --plugin-dir <這個資料夾>`
- 桌面版 app：把資料夾加到 `~/.claude/settings.json` 的 `env` 區塊裡的 `CLAUDE_CODE_PLUGIN_DIRS`，例如：

  ```json
  { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/Users/me/AGYforClaude" } }
  ```

  多個資料夾在 macOS 和 Linux 用 `:` 分隔，Windows 用 `;`。開新 session 就會載入；沒有的話重啟 app。

## 怎麼用

- **讓 Claude 自己派工**：直接用自然語言說，例如「這個 bug 交給 agy 修」、「叫 Antigravity 幫我寫測試」、
  「請 agy 給第二意見」。Claude 會呼叫工具，等 agy 做完再把結果摘要給你。
- **自己下指令**：`/agy 把 README 翻成英文`。
- **接續上一次**：跟 Claude 說「請 agy 接著剛才的繼續改」，Claude 會帶 `continue_conversation`。
- **只要規劃不要動手**：請 Claude 用 `mode: plan`。
- **中止**：按 pane 裡的「Cancel run」，或輸入 `/agy cancel`。

注意：agy 是以 `--dangerously-skip-permissions` 執行的，會直接改檔案、跑指令，不會再問你。需要限制時用
`mode` 或 `sandbox`。

## 開發

```
claude plugin validate <這個資料夾>
claude plugin test <這個資料夾>
```

測試會模擬插件底下的引擎，用預先準備好的 stream-json 片段回應 `process.spawn`，所以不需要安裝 agy 就能跑。

## 檔案配置

```
.claude-plugin/plugin.json   manifest 與使用者選項
hooks/hooks.json             指向 hooks 模組
hooks/register.tsx           工具、指令、pane、系統提示段落、agy 路徑偵測、執行迴圈
tsconfig.json                延伸引擎在 mod 載入後寫在旁邊的型別設定
types/index.d.ts             $.state 的型別契約（runs、lastConversation、health）
tests/run.test.ts            插件測試
```
