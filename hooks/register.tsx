import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type { AgyEffort, AgyHealth, AgyLaunch, AgyMode, AgyRun, AgyStep, AgyUsage } from '../types'

const PANE = 'agy'
const TOOL = 'run'
const FULL_TOOL = 'mcp__agy-bridge__run'
const MAX_RUNS = 20
const MAX_TEXT = 20_000
const MAX_STDERR = 4_000
const MAX_RESULT_SHOWN = 6_000
const DEFAULT_MINUTES = 10
const EFFORTS: readonly AgyEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const MODES: readonly AgyMode[] = ['plan', 'accept-edits']

// `$.state` refs: plugin and key are literals, as the validator asks.
const RUNS = { plugin: 'agy-bridge', key: 'runs' } as const
const LAST = { plugin: 'agy-bridge', key: 'lastConversation' } as const
const HEALTH = { plugin: 'agy-bridge', key: 'health' } as const

type Options = {
  agy_path: string
  default_cwd: string
  model: string
  effort: AgyEffort | ''
  agent: string
  sandbox: boolean
}

type RunInput = {
  prompt?: string
  cwd?: string
  continue_conversation?: boolean
  conversation?: string
  model?: string
  effort?: string
  mode?: string
  agent?: string
  project?: string
  add_dirs?: unknown
  json_schema?: string
  sandbox?: boolean
  timeout_minutes?: number
}

type RawUsage = { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; total_tokens?: number }

/** One agy `--output-format stream-json` line, as https://antigravity.google/docs/cli/headless/ documents it. */
type StreamEvent = {
  event?: string
  conversation_id?: string
  init?: { cwd?: string; model?: string; tools?: string[] }
  step_update?: {
    conversation_id?: string
    step_index?: number
    state?: string
    step_type?: string
    text_delta?: string
    tool_name?: string
    tool_info?: {
      name?: string
      parameters?: Record<string, unknown>
      output?: string
      error?: { type?: string; message?: string }
    }
    subagent_info?: { subagents?: { type_name?: string; role?: string }[] }
    duration_seconds?: number
    usage?: RawUsage
  }
  result?: {
    conversation_id?: string
    status?: string
    response?: string
    error?: { type?: string; message?: string } | string
    duration_seconds?: number
    num_turns?: number
    usage?: RawUsage
  }
}

type Active = {
  job: string
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  cancelled: boolean
}

const asEffort = (value: unknown): AgyEffort | '' => {
  const text = String(value ?? '').trim().toLowerCase()
  return (EFFORTS as readonly string[]).includes(text) ? (text as AgyEffort) : ''
}

const asMode = (value: unknown): AgyMode | '' => {
  const text = String(value ?? '').trim().toLowerCase().replace('_', '-')
  return (MODES as readonly string[]).includes(text) ? (text as AgyMode) : ''
}

const asBool = (value: unknown): boolean => value === true || String(value ?? '').trim().toLowerCase() === 'true'

const asDirs = (value: unknown): string[] => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' && value.trim() ? value.split(/[\n;]/) : []
  return raw.map(one => String(one ?? '').trim()).filter(Boolean)
}

const readOptions = (options: Record<string, unknown>): Options => ({
  agy_path: String(options.agy_path ?? '').trim() || 'agy',
  default_cwd: String(options.default_cwd ?? '').trim(),
  model: String(options.model ?? '').trim(),
  effort: asEffort(options.effort),
  agent: String(options.agent ?? '').trim(),
  sandbox: asBool(options.sandbox),
})

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const previewParams = (params: Record<string, unknown> | undefined): string => {
  if (!params) return ''
  for (const key of ['CommandLine', 'command', 'Command', 'path', 'file_path', 'AbsolutePath', 'query', 'Query', 'url', 'Url']) {
    const value = params[key]
    if (typeof value === 'string' && value) return oneLine(value, 90)
  }
  const first = Object.values(params).find(v => typeof v === 'string' && v) as string | undefined
  return first ? oneLine(first, 90) : ''
}

