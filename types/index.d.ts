export type AgyStep = {
  index: number
  type: string
  state: 'ACTIVE' | 'DONE' | string
  tool?: string
  summary?: string
  error?: string
}

export type AgyUsage = {
  input: number
  output: number
  thinking: number
  total: number
}

export type AgyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AgyMode = 'plan' | 'accept-edits'

/** How one agy run was launched: everything that became a command-line flag. */
export type AgyLaunch = {
  /** The `--model` slug given; empty means agy's default. */
  model: string
  effort: AgyEffort | ''
  mode: AgyMode | ''
  agent: string
  project: string
  addDirs: string[]
  sandbox: boolean
  /** True when a `--json-schema` was given. */
  structured: boolean
}

export type AgyRun = AgyLaunch & {
  job: string
  /** The agy sign-in the run used: `main` (the real HOME) or a profile folder's name. */
  account: string
  prompt: string
  /** The time limit the run was given, in minutes. */
  limitMinutes?: number
  /** Working directory agy ran in; empty means the session's own. */
  cwd: string
  conversation: string | null
  status: 'starting' | 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number
  endedAt?: number
  /** What agy is doing right now, while it runs. */
  phase?: string
  /** Tool and subagent steps only; agy's own text goes to `text`. */
  steps: AgyStep[]
  text: string
  response?: string
  error?: string
  usage?: AgyUsage
  durationSeconds?: number
  numTurns?: number
  /** What the run would have cost on Claude, in US dollars (an estimate from its token usage). */
  savedUsd?: number
  /** The background agy's process id (its own process group): set once a detached launch started it. */
  pid?: number
  /** Folder holding the background run's `out` (stream-json), `err` and `code` (exit status) files. */
  logDir?: string
  /** True once the Claude Code turn that started the run was interrupted and agy carried on alone. */
  detached?: boolean
  /** True when the run hit its time limit (agy's --print-timeout, or the plugin's own) before it finished. */
  timedOut?: boolean
  /** What agy had got to when it ended without an answer: its last notes, read from its transcript. */
  partial?: string
  /** How a plan run was kept read-only: by the agy hook, or only by asking in the prompt (no perl). */
  readOnly?: 'hook' | 'prompt'
  /** Seconds the model took over its finished turns, and how many, to tell a slow sign-in. */
  modelSeconds?: number
  modelTurns?: number
}

export type AgyHealth = {
  ok: boolean
  message: string
  /** The executable the plugin settled on, when agy was found. */
  path?: string
  checkedAt: number
}

/** One quota pool of a sign-in, as `agy -p /usage` prints it: the lower of its weekly and five-hour limits. */
export type AgyPoolQuota = {
  /** Percent left; -1 when it could not be read. */
  left: number
  /** When the lower window resets, as agy prints it (ISO time). */
  resetAt?: string
}

export type AgyAccountQuota = {
  name: string
  /** Gemini models. */
  gemini: AgyPoolQuota
  /** Claude and GPT models, a pool of their own. */
  other: AgyPoolQuota
}

/** How runs pick a sign-in among those with quota left. */
export type AgyRotation = 'ordered' | 'round-robin' | 'random' | 'most-left'

/** What the pane's pickers set; kept in the plugin's store, over the plugin options. */
export type AgySettings = {
  model: string
  effort: AgyEffort | ''
  rotation: AgyRotation
  /** The pane's language: `auto` follows LANG. */
  language: 'auto' | 'en' | 'zh-TW'
}

export type AgyModel = { value: string; label: string }

export type AgyQuota = {
  accounts: AgyAccountQuota[]
  checkedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'agy4claude': {
      runs: AgyRun[]
      lastConversation: string | null
      health: AgyHealth | null
      quota: AgyQuota | null
      models: AgyModel[]
      /** Bumped on the plugin's clock so the stage animates. */
      frame: number
      settingsOpen: boolean
      /** Whether the activity list is unfolded; folded, it is one line. */
      activityOpen: boolean
      /** Runs whose long reply (or long prompt, keyed `ask:<job>`) is shown whole. */
      expanded: string[]
    }
  }
}
