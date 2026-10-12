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

export type AgyRun = {
  job: string
  prompt: string
  /** Working directory agy ran in; empty means the session's own. */
  cwd: string
  /** The `--model` slug given; empty means agy's default. */
  model: string
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

export type AgyHealth = { ok: boolean; message: string; checkedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'agy-bridge': {
      runs: AgyRun[]
      lastConversation: string | null
      health: AgyHealth | null
    }
  }
}