const usageOf = (raw: RawUsage | undefined): AgyUsage | undefined =>
  raw
    ? {
        input: raw.input_tokens ?? 0,
        output: raw.output_tokens ?? 0,
        thinking: raw.thinking_tokens ?? 0,
        total: raw.total_tokens ?? (raw.input_tokens ?? 0) + (raw.output_tokens ?? 0),
      }
    : undefined

/** Folds one agy stream-json line into the run. */
const applyEvent = (run: AgyRun, raw: string): AgyRun => {
  let parsed: StreamEvent
  try {
    parsed = JSON.parse(raw) as StreamEvent
  } catch {
    return { ...run, text: `${run.text}${raw}\n`.slice(-MAX_TEXT) }
  }
  if (parsed.event === 'init') {
    return { ...run, status: 'running', phase: 'thinking', conversation: parsed.conversation_id ?? run.conversation }
  }
  if (parsed.event === 'step_update' && parsed.step_update) {
    const s = parsed.step_update
    const next: AgyRun = { ...run, status: 'running' }
    if (s.conversation_id) next.conversation = s.conversation_id
    if (typeof s.text_delta === 'string' && s.text_delta) {
      next.text = `${run.text}${s.text_delta}`.slice(-MAX_TEXT)
    }
    const type = s.step_type ?? 'step'
    const state = s.state ?? 'ACTIVE'
    const isTool = type === 'tool'
    const isSubagent = !isTool && Boolean(s.subagent_info?.subagents?.length)
    if (isTool || isSubagent) {
      const index = s.step_index ?? run.steps.length
      const step: AgyStep = { index, type, state }
      if (isTool) {
        step.tool = s.tool_info?.name ?? s.tool_name ?? 'tool'
        step.summary = previewParams(s.tool_info?.parameters)
        if (s.tool_info?.error?.message) step.error = oneLine(s.tool_info.error.message, 120)
      } else {
        step.tool = 'subagent'
        step.summary = s.subagent_info!.subagents!.map(a => a.type_name ?? a.role ?? '?').join(', ')
      }
      const steps = run.steps.some(one => one.index === index)
        ? run.steps.map(one => (one.index === index ? { ...one, ...step } : one))
        : [...run.steps, step]
      next.steps = steps.slice(-80)
      next.phase = state === 'ACTIVE' ? `running ${step.tool}` : 'thinking'
    } else if (type === 'agent_response') {
      next.phase = state === 'ACTIVE' ? 'writing' : 'thinking'
    }
    return next
  }
  if (parsed.event === 'result' && parsed.result) {
    const r = parsed.result
    const error = typeof r.error === 'string' ? r.error : r.error?.message
    const isOk = (r.status ?? 'SUCCESS') === 'SUCCESS' && !error
    return {
      ...run,
      conversation: r.conversation_id ?? run.conversation,
      status: isOk ? 'done' : 'error',
      phase: undefined,
      response: r.response ?? run.response,
      error: error ?? (isOk ? undefined : `status ${r.status ?? 'unknown'}`),
      usage: usageOf(r.usage) ?? run.usage,
      durationSeconds: r.duration_seconds ?? run.durationSeconds,
      numTurns: r.num_turns ?? run.numTurns,
      endedAt: Date.now(),
    }
  }
  return run
}

let options: Options = readOptions({})
/** The agy executable runs use: the configured one, or the first well-known install location that answers. */
let agyExe = 'agy'
/** The run in flight, if any: one agy at a time, so `/agy cancel` and the pane's button know what to stop. */
let active: Active | null = null
/** Redraws the pane each second while a run is live, so its clock moves. */
let ticker: Timer | null = null

const cancelActive = async (): Promise<string | null> => {
  if (!active) return null
  const stopping = active
  stopping.cancelled = true
  await stopping.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
  return stopping.job
}

/**
 * Where agy tends to live when it is not on the PATH the engine inherited: a desktop app on macOS
 * starts with a minimal PATH, so Homebrew's and agy's own bin folders are tried by full path.
 */
