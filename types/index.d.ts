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
  prompt: string
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
}

export type AgyHealth = {
  ok: boolean
  message: string
  /** The executable the plugin settled on, when agy was found. */
  path?: string
  checkedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'agy-bridge': {
      runs: AgyRun[]
      lastConversation: string | null
      health: AgyHealth | null
    }
  }
}