const wellKnownAgyPaths = async ($: EngineInterface): Promise<string[]> => {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const localAppData = await $.env.get('LOCALAPPDATA')
  const unix = home ? [`${home}/.agy/bin/agy`, `${home}/.local/bin/agy`, `${home}/bin/agy`] : []
  const windows = [
    ...(localAppData ? [`${localAppData}\\agy\\bin\\agy.exe`] : []),
    ...(home ? [`${home}\\AppData\\Local\\agy\\bin\\agy.exe`] : []),
  ]
  return [...unix, '/opt/homebrew/bin/agy', '/usr/local/bin/agy', ...windows]
}

const versionOf = async ($: EngineInterface, exe: string): Promise<string> => {
  const ran = await $.process.run([exe, '--version'], { timeoutMs: 15_000 })
  if (ran.exitCode !== 0) throw new Error(oneLine(ran.stderr || ran.stdout || `exit code ${ran.exitCode}`, 200))
  return oneLine(ran.stdout, 40)
}

/** Finds a working agy, remembers it in `agyExe`, and reports it for the pane. */
const checkAgy = async ($: EngineInterface): Promise<AgyHealth> => {
  const tried: string[] = []
  const candidates = [options.agy_path]
  for (const one of await wellKnownAgyPaths($)) if (!candidates.includes(one)) candidates.push(one)
  let firstError = ''
  for (const exe of candidates) {
    if (exe !== options.agy_path) {
      // A missing file is skipped; a file system that cannot be asked (a test kit) leaves the candidate in.
      let present = true
      try {
        present = await $.fs.exists(exe)
      } catch {
        present = true
      }
      if (!present) continue
    }
    tried.push(exe)
    try {
      const version = await versionOf($, exe)
      agyExe = exe
      const where = exe === options.agy_path ? '' : ` at ${exe}`
      return { ok: true, message: `agy ${version || 'found'}${where}`, path: exe, checkedAt: Date.now() }
    } catch (error) {
      if (!firstError) firstError = (error as Error).message ?? String(error)
    }
  }
  agyExe = options.agy_path
  return {
    ok: false,
    message: `agy not available (${options.agy_path}): ${oneLine(firstError || 'not found', 160)}. Set agy_path in the plugin options.`,
    checkedAt: Date.now(),
  }
}

/** The exact agy command a run is. `-p` goes last: it takes the next token as the prompt. */
const argvFor = (p: AgyLaunch & { prompt: string; conversation: string | null; timeout: string; jsonSchema: string }): string[] => [
  agyExe,
  '--output-format', 'stream-json',
  '--dangerously-skip-permissions',
  ...(p.model ? ['--model', p.model] : []),
  ...(p.effort ? ['--effort', p.effort] : []),
  ...(p.mode ? ['--mode', p.mode] : []),
  ...(p.agent ? ['--agent', p.agent] : []),
  ...(p.project ? ['--project', p.project] : []),
  ...p.addDirs.flatMap(dir => ['--add-dir', dir]),
  ...(p.sandbox ? ['--sandbox'] : []),
  ...(p.jsonSchema ? ['--json-schema', p.jsonSchema] : []),
  ...(p.conversation ? ['--conversation', p.conversation] : []),
  '--print-timeout', p.timeout,
  '-p', p.prompt,
]

const replaceRun = (list: AgyRun[], next: AgyRun): AgyRun[] =>
  list.map(one => (one.job === next.job ? next : one))

const launchTags = (run: AgyLaunch): string[] => [
  run.mode ? `mode ${run.mode}` : '',
  run.effort ? `effort ${run.effort}` : '',
  run.agent ? `agent ${run.agent}` : '',
  run.project ? `project ${run.project}` : '',
  run.addDirs.length ? `+${run.addDirs.length} dir${run.addDirs.length === 1 ? '' : 's'}` : '',
  run.sandbox ? 'sandbox' : '',
  run.structured ? 'json-schema' : '',
].filter(Boolean)

const summarize = (run: AgyRun, stderr: string): string => {
  const seconds = Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000)
  const toolsUsed = [...new Set(run.steps.filter(s => s.type === 'tool').map(s => s.tool).filter(Boolean))]
  const header = [
    `agy ${run.status} in ${seconds}s`,
    run.conversation ? `conversation ${run.conversation}` : null,
    ...launchTags(run),
    toolsUsed.length ? `tools: ${toolsUsed.join(', ')}` : null,
    run.usage ? `${run.usage.total} tokens` : null,
  ].filter(Boolean).join(' | ')
  const body = run.response ?? run.text
  const extra = stderr && !(run.error ?? '').includes(stderr.slice(0, 20)) ? `\nstderr: ${oneLine(stderr, 500)}` : ''
  const tail = run.error ? `\n\nERROR: ${run.error}${extra}` : ''
  return `${header}\n\n${body}${tail}`
}

// ---- pane formatting ------------------------------------------------------

const fmtElapsed = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

const fmtAgo = (at: number): string => {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

const shortId = (id: string | null): string => (id ? id.split('-')[0] : '')

const isLive = (run: AgyRun): boolean => run.status === 'running' || run.status === 'starting'

const statusLook = (run: AgyRun): { icon: string; label: string; color: 'claude' | 'success' | 'error' | 'inactive' } => {
  switch (run.status) {
    case 'done': return { icon: '✓', label: 'DONE', color: 'success' }
    case 'error': return { icon: '✗', label: 'ERROR', color: 'error' }
    case 'cancelled': return { icon: '■', label: 'CANCELLED', color: 'inactive' }
    default: return { icon: '●', label: 'RUNNING', color: 'claude' }
  }
}

const DELEGATION_GUIDE =
  '# Antigravity CLI (agy)\n' +
  `Antigravity CLI is installed on this machine and reachable through the tool \`${FULL_TOOL}\`. ` +
  'Treat it as a sub-agent: hand it a self-contained coding task when the user asks to delegate to agy or Antigravity, ' +
  'wants a second implementation or opinion from it, or wants work to proceed in parallel while you continue. ' +
  'Write the prompt as a complete instruction with the paths it needs; it runs with permissions bypassed in the given working directory. ' +
  'Use mode "plan" when only a plan or review is wanted and nothing should change; "accept-edits" when it may edit files but should not run commands. ' +
  'Use json_schema when you will parse its answer. ' +
  'Its final answer comes back as the tool result (live progress is in the Antigravity pane). ' +
  'Pass continue_conversation: true to follow up on its last run. Tell the user what you delegated and summarize what agy did.'

export const register: Register = (on, rawOptions) => {
  options = readOptions(rawOptions as Record<string, unknown>)
  agyExe = options.agy_path

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description:
        'Delegate a coding task to Antigravity CLI (agy) on this machine, like a sub-agent. ' +
        'agy runs with permissions bypassed in the given working directory (the session directory by default) and returns its final answer. ' +
        'Live progress is shown in the Antigravity pane. Set continue_conversation to follow up on the previous agy run.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task for agy, written as a complete instruction.' },
          cwd: { type: 'string', description: 'Working directory for agy. Defaults to the configured default_cwd, else the session directory.' },
          continue_conversation: { type: 'boolean', description: 'Continue the most recent agy conversation started from this session.' },
          conversation: { type: 'string', description: 'An explicit agy conversation id to resume.' },
          model: { type: 'string', description: 'agy --model slug; empty uses the configured default.' },
          effort: { type: 'string', enum: [...EFFORTS], description: 'Reasoning effort for this run; empty uses the configured default.' },
          mode: { type: 'string', enum: [...MODES], description: '"plan": agy only plans, changes nothing. "accept-edits": agy may edit files but not run commands. Empty: full access.' },
          agent: { type: 'string', description: 'Name of an agent defined in agy (see `agy agents`) to run the task with.' },
          project: { type: 'string', description: 'agy project id or name for this run.' },
          add_dirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories agy may read and edit besides cwd.' },
          json_schema: { type: 'string', description: 'A JSON schema (as JSON text, or a path to a schema file) the final answer must conform to.' },
          sandbox: { type: 'boolean', description: 'Run agy in its sandbox with terminal restrictions.' },
          timeout_minutes: { type: 'number', description: `Maximum minutes to wait for agy (default ${DEFAULT_MINUTES}, at most 60).` },
        },
        required: ['prompt'],
      },
    })
    await $.command.register({
      name: 'agy',
      description: 'Antigravity: /agy opens the pane and checks agy, /agy <prompt> runs agy, /agy cancel stops the current run',
    })
    const started = await next(e)
    void $.ui.open({ id: PANE, title: 'Antigravity' })
    void checkAgy($).then(health => $.state.set(HEALTH, health)).catch(() => undefined)
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(FULL_TOOL)) return composed
    return { sections: [...composed.sections, { id: 'agy-bridge:delegate', text: DELEGATION_GUIDE, scope: 'session' }] }
  })

  on('tool.call', { tool: FULL_TOOL }, async ($, e, next) => {
    const input = e as unknown as RunInput
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) return { result: 'agy-bridge: prompt is required.' }
    if (active) return { result: `agy-bridge: an agy run is already in progress (job ${active.job}). Wait for it, or stop it with /agy cancel.` }
    if (input.effort !== undefined && String(input.effort).trim() && !asEffort(input.effort)) {
      return { result: `agy-bridge: effort must be one of ${EFFORTS.join(', ')}.` }
    }
    if (input.mode !== undefined && String(input.mode).trim() && !asMode(input.mode)) {
      return { result: `agy-bridge: mode must be one of ${MODES.join(', ')}.` }
    }

    const cwd = String(input.cwd ?? '').trim() || options.default_cwd
    const { value: previous = null } = await $.state.get(LAST)
    const conversation = input.conversation ?? (input.continue_conversation ? previous : null) ?? null
    const jsonSchema = String(input.json_schema ?? '').trim()
    const launch: AgyLaunch = {
      model: String(input.model ?? '').trim() || options.model,
      effort: asEffort(input.effort) || options.effort,
      mode: asMode(input.mode),
      agent: String(input.agent ?? '').trim() || options.agent,
      project: String(input.project ?? '').trim(),
      addDirs: asDirs(input.add_dirs),
      sandbox: input.sandbox === undefined ? options.sandbox : asBool(input.sandbox),
      structured: jsonSchema !== '',
    }
    const minutes = Math.max(1, Math.min(60, Math.round(Number(input.timeout_minutes) || DEFAULT_MINUTES)))
    const timeout = `${minutes}m`
    const job = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

    let current: AgyRun = {
      ...launch,
      job, prompt, cwd, conversation, status: 'starting', phase: 'starting agy', startedAt: Date.now(), steps: [], text: '',
    }
    const { value: known = [] } = await $.state.get(RUNS)
    let list: AgyRun[] = [...known, current].slice(-MAX_RUNS)
    const save = async () => {
      list = replaceRun(list, current)
      await $.state.set(RUNS, list)
    }
    await $.state.set(RUNS, list)
    $.ui.status('agy: running')

    const argv = argvFor({ ...launch, prompt, conversation, timeout, jsonSchema })
    const stream = $.process.spawn({ argv, ...(cwd ? { cwd } : {}) })
    const me: Active = { job, stream, cancelled: false }
    active = me
    ticker?.cancel()
    ticker = $.clock.every(1000, () => $.ui.invalidate('ui.render'))

    // agy's own --print-timeout is the real limit; this only catches a hung child that keeps writing.
    const deadline = Date.now() + (minutes + 1) * 60_000
    let stderr = ''
    let buffer = ''
    let ended: ProcessSpawnResult | undefined
    try {
      for (;;) {
        const pulled = await stream.next()
        if (pulled.done) {
          ended = pulled.value
          break
        }
        const chunk = pulled.value
        if (chunk.stream === 'stderr') {
          stderr = `${stderr}${chunk.text}`.slice(-MAX_STDERR)
          continue
        }
        buffer += chunk.text
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        let changed = false
        for (const line of lines) {
          const trimmed = line.trimEnd()
          if (!trimmed) continue
          current = applyEvent(current, trimmed)
          changed = true
        }
        if (changed) await save()
        if (Date.now() > deadline) {
          await stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
          current = { ...current, status: 'error', error: `agy ran past ${minutes}m and was stopped`, endedAt: Date.now() }
          break
        }
      }
      if (buffer.trim()) current = applyEvent(current, buffer.trim())
    } catch (error) {
      const message = (error as Error).message ?? String(error)
      if (current.status === 'starting') {
        current = { ...current, status: 'error', error: `could not start agy (${agyExe}): ${message}`, endedAt: Date.now() }
        await $.state.set(HEALTH, { ok: false, message: `agy not available (${agyExe}): ${oneLine(message, 200)}`, checkedAt: Date.now() })
      } else {
        current = { ...current, status: 'error', error: `agy output stream lost: ${message}`, endedAt: Date.now() }
      }
    } finally {
      if (active === me) active = null
      ticker?.cancel()
      ticker = null
      $.ui.status(undefined)
    }

    if (next.signal.aborted) {
      current = { ...current, status: 'error', error: 'interrupted', endedAt: Date.now() }
    } else if (me.cancelled) {
      current = { ...current, status: 'cancelled', error: 'cancelled from the Antigravity pane or /agy cancel', endedAt: Date.now() }
    } else if (ended && current.status !== 'done' && current.status !== 'error') {
      const failed = (ended.code ?? 1) !== 0
      current = {
        ...current,
        status: failed ? 'error' : 'done',
        error: failed
          ? `agy exited with ${ended.code === null ? `signal ${ended.signal}` : `code ${ended.code}`}${stderr ? `: ${oneLine(stderr, 300)}` : ''}`
          : undefined,
        endedAt: Date.now(),
      }
    }
    current = { ...current, phase: undefined, endedAt: current.endedAt ?? Date.now() }
    await save()

    if (current.conversation) await $.state.set(LAST, current.conversation)
    return { result: summarize(current, stderr) }
  })

  on('command.run', { command: 'agy' }, async ($, e) => {
    const args = e.args.trim()
    if (!args) {
      await $.ui.open({ id: PANE, title: 'Antigravity', focus: true })
      const health = await checkAgy($)
      await $.state.set(HEALTH, health)
      return { text: `Antigravity pane opened. ${health.message}` }
    }
    if (args === 'cancel') {
      const job = await cancelActive()
      return { text: job ? `agy: cancelled job ${job}.` : 'agy: nothing is running.' }
    }
    await $.ui.open({ id: PANE, title: 'Antigravity' })
    const ran = await $.tool.call({ tool: FULL_TOOL, prompt: args } as never)
    return { text: ran.deny ?? (typeof ran.result === 'string' ? ran.result : ran.text ?? 'agy finished.') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown, Button } = $.ui.resolve(e)
    const { value: list = [] } = await $.state.get(RUNS)
    const { value: health = null } = await $.state.get(HEALTH)
    const rows = Math.max(12, e.viewport?.rows ?? 40)
    const run = list[list.length - 1]

    const header = (
      <Box justifyContent="space-between">
        <Text color={health ? (health.ok ? 'success' : 'error') : 'inactive'} wrap="truncate">
          {health ? (health.ok ? '●' : '○') : '○'} {health ? health.message : `agy (${options.agy_path}) · checking…`}
        </Text>
        <Text dimColor>{list.length > 0 ? `${list.length} run${list.length === 1 ? '' : 's'}` : 'Antigravity'}</Text>
      </Box>
    )

    if (!run) {
      return (
        <Box flexDirection="column">
          {header}
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1}>
            <Text bold>Antigravity sub-agent</Text>
            <Text dimColor wrap="wrap">
              Ask Claude to hand a task to agy, or type /agy {'<prompt>'}. Each run shows up here with its tool calls, live output and final answer.
            </Text>
          </Box>
        </Box>
      )
    }

    const live = isLive(run)
    const look = statusLook(run)
    const elapsed = fmtElapsed((run.endedAt ?? Date.now()) - run.startedAt)
    const meta = [
      run.conversation ? `conv ${shortId(run.conversation)}` : null,
      run.model ? `model ${run.model}` : null,
      ...launchTags(run),
      run.numTurns ? `${run.numTurns} turn${run.numTurns === 1 ? '' : 's'}` : null,
      run.usage ? `${fmtTokens(run.usage.total)} tokens` : null,
    ].filter(Boolean).join(' · ')

    const stepRoom = Math.max(4, Math.min(14, Math.floor(rows / 4)))
    const shownSteps = run.steps.slice(-stepRoom)
    const hiddenSteps = run.steps.length - shownSteps.length
    const toolCalls = run.steps.filter(s => s.type === 'tool').length

    const hasResult = run.response !== undefined && run.response.trim() !== ''
    const streamTail = run.text.split('\n').filter(l => l.trim()).slice(-Math.max(3, Math.min(12, Math.floor(rows / 5)))).join('\n')
    const resultText = hasResult
      ? run.response!.length > MAX_RESULT_SHOWN ? `…\n${run.response!.slice(-MAX_RESULT_SHOWN)}` : run.response!
      : ''
    const history = list.slice(0, -1).slice(-4).reverse()

    return (
      <Box flexDirection="column">
        {header}

        <Box flexDirection="column" borderStyle="round" borderColor={look.color} paddingX={1} marginTop={1}>
          <Box gap={2}>
            <Text color={look.color} bold>{look.icon} {look.label}</Text>
            <Text dimColor>{elapsed}</Text>
            {live && run.phase ? <Text color="claude">{run.phase}…</Text> : null}
          </Box>
          <Text dimColor wrap="truncate-start">{run.cwd || '(session directory)'}{meta ? `  ·  ${meta}` : ''}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>TASK</Text>
            <Text wrap="wrap">{oneLine(run.prompt, 600)}</Text>
          </Box>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Text bold>Activity</Text>
            <Text dimColor>{toolCalls === 0 ? (live ? 'no tool calls yet' : 'no tool calls') : `${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`}</Text>
          </Box>
          {hiddenSteps > 0 ? <Text dimColor>  … {hiddenSteps} earlier</Text> : null}
          {shownSteps.map(step => (
            <Box gap={1}>
              <Text color={step.error ? 'error' : step.state === 'DONE' ? 'success' : 'claude'}>
                {step.error ? '✗' : step.state === 'DONE' ? '✓' : '▶'}
              </Text>
              <Text bold={step.state !== 'DONE'} dimColor={step.state === 'DONE' && !step.error}>{step.tool ?? step.type}</Text>
              <Text dimColor wrap="truncate">{step.error ? `! ${step.error}` : step.summary ?? ''}</Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>{hasResult ? 'Result' : 'Output'}</Text>
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            {hasResult
              ? <Markdown text={resultText} />
              : <Text dimColor wrap="wrap">{streamTail || (live ? 'Waiting for agy…' : '(no output)')}</Text>}
          </Box>
          {run.error ? <Text color="error" wrap="wrap">✗ {run.error}</Text> : null}
        </Box>

        {live ? (
          <Box marginTop={1}>
            <Button key="cancel" variant="secondary" hotkey="c" onPress={() => { void cancelActive() }}>Cancel run</Button>
          </Box>
        ) : null}

        {history.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Earlier</Text>
            {history.map(one => {
              const past = statusLook(one)
              return (
                <Box gap={1}>
                  <Text color={past.color}>{past.icon}</Text>
                  <Text dimColor wrap="truncate">{fmtAgo(one.startedAt)} · {fmtElapsed((one.endedAt ?? one.startedAt) - one.startedAt)} · {oneLine(one.prompt, 70)}</Text>
                </Box>
              )
            })}
          </Box>
        ) : null}
      </Box>
    )
  })
}
