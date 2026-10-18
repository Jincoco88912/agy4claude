import type { ElementConstructor, EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, SelectProps, SvgProps, Timer } from 'claude-code'
import { atom, update } from 'claude-code'

import { CLAUDE_AVATAR, LOGO_SVG, ROBOT_AVATAR, fmtUsd, moodOf, savedUsd, savingsSvg, stageSvg } from './stage'
import type { AgyAccountQuota, AgyEffort, AgyHealth, AgyLaunch, AgyMode, AgyModel, AgyPoolQuota, AgyQuota, AgyRotation, AgyRun, AgySettings, AgyStep, AgyUsage } from '../types'

const PANE = 'agy'
const TOOL = 'run'
const FULL_TOOL = 'mcp__agy4claude__run'
const MAX_RUNS = 20
const MAX_TEXT = 20_000
const MAX_STDERR = 4_000
const MAX_RESULT_SHOWN = 6_000
const DEFAULT_MINUTES = 10
const EFFORTS: readonly AgyEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const MODES: readonly AgyMode[] = ['plan', 'accept-edits']

// `$.state` refs: plugin and key are literals, as the validator asks.
const RUNS = { plugin: 'agy4claude', key: 'runs' } as const
const LAST = { plugin: 'agy4claude', key: 'lastConversation' } as const
const HEALTH = { plugin: 'agy4claude', key: 'health' } as const
const QUOTA = { plugin: 'agy4claude', key: 'quota' } as const
const MODELS = { plugin: 'agy4claude', key: 'models' } as const
const SETTINGS_OPEN = { plugin: 'agy4claude', key: 'settingsOpen' } as const
const EXPANDED = { plugin: 'agy4claude', key: 'expanded' } as const
const expandedRuns = atom(EXPANDED, [] as string[])
/** A reply longer than this many lines (or characters) is folded behind a "show all" button. */
const FOLD_LINES = 10
const FOLD_CHARS = 700
const frame = atom({ plugin: 'agy4claude', key: 'frame' } as const, 0)
/** Stage frames a second while agy runs (and briefly after); idle, the robot drifts at a quarter of that. */
const FPS = 8

const MAIN = 'main'
/** How long a quota reading is trusted when picking a sign-in. */
const QUOTA_FRESH_MS = 60_000
/** What agy says when a sign-in has run out: the run is retried once on the next sign-in. */
const QUOTA_ERROR = /quota|exhausted|rate.?limit|\b429\b|limit (?:reached|exceeded)/i

type Options = {
  agy_path: string
  default_cwd: string
  model: string
  effort: AgyEffort | ''
  agent: string
  profiles_dir: string
  account_order: string
  rotation: AgyRotation
  language: 'auto' | 'en' | 'zh-TW'
  min_quota: number
  claude_price_in: number
  claude_price_out: number
  sandbox: boolean
}

type RunInput = {
  prompt?: string
  account?: string
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
  /** Absent while the run is still picking a sign-in. */
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null
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

const ROTATIONS: readonly AgyRotation[] = ['ordered', 'round-robin', 'random', 'most-left']
const asRotation = (value: unknown): AgyRotation => {
  const text = String(value ?? '').trim().toLowerCase()
  return (ROTATIONS as readonly string[]).includes(text) ? (text as AgyRotation) : 'ordered'
}

type Lang = 'en' | 'zh-TW'
const LANGS: readonly ('auto' | Lang)[] = ['auto', 'en', 'zh-TW']
const asLanguage = (value: unknown): 'auto' | Lang => {
  const text = String(value ?? '').trim()
  return (LANGS as readonly string[]).includes(text) ? (text as 'auto' | Lang) : 'auto'
}

const asPrice = (value: unknown, fallback: number): number => {
  const n = Number(value)
  return String(value ?? '').trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback
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
  profiles_dir: String(options.profiles_dir ?? '').trim(),
  account_order: String(options.account_order ?? '').trim(),
  rotation: asRotation(options.rotation),
  language: asLanguage(options.language),
  min_quota: Number.isFinite(Number(options.min_quota)) && String(options.min_quota ?? '').trim() !== '' ? Number(options.min_quota) : 5,
  claude_price_in: asPrice(options.claude_price_in, 4),
  claude_price_out: asPrice(options.claude_price_out, 20),
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
/** When an SVG stage was last drawn, and the runs it drew: the stage clock runs only while one is in view. */
let stageSeenAt = 0
let lastRuns: AgyRun[] = []

const cancelActive = async (): Promise<string | null> => {
  if (!active) return null
  const stopping = active
  stopping.cancelled = true
  await stopping.stream?.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
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

// ---- sign-ins (accounts) --------------------------------------------------
// agy keeps its sign-in under HOME, so another HOME is another Google account with its own quota.
// `main` is the real HOME; each subfolder of profiles_dir (default ~/.agy-profiles) is one more.

const homeOf = async ($: EngineInterface): Promise<string> =>
  (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''

const profilesDirOf = async ($: EngineInterface): Promise<string> => {
  if (options.profiles_dir) return options.profiles_dir
  const home = await homeOf($)
  return home ? `${home}/.agy-profiles` : ''
}

/** The profile folders that exist, by name. */
const profilesOf = async ($: EngineInterface): Promise<string[]> => {
  const dir = await profilesDirOf($)
  if (!dir) return []
  try {
    return (await $.fs.list(dir))
      .filter(one => one.kind !== 'file' && !one.name.startsWith('.') && one.name !== MAIN)
      .map(one => one.name)
      .sort()
  } catch {
    return []
  }
}

/** Every sign-in runs may use, in order: account_order when set (unknown names dropped), else the profiles by name, then main. */
const accountsOf = async ($: EngineInterface): Promise<string[]> => {
  const profiles = await profilesOf($)
  const order = options.account_order.split(',').map(one => one.trim()).filter(Boolean)
  if (order.length) {
    const known = order.filter((name, i) => order.indexOf(name) === i && (name === MAIN || profiles.includes(name)))
    if (known.length) return known
  }
  return [...profiles, MAIN]
}

// agy saves a refreshed sign-in to the OS keychain first, which a swapped HOME has none of (macOS then pops
// "a keychain cannot be found"), and the OS keychain is shared by every HOME anyway. agy keeps the token in a
// file under HOME instead when it sees an SSH session, so profiles say they are one.
const FILE_TOKEN_ENV = { SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0' }

/** The env a run of this sign-in gets: nothing for `main`, the home folder pointed at the profile otherwise. */
const envFor = async ($: EngineInterface, account: string): Promise<Record<string, string> | undefined> => {
  if (account === MAIN) return undefined
  const home = `${await profilesDirOf($)}/${account}`
  return (await $.env.get('USERPROFILE'))
    ? { HOME: home, USERPROFILE: home, ...FILE_TOKEN_ENV }
    : { HOME: home, ...FILE_TOKEN_ENV }
}

/** Gemini models draw on one quota pool; Claude and GPT models in agy on another. */
const poolOf = (model: string): 'gemini' | 'other' => (/^(claude|gpt)/i.test(model) ? 'other' : 'gemini')

const POOL_ROWS = { gemini: 'Gemini Models', other: 'Claude and GPT models' } as const

/** Reads `agy -p /usage` for one sign-in: TSV rows of `<pool>  <window>  <NN%>  <reset time>`. */
const readQuota = async ($: EngineInterface, account: string): Promise<AgyAccountQuota> => {
  const unread: AgyAccountQuota = { name: account, gemini: { left: -1 }, other: { left: -1 } }
  const env = await envFor($, account)
  try {
    const ran = await $.process.run([agyExe, '-p', '/usage', '--print-timeout', '30s'], {
      ...(env ? { env, cwd: env.HOME } : { cwd: (await homeOf($)) || undefined }),
      timeoutMs: 45_000,
    })
    const rows = ran.stdout.split('\n').map(row => row.split('\t'))
    const pool = (label: string): AgyPoolQuota => {
      let best: AgyPoolQuota = { left: -1 }
      for (const cols of rows) {
        if (cols[0] !== label) continue
        const left = Number.parseInt(cols[2] ?? '', 10)
        if (!Number.isFinite(left)) continue
        if (best.left < 0 || left < best.left) best = { left, ...(cols[3]?.trim() ? { resetAt: cols[3].trim() } : {}) }
      }
      return best
    }
    return { name: account, gemini: pool(POOL_ROWS.gemini), other: pool(POOL_ROWS.other) }
  } catch {
    return unread
  }
}

/** Reads every sign-in's quota at once and keeps it for the pane. */
const checkQuota = async ($: EngineInterface): Promise<AgyQuota> => {
  const accounts = await Promise.all((await accountsOf($)).map(name => readQuota($, name)))
  const quota: AgyQuota = { accounts, checkedAt: Date.now() }
  await $.state.set(QUOTA, quota)
  return quota
}

const fmtLeft = (left: number): string => (left < 0 ? '?' : `${left}%`)

const fmtQuota = (quota: AgyQuota, pool: 'gemini' | 'other' = 'gemini'): string =>
  quota.accounts.map(one => `${one.name} ${fmtLeft(one[pool].left)}`).join(' · ')

/**
 * The sign-in a run uses, by the rotation setting, among those whose pool for the model has more
 * than min_quota left. With one sign-in there is nothing to choose and no quota is read. When no
 * quota could be read at all, the first is tried rather than refusing. `skip` leaves out sign-ins
 * already tried this run.
 */
const pickAccount = async ($: EngineInterface, model: string, skip: string[] = []): Promise<{ account: string } | { error: string }> => {
  const all = await accountsOf($)
  const candidates = all.filter(name => !skip.includes(name))
  if (candidates.length === 0) return { error: 'every agy sign-in has been tried' }
  if (all.length === 1) return { account: candidates[0]! }
  const pool = poolOf(model)
  const { value: cached = null } = await $.state.get(QUOTA)
  const fresh = cached && Date.now() - cached.checkedAt < QUOTA_FRESH_MS && all.every(name => cached.accounts.some(a => a.name === name))
  const quota = fresh ? cached! : await checkQuota($)
  const left = (name: string) => quota.accounts.find(a => a.name === name)?.[pool].left ?? -1
  const usable = candidates.filter(name => left(name) > options.min_quota)
  if (usable.length === 0) {
    // Nothing clears the bar: try one whose quota could not be read before refusing.
    const unknown = candidates.find(name => left(name) < 0)
    if (unknown) return { account: unknown }
    return { error: `every agy sign-in is out of ${pool === 'gemini' ? 'Gemini' : 'Claude/GPT'} quota (${fmtQuota(quota, pool)}); /agy usage shows when they reset` }
  }
  const { rotation } = await settingsOf($)
  if (rotation === 'random') return { account: usable[Math.floor(Math.random() * usable.length)]! }
  if (rotation === 'most-left') return { account: [...usable].sort((x, y) => left(y) - left(x))[0]! }
  if (rotation === 'round-robin') {
    const last = String((await $.store.get('lastAccount')) ?? '')
    const after = all.indexOf(last)
    const next = [...all.slice(after + 1), ...all.slice(0, after + 1)].find(name => usable.includes(name))
    return { account: next ?? usable[0]! }
  }
  return { account: usable[0]! }
}

/** Marks a sign-in's pool as spent after agy reported it out of quota, so the next pick skips it. */
const markSpent = async ($: EngineInterface, account: string, model: string) => {
  const { value: quota = null } = await $.state.get(QUOTA)
  if (!quota) return
  const pool = poolOf(model)
  await $.state.set(QUOTA, { ...quota, accounts: quota.accounts.map(a => (a.name === account ? { ...a, [pool]: { ...a[pool], left: 0 } } : a)) })
}

// ---- settings ------------------------------------------------------------
// The pane's pickers write model, effort and rotation to the plugin's store, over the plugin
// options; a tool call's own model or effort wins over both.

const settingsOf = async ($: EngineInterface): Promise<AgySettings> => {
  const saved = ((await $.store.get('settings')) ?? {}) as Partial<AgySettings>
  return {
    model: typeof saved.model === 'string' ? saved.model : options.model,
    effort: saved.effort !== undefined ? asEffort(saved.effort) : options.effort,
    rotation: saved.rotation !== undefined ? asRotation(saved.rotation) : options.rotation,
    language: saved.language !== undefined ? asLanguage(saved.language) : options.language,
  }
}

const saveSetting = async ($: EngineInterface, change: Partial<AgySettings>) => {
  const saved = ((await $.store.get('settings')) ?? {}) as Partial<AgySettings>
  await $.store.set('settings', { ...saved, ...change })
  $.ui.invalidate('ui.render')
}

/** `agy models`: one `<slug>\t<label>` per line after a header. */
const loadModels = async ($: EngineInterface): Promise<AgyModel[]> => {
  try {
    const ran = await $.process.run([agyExe, 'models'], { timeoutMs: 30_000 })
    return ran.stdout.split('\n').map(row => row.split('\t')).filter(cols => cols.length >= 2 && cols[0]!.trim())
      .map(cols => ({ value: cols[0]!.trim(), label: cols[1]!.trim() }))
  } catch {
    return []
  }
}

/** Lets git inside a profile's HOME find the user's own git settings. */
const shareGitConfig = async ($: EngineInterface, account: string) => {
  if (account === MAIN) return
  const home = await homeOf($)
  const env = await envFor($, account)
  if (!home || !env) return
  try {
    if ((await $.fs.exists(`${home}/.gitconfig`)) && !(await $.fs.exists(`${env.HOME}/.gitconfig`))) {
      await $.process.run(['ln', '-s', `${home}/.gitconfig`, `${env.HOME}/.gitconfig`])
    }
  } catch {
    // Best effort: a run without the user's git settings still runs.
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
    `account ${run.account}`,
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

// ---- language ------------------------------------------------------------
// The pane and the /agy replies speak the viewer's language; the tool result stays English for the model.

const STRINGS = {
  en: {
    subtitle: 'Gemini sub-agent', checking: 'checking agy…', runs: (n: number) => `${n} run${n === 1 ? '' : 's'}`,
    model: 'Model', effort: 'Effort', rotation: 'Rotation', language: 'Language', agyDefault: 'agy default',
    rot: { ordered: 'Ordered · first with quota', 'round-robin': 'Round-robin · next each run', random: 'Random', 'most-left': 'Most quota left' },
    rotShort: { ordered: 'ordered', 'round-robin': 'round-robin', random: 'random', 'most-left': 'most left' },
    langAuto: 'Auto', langShort: { auto: 'auto', en: 'English', 'zh-TW': '繁中' },
    settings: 'Settings', close: 'Close', saved: 'Saved', today: (v: string) => `today +${v}`, savedAbout: (v: string) => `saved ~${v}`,
    status: { done: 'Done', error: 'Error', cancelled: 'Cancelled', running: 'Running', starting: 'Starting', idle: 'Standing by', sleeping: 'Out of quota' },
    onAccount: (a: string) => `account ${a}`, step: (n: number, what: string) => `step ${n} · ${what}`, toolsTokens: (n: number, tk: string) => `${n} tool call${n === 1 ? '' : 's'} · ${tk} tokens`,
    activity: 'Activity', noTools: 'No tool calls', noToolsYet: 'No tool calls yet', toolCalls: (n: number) => `${n} tool call${n === 1 ? '' : 's'}`,
    earlier: (n: number) => `${n} earlier`, waiting: 'Working on it…', noOutput: '(no output)',
    phase: { 'checking quota': 'Checking quota…', 'starting agy': 'Starting agy…', thinking: 'Thinking…', writing: 'Writing the answer…' } as Record<string, string>,
    cancel: 'Cancel', history: 'History', showAll: 'Show the whole answer', showLess: 'Show less', claudeAsks: 'Claude asks', claudeFollows: 'Claude follows up', agentReplies: 'Gemini replies',
    emptyTitle: 'Hand work to Gemini', emptyBody: 'Ask Claude to delegate a task to agy, or type /agy <prompt>. The conversation, tool calls and answer show here.',
    justNow: 'just now', minAgo: (n: number) => `${n}m ago`, hourAgo: (n: number) => `${n}h ago`, dayAgo: (n: number) => `${n}d ago`,
    opened: 'Antigravity pane opened.', cancelled: (job: string) => `agy: cancelled job ${job}.`, nothingRunning: 'agy: nothing is running.',
    usageHead: 'agy sign-ins, in the order runs use them:', unreadable: 'quota unreadable (signed in?)', resets: 'resets',
    accountsHead: (rot: string) => `agy sign-ins, in order (rotation: ${rot}):`, ownSignIn: '(your own agy sign-in)', addHint: 'Add one: /agy accounts add <name>',
    addUsage: 'Usage: /agy accounts add <name> (letters, digits, - or _; not "main")', noHome: 'agy4claude: no home folder to keep sign-ins in; set profiles_dir in the plugin options.',
    created: (path: string) => `Created ${path}. Sign it in once from a terminal (it opens a Google sign-in), then /exit:`,
    joins: (ordered: boolean) => `It joins the rotation by itself${ordered ? ' once you add it to account_order' : ''}; /agy usage checks it.`,
  },
  'zh-TW': {
    subtitle: 'Gemini 子代理', checking: '正在檢查 agy…', runs: (n: number) => `${n} 次`,
    model: '模型', effort: '思考程度', rotation: '輪替', language: '語言', agyDefault: 'agy 預設',
    rot: { ordered: '依序 · 第一個有額度的', 'round-robin': '輪流 · 每次換下一個', random: '隨機', 'most-left': '剩最多的' },
    rotShort: { ordered: '依序輪替', 'round-robin': '輪流', random: '隨機', 'most-left': '剩最多優先' },
    langAuto: '自動', langShort: { auto: '自動', en: 'English', 'zh-TW': '繁中' },
    settings: '設定', close: '收起', saved: '累積節省', today: (v: string) => `今天 +${v}`, savedAbout: (v: string) => `省約 ${v}`,
    status: { done: '完成', error: '錯誤', cancelled: '已取消', running: '執行中', starting: '啟動中', idle: '待命', sleeping: '額度用完' },
    onAccount: (a: string) => `帳號 ${a}`, step: (n: number, what: string) => `第 ${n} 步 · ${what}`, toolsTokens: (n: number, tk: string) => `${n} 次工具呼叫 · ${tk} tokens`,
    activity: '過程', noTools: '沒有呼叫工具', noToolsYet: '尚未呼叫工具', toolCalls: (n: number) => `${n} 次工具呼叫`,
    earlier: (n: number) => `前面還有 ${n} 筆`, waiting: '正在處理…', noOutput: '(沒有輸出)',
    phase: { 'checking quota': '正在查各帳號額度…', 'starting agy': '正在啟動 agy…', thinking: '思考中…', writing: '正在整理答案…' } as Record<string, string>,
    cancel: '取消', history: '紀錄', showAll: '看完整回答', showLess: '收起', claudeAsks: 'Claude 交辦', claudeFollows: 'Claude 接著問', agentReplies: 'Gemini 回報',
    emptyTitle: '把工作交給 Gemini', emptyBody: '請 Claude 把任務交給 agy,或輸入 /agy <題目>。對話、工具呼叫與答案都會顯示在這裡。',
    justNow: '剛剛', minAgo: (n: number) => `${n} 分鐘前`, hourAgo: (n: number) => `${n} 小時前`, dayAgo: (n: number) => `${n} 天前`,
    opened: '已開啟 Antigravity 面板。', cancelled: (job: string) => `agy:已取消 ${job}。`, nothingRunning: 'agy:目前沒有執行中的任務。',
    usageHead: 'agy 帳號(依使用順序):', unreadable: '讀不到額度(登入了嗎?)', resets: '重置於',
    accountsHead: (rot: string) => `agy 帳號(依序，輪替方式:${rot}):`, ownSignIn: '(你本來的 agy 登入)', addHint: '新增：/agy accounts add <名稱>',
    addUsage: '用法:/agy accounts add <名稱>(英數、- 或 _;不能叫 main)', noHome: 'agy4claude:找不到家目錄存放帳號，請在插件選項設定 profiles_dir。',
    created: (path: string) => `已建立 ${path}。請在終端機登入一次(會開 Google 登入頁),完成後 /exit:`,
    joins: (ordered: boolean) => `${ordered ? '把它加進 account_order 後' : ''}就會自動加入輪替;/agy usage 可以確認。`,
  },
} as const

type Strings = (typeof STRINGS)['en'] | (typeof STRINGS)['zh-TW']

const langOf = async ($: EngineInterface): Promise<Lang> => {
  const { language } = await settingsOf($)
  if (language !== 'auto') return language
  const env = `${(await $.env.get('LC_ALL')) ?? ''} ${(await $.env.get('LANG')) ?? ''}`
  return /zh/i.test(env) ? 'zh-TW' : 'en'
}

const stringsOf = async ($: EngineInterface): Promise<Strings> => STRINGS[await langOf($)]

// ---- savings: what delegated runs would have cost on Claude, kept across sessions ----

type Savings = { total: number; days: Record<string, number> }

/** The local calendar day, so "today" turns over at the viewer's midnight. */
const dayKey = (at: number): string => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const savingsOf = async ($: EngineInterface): Promise<Savings> => {
  const raw = (await $.store.get('savings')) as Partial<Savings> | undefined
  return { total: Number(raw?.total) || 0, days: raw?.days && typeof raw.days === 'object' ? raw.days : {} }
}

const addSavings = async ($: EngineInterface, usd: number) => {
  if (!(usd > 0)) return
  const now = await $.clock.now()
  const s = await savingsOf($)
  const key = dayKey(now)
  const days: Record<string, number> = { ...s.days, [key]: (s.days[key] ?? 0) + usd }
  // Keep a month of days; the total keeps everything.
  for (const old of Object.keys(days).sort().slice(0, -31)) delete days[old]
  await $.store.set('savings', { total: s.total + usd, days })
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

const fmtAgo = (at: number, t: Strings = STRINGS.en): string => {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return t.justNow
  if (minutes < 60) return t.minAgo(minutes)
  const hours = Math.round(minutes / 60)
  return hours < 24 ? t.hourAgo(hours) : t.dayAgo(Math.round(hours / 24))
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

const shortId = (id: string | null): string => (id ? id.split('-')[0]! : '')

const isLive = (run: AgyRun): boolean => run.status === 'running' || run.status === 'starting'

type Tone = 'claude' | 'success' | 'error' | 'inactive'

const statusLook = (run: AgyRun | undefined, t: Strings = STRINGS.en): { icon: string; label: string; color: Tone } => {
  switch (run?.status) {
    case undefined: return { icon: '○', label: t.status.idle, color: 'inactive' }
    case 'done': return { icon: '✓', label: t.status.done, color: 'success' }
    case 'error': return { icon: '✕', label: t.status.error, color: 'error' }
    case 'cancelled': return { icon: '■', label: t.status.cancelled, color: 'inactive' }
    case 'starting': return { icon: '◌', label: t.status.starting, color: 'claude' }
    default: return { icon: '●', label: t.status.running, color: 'claude' }
  }
}

/** The terminal's quota meter: ten cells. */
const meterText = (left: number): string => {
  if (left < 0) return '··········'
  const full = Math.round(Math.max(0, Math.min(100, left)) / 10)
  return `${'█'.repeat(full)}${'░'.repeat(10 - full)}`
}

const DELEGATION_GUIDE =
  '# Antigravity CLI (agy)\n' +
  `Antigravity CLI is installed on this machine and reachable through the tool \`${FULL_TOOL}\`. ` +
  'Treat it as a sub-agent: hand it a self-contained coding task when the user asks to delegate to agy or Antigravity, ' +
  'wants a second implementation or opinion from it, or wants work to proceed in parallel while you continue. ' +
  'Write the prompt as a complete instruction with the paths it needs; it runs with permissions bypassed in the given working directory. ' +
  'Use mode "plan" when only a plan or review is wanted and nothing should change; "accept-edits" when it may edit files but should not run commands. ' +
  'Use json_schema when you will parse its answer. ' +
  'Besides files and commands, agy has its own tools for the web: search_web (Google search), read_url_content (reads a page) and a full browser ' +
  '(open, click, type, scroll, screenshot, run JavaScript), so web research, reading long pages and checking a site can be delegated too. ' +
  'search_web returns Google redirect links (vertexaisearch.cloud.google.com/grounding-api-redirect/...) and bare domain names, not the real sources: ' +
  'when sources matter, tell agy to open each result with read_url_content and report the final page title and real URL, and spot-check a few yourself. ' +
  'For facts that must be current (latest versions, prices, release dates), verify them yourself rather than trusting the answer alone. ' +
  'Its final answer comes back as the tool result (live progress is in the Antigravity pane). ' +
  'It rotates through the user\'s agy sign-ins (separate Google accounts), using the first with Gemini quota left; leave account empty unless the user names one. ' +
  'Pass continue_conversation: true to follow up on its last run. Tell the user what you delegated and summarize what agy did.'

/** One delegated task: picks a sign-in, runs agy, retries once on an exhausted quota, keeps the pane's record. */
/**
 * agy links local files as [label](file:///long/path), which the pane cannot open and which draw the whole
 * path, wider than the bubble: keep the label alone (or the file name for a bare file URL).
 */
const tidyReply = (text: string): string =>
  text
    .replace(/\[([^\]]+)\]\(file:\/\/[^)\s]+\)/g, '$1')
    .replace(/(?<![(\w])file:\/\/\S*\/([^/\s)#]+)(#\S*)?/g, '`$1`')

const newJob = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

/** Writes one run's record; every write re-reads the list, so no other record is dropped. */
async function saveRun($: EngineInterface, run: AgyRun) {
  const { value: known = [] } = await $.state.get(RUNS)
  const list = known.some(one => one.job === run.job) ? replaceRun(known, run) : [...known, run].slice(-MAX_RUNS)
  await $.state.set(RUNS, list)
}

async function runTask($: EngineInterface, input: RunInput, prompt: string, next: { signal: { aborted: boolean } }, claim: Active) {
  const cwd = String(input.cwd ?? '').trim() || options.default_cwd
  const { value: previous = null } = await $.state.get(LAST)
  const conversation = input.conversation ?? (input.continue_conversation ? previous : null) ?? null
  const jsonSchema = String(input.json_schema ?? '').trim()
  const settings = await settingsOf($)
  const launch: AgyLaunch = {
    model: String(input.model ?? '').trim() || settings.model,
    effort: asEffort(input.effort) || settings.effort,
    mode: asMode(input.mode),
    agent: String(input.agent ?? '').trim() || options.agent,
    project: String(input.project ?? '').trim(),
    addDirs: asDirs(input.add_dirs),
    sandbox: input.sandbox === undefined ? options.sandbox : asBool(input.sandbox),
    structured: jsonSchema !== '',
  }
  const minutes = Math.max(1, Math.min(60, Math.round(Number(input.timeout_minutes) || DEFAULT_MINUTES)))
  const timeout = `${minutes}m`
  // A conversation lives in the sign-in that started it, so a follow-up stays there.
  const { value: pastRuns = [] } = await $.state.get(RUNS)
  const sticky = conversation ? pastRuns.find(one => one.conversation === conversation)?.account : undefined
  const askedAccount = String(input.account ?? '').trim() || sticky || ''
  if (askedAccount && !(await accountsOf($)).includes(askedAccount)) {
    return { result: `agy4claude: no agy sign-in named "${askedAccount}" (have: ${(await accountsOf($)).join(', ')}).` }
  }
  void $.ui.open({ id: PANE, title: 'Antigravity' })

  // One attempt per sign-in: a run that dies of an exhausted quota is tried once more on the next one.
  const tried: string[] = []
  // The pane shows the run at once, while the sign-in is still being picked (reading quota can take a while).
  const firstJob = newJob()
  const handedAt = Date.now()
  let current: AgyRun = {
    ...launch,
    job: firstJob, account: askedAccount, prompt, cwd, conversation, status: 'starting', phase: 'checking quota', startedAt: handedAt, steps: [], text: '',
  }
  await saveRun($, current)
  let stderr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const picked = askedAccount ? { account: askedAccount } : await pickAccount($, launch.model, tried)
    if ('error' in picked) {
      if (attempt === 0) {
        await saveRun($, { ...current, status: 'error', phase: undefined, error: picked.error, endedAt: Date.now() })
        return { result: `agy4claude: ${picked.error}` }
      }
      break
    }
    const account = picked.account
    tried.push(account)
    await $.store.set('lastAccount', account)
    await shareGitConfig($, account)
    const env = await envFor($, account)
    stderr = ''
    const job = attempt === 0 ? firstJob : newJob()

    current = {
      ...launch,
      job, account, prompt, cwd, conversation, status: 'starting', phase: 'starting agy', startedAt: handedAt, steps: [], text: '',
    }
    const save = () => saveRun($, current)
    await save()
    $.ui.status('agy: running')

    const argv = argvFor({ ...launch, prompt, conversation, timeout, jsonSchema })
    const stream = $.process.spawn({ argv, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) })
    const me = claim
    me.job = job
    me.stream = stream
    if (me.cancelled) await stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
    ticker?.cancel()
    ticker = $.clock.every(1000, () => $.ui.invalidate('ui.render'))

    // agy's own --print-timeout is the real limit; this only catches a hung child that keeps writing.
    const deadline = Date.now() + (minutes + 1) * 60_000
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
    if (current.status === 'done' && current.usage) {
      current = { ...current, savedUsd: savedUsd(current.usage, options.claude_price_in, options.claude_price_out) }
    }
    await save()

    // Retry on the next sign-in only when agy failed before doing anything: a run that already
    // edited files or ran commands must not run again from the start.
    const untouched = current.steps.length === 0 && !current.text.trim() && !(current.response ?? '').trim()
    const spent = untouched && current.status === 'error' && QUOTA_ERROR.test(`${current.error ?? ''} ${stderr}`)
    if (!spent || askedAccount || me.cancelled || next.signal.aborted) break
    await markSpent($, account, launch.model)
  }

  if (current.conversation) await $.state.set(LAST, current.conversation)
  if (current.savedUsd) await addSavings($, current.savedUsd)
  return { result: summarize(current, stderr) }
}

export const register: Register = (on, rawOptions) => {
  options = readOptions(rawOptions as Record<string, unknown>)
  agyExe = options.agy_path

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description:
        'Delegate a task to Antigravity CLI (agy, Gemini) on this machine, like a sub-agent: code, repo scans, long reading, web search and browsing (it has search_web, read_url_content and a browser). ' +
        'agy runs with permissions bypassed in the given working directory (the session directory by default) and returns its final answer. ' +
        'Live progress is shown in the Antigravity pane. Set continue_conversation to follow up on the previous agy run.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task for agy, written as a complete instruction.' },
          account: { type: 'string', description: 'agy sign-in to use (main, or a profile name). Empty: the first one with Gemini quota left.' },
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
      description: 'Antigravity: /agy opens the pane, /agy <prompt> runs agy, /agy usage shows quota, /agy accounts [add <name>] lists or adds sign-ins, /agy cancel stops the run',
    })
    // A reload ends the loops that were reading agy: close out any run still marked live.
    {
      const { value: known = [] } = await $.state.get(RUNS)
      if (known.some(isLive)) {
        await $.state.set(RUNS, known.map(one => (isLive(one) ? { ...one, status: 'error' as const, phase: undefined, error: 'interrupted (plugin reloaded)', endedAt: Date.now() } : one)))
      }
    }
    // The stage animates from here: frames step while a run is live (and briefly after one ends),
    // a quarter as fast otherwise, and only while the pane has been drawn lately.
    let tick = 0
    $.clock.every(Math.round(1000 / FPS), () => {
      tick++
      if (Date.now() - stageSeenAt > 3_000) return
      const last = lastRuns[lastRuns.length - 1]
      // Motion only while agy works, and for the few seconds of confetti after; otherwise the stage stands still.
      const lively = last ? isLive(last) || (last.endedAt !== undefined && Date.now() - last.endedAt < 6_000) : false
      if (!lively) return
      void update($, frame, n => n + 1)
    })
    const started = await next(e)
    // The pane opens with the first run (or /agy), not in every session.
    void checkAgy($)
      .then(async health => {
        await $.state.set(HEALTH, health)
        if (health.ok) await $.state.set(MODELS, await loadModels($))
      })
      .catch(() => undefined)
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(FULL_TOOL)) return composed
    return { sections: [...composed.sections, { id: 'agy4claude:delegate', text: DELEGATION_GUIDE, scope: 'session' }] }
  })

  on('tool.call', { tool: FULL_TOOL }, async ($, e, next) => {
    const input = e as unknown as RunInput
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) return { result: 'agy4claude: prompt is required.' }
    if (active) return { result: `agy4claude: an agy run is already in progress (job ${active.job}). Wait for it, or stop it with /agy cancel.` }
    if (input.effort !== undefined && String(input.effort).trim() && !asEffort(input.effort)) {
      return { result: `agy4claude: effort must be one of ${EFFORTS.join(', ')}.` }
    }
    if (input.mode !== undefined && String(input.mode).trim() && !asMode(input.mode)) {
      return { result: `agy4claude: mode must be one of ${MODES.join(', ')}.` }
    }

    // Claim the one slot before any await: two parallel calls must not both pass the check above.
    const claim: Active = { job: 'starting', stream: null, cancelled: false }
    active = claim
    try {
      return await runTask($, input, prompt, next, claim)
    } finally {
      if (active === claim) active = null
    }
  })

  on('command.run', { command: 'agy' }, async ($, e) => {
    const args = e.args.trim()
    const t = await stringsOf($)
    if (!args) {
      await $.ui.open({ id: PANE, title: 'Antigravity', focus: true })
      const health = await checkAgy($)
      await $.state.set(HEALTH, health)
      if (health.ok) await $.state.set(MODELS, await loadModels($))
      return { text: `${t.opened} ${health.message}` }
    }
    if (args === 'accounts' || args.startsWith('accounts add')) {
      const name = args.slice('accounts add'.length).trim()
      const dir = await profilesDirOf($)
      if (args.startsWith('accounts add')) {
        if (!/^[A-Za-z0-9_-]+$/.test(name) || name === MAIN) return { text: t.addUsage }
        if (!dir) return { text: t.noHome }
        await $.process.run(['mkdir', '-p', `${dir}/${name}`])
        return { text: `${t.created(`${dir}/${name}`)}\n\n  HOME="${dir}/${name}" agy\n\n${t.joins(Boolean(options.account_order))}` }
      }
      const all = await accountsOf($)
      const { rotation } = await settingsOf($)
      return {
        text: `${t.accountsHead(t.rot[rotation])}\n${all.map(n => `  ${n}${n === MAIN ? ` ${t.ownSignIn}` : `  ${dir}/${n}`}`).join('\n')}\n\n${t.addHint}`,
      }
    }
    if (args === 'usage') {
      await $.ui.open({ id: PANE, title: 'Antigravity' })
      const quota = await checkQuota($)
      const lines = quota.accounts.map(one =>
        one.gemini.left < 0 && one.other.left < 0
          ? `${one.name}: ${t.unreadable}`
          : `${one.name}: Gemini ${fmtLeft(one.gemini.left)}${one.gemini.resetAt ? ` (${t.resets} ${one.gemini.resetAt})` : ''} · Claude/GPT ${fmtLeft(one.other.left)}`)
      return { text: `${t.usageHead}\n${lines.join('\n')}` }
    }
    if (args === 'cancel') {
      const job = await cancelActive()
      return { text: job ? t.cancelled(job) : t.nothingRunning }
    }
    await $.ui.open({ id: PANE, title: 'Antigravity' })
    const ran = await $.tool.call({ tool: FULL_TOOL, prompt: args } as never)
    return { text: ran.deny ?? (typeof ran.result === 'string' ? ran.result : ran.text ?? 'agy finished.') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Markdown, Button } = elements
    // Mobile draws no pickers and the terminal no Svg: each falls back to text.
    // Named by surface: the element table answers every name, drawing nothing for one the surface lacks.
    const Select = e.surface === 'mobile' ? undefined : (elements as { Select?: ElementConstructor<SelectProps> }).Select
    const Svg = e.surface === 'terminal' ? undefined : (elements as { Svg?: ElementConstructor<SvgProps> }).Svg
    const t = await stringsOf($)
    const { value: list = [] } = await $.state.get(RUNS)
    const { value: health = null } = await $.state.get(HEALTH)
    const { value: quota = null } = await $.state.get(QUOTA)
    const { value: models = [] } = await $.state.get(MODELS)
    const { value: open = false } = await $.state.get(SETTINGS_OPEN)
    const { value: expanded = [] } = await $.state.get(EXPANDED)
    const { value: tick = 0 } = await $.state.get({ plugin: 'agy4claude', key: 'frame' } as const)
    const settings = await settingsOf($)
    const savings = await savingsOf($)
    const pool = poolOf(settings.model)
    const now = Date.now()
    lastRuns = list
    const run = list[list.length - 1]
    const live = run ? isLive(run) : false

    const caption = (text: string) => <Text size="caption" weight="semibold" dimColor>{text}</Text>

    // ---- header: mark, name, savings
    const todayUsd = savings.days[dayKey(now)] ?? 0
    const header = (
      <Box justifyContent="space-between" alignItems="center" gap={1}>
        <Box gap={1} alignItems="center" flexShrink={1} minWidth={0}>
          {Svg ? <Svg source={LOGO_SVG} alt="Antigravity" width={34} height={34} /> : <Text color="claude" bold>◉</Text>}
          <Box flexDirection="column" flexShrink={1} minWidth={0}>
            <Text weight="semibold">Antigravity</Text>
            <Text size="caption" dimColor wrap="truncate">{t.subtitle}{health?.ok ? ` · ${health.message}` : health ? '' : ` · ${t.checking}`}</Text>
          </Box>
        </Box>
        <Box flexShrink={0}>{Svg
          ? <Svg source={savingsSvg(t.saved, fmtUsd(savings.total), t.today(todayUsd.toFixed(2)))} alt={`${t.saved} ${fmtUsd(savings.total)}`} />
          : <Text color="warning">{t.saved} {fmtUsd(savings.total)} · {t.today(todayUsd.toFixed(2))}</Text>}</Box>
      </Box>
    )
    const healthLine = health && !health.ok ? <Text color="error" size="footnote" wrap="wrap">○ {health.message}</Text> : null

    // ---- the stage
    const planets = (quota?.accounts ?? []).map(a => ({ name: a.name, left: a[pool].left, current: a.name === run?.account }))
    const allSpent = planets.length > 0 && planets.every(p => p.left >= 0 && p.left <= options.min_quota)
    const mood = moodOf(run, allSpent, now)
    const status = statusLook(run, t)
    const elapsed = run ? fmtElapsed((run.endedAt ?? now) - run.startedAt) : ''
    const doing = run && live ? [...run.steps].reverse().find(s => s.state !== 'DONE') : undefined
    const toolCount = run ? run.steps.filter(s => s.type === 'tool').length : 0
    const stageStatus = !run
      ? (allSpent ? t.status.sleeping : t.status.idle)
      : `${status.label}${run.account ? ` · ${t.onAccount(run.account)}` : ''}`
    const stageSub = !run
      ? ''
      : live
        ? (doing ? t.step(toolCount, `${doing.tool ?? doing.type}${doing.summary ? ` ${oneLine(doing.summary, 24)}` : ''}`) : (run.phase ? (t.phase[run.phase] ?? `${run.phase}…`) : t.waiting))
        : t.toolsTokens(toolCount, run.usage ? fmtTokens(run.usage.total) : '–')
    if (Svg) stageSeenAt = now
    const stage = Svg ? (
      <Svg source={stageSvg({ mood, t: tick / FPS, planets, status: stageStatus, timer: run ? elapsed : '', sub: stageSub })}
        alt={`${stageStatus}${elapsed ? ` · ${elapsed}` : ''} · ${planets.map(p => `${p.name} ${fmtLeft(p.left)}`).join(', ')}`} />
    ) : (
      <Box flexDirection="column" borderStyle="round" borderColor={status.color} paddingX={1}>
        <Box justifyContent="space-between"><Text color={status.color} bold>{status.icon} {stageStatus}</Text><Text tabular>{elapsed}</Text></Box>
        {stageSub ? <Text dimColor wrap="truncate">{stageSub}</Text> : null}
        {planets.map(p => (
          <Box key={`acct-${p.name}`} gap={1}>
            <Box width={8}><Text bold={p.current} wrap="truncate">{p.name}</Text></Box>
            <Text mono color={p.left >= 0 && p.left <= 15 ? 'error' : p.left >= 0 && p.left <= 40 ? 'warning' : 'claude'}>{meterText(p.left)}</Text>
            <Text tabular>{fmtLeft(p.left)}</Text>
          </Box>
        ))}
      </Box>
    )
    const cancelRow = live ? (
      <Box justifyContent="flex-end">
        <Button key="cancel" variant="secondary" hotkey="c" onPress={() => { void cancelActive() }}>{t.cancel}</Button>
      </Box>
    ) : null

    // ---- the conversation: every run of the newest conversation, Claude's ask then Gemini's reply
    const thread = run
      ? (run.conversation ? list.filter(one => one.conversation === run.conversation || one.job === run.job) : [run])
      : []
    const bubble = (one: AgyRun, index: number) => {
      const asked = index === 0 ? t.claudeAsks : t.claudeFollows
      const oneLive = isLive(one)
      const full = one.response && one.response.trim()
        ? tidyReply(one.response.length > MAX_RESULT_SHOWN ? `…\n${one.response.slice(-MAX_RESULT_SHOWN)}` : one.response)
        : ''
      const lines = full.split('\n')
      const long = lines.length > FOLD_LINES || full.length > FOLD_CHARS
      const isOpen = expanded.includes(one.job)
      // Fold at whole lines only, so a link or a code span is never cut in half.
      const kept: string[] = []
      let used = 0
      for (const one of lines) {
        if (kept.length >= FOLD_LINES || (kept.length > 0 && used + one.length > FOLD_CHARS)) break
        kept.push(one)
        used += one.length + 1
      }
      const reply = long && !isOpen ? `${kept.join('\n').trimEnd()}\n\n…` : full
      const tail = tidyReply(one.text.split('\n').filter(l => l.trim()).slice(-6).join('\n'))
      const meta = [
        `${t.agentReplies}${one.account ? ` · ${t.onAccount(one.account)}` : ''}`,
        oneLive ? null : fmtElapsed((one.endedAt ?? now) - one.startedAt),
        one.savedUsd ? t.savedAbout(fmtUsd(one.savedUsd)) : null,
      ].filter(Boolean).join(' · ')
      return (
        <Box key={`turn-${one.job}`} flexDirection="column" gap={1}>
          <Box gap={1} alignItems="flex-start">
            {Svg ? <Svg source={CLAUDE_AVATAR} alt="Claude" width={26} height={26} /> : <Text color="claude">✻</Text>}
            <Box flexDirection="column" flexShrink={1}>
              <Text size="caption" dimColor>{asked} · {fmtAgo(one.startedAt, t)}</Text>
              <Box backgroundColor="#F6F5F3" paddingX={1}><Text color="#3F3F46" wrap="wrap">{one.prompt}</Text></Box>
            </Box>
          </Box>
          <Box gap={1} alignItems="flex-start">
            {Svg ? <Svg source={ROBOT_AVATAR} alt="Gemini" width={26} height={26} /> : <Text color="#6D5DF6">◉</Text>}
            <Box flexDirection="column" flexShrink={1} flexGrow={1}>
              <Text size="caption" dimColor wrap="truncate">{meta}</Text>
              <Box flexDirection="column" borderStyle="round" borderColor={one.status === 'error' ? 'error' : '#C7D2FE'} paddingX={1}>
                {reply
                  ? <Markdown text={reply} />
                  : <Text dimColor wrap="wrap">{oneLive ? (tail || t.waiting) : one.error ? '' : t.noOutput}</Text>}
                {one.error ? <Text color="error" wrap="wrap">✕ {one.error}</Text> : null}
                {long ? (
                  <Box>
                    <Button key={`fold-${one.job}`} plain
                      onPress={() => { void update($, expandedRuns, list => (list.includes(one.job) ? list.filter(j => j !== one.job) : [...list, one.job].slice(-20))) }}>
                      {isOpen ? t.showLess : t.showAll}
                    </Button>
                  </Box>
                ) : null}
              </Box>
            </Box>
          </Box>
        </Box>
      )
    }

    // ---- activity of the newest run
    const rows = Math.max(12, e.viewport?.rows ?? 40)
    const stepRoom = Math.max(4, Math.min(12, Math.floor(rows / 4)))
    const shownSteps = run ? run.steps.slice(-stepRoom) : []
    const hiddenSteps = run ? run.steps.length - shownSteps.length : 0
    const activity = run ? (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Box justifyContent="space-between" gap={1}>
          {caption(t.activity)}
          <Text size="caption" dimColor wrap="truncate">{toolCount === 0 ? (live ? t.noToolsYet : t.noTools) : t.toolCalls(toolCount)}{run.usage ? ` · ${fmtTokens(run.usage.total)} tokens` : ''}</Text>
        </Box>
        {hiddenSteps > 0 ? <Text size="caption" dimColor>⋯ {t.earlier(hiddenSteps)}</Text> : null}
        {shownSteps.map(step => (
          <Box key={`step-${step.index}`} gap={1}>
            <Text color={step.error ? 'error' : step.state === 'DONE' ? '#4F46E5' : '#6D5DF6'}>{step.error ? '✕' : step.state === 'DONE' ? '✓' : '▸'}</Text>
            <Text mono weight={step.state !== 'DONE' ? 'semibold' : 'regular'}>{step.tool ?? step.type}</Text>
            <Text dimColor wrap="truncate">{step.error ? `! ${step.error}` : step.summary ?? ''}</Text>
          </Box>
        ))}
      </Box>
    ) : null

    // ---- earlier conversations
    const seen = new Set<string>(thread.map(one => one.job))
    const history: AgyRun[] = []
    for (const one of [...list].reverse()) {
      if (seen.has(one.job)) continue
      if (one.conversation && history.some(h => h.conversation === one.conversation)) continue
      history.push(one)
      if (history.length >= 4) break
    }
    const historyBox = history.length > 0 ? (
      <Box flexDirection="column">
        {caption(t.history)}
        {history.map(one => {
          const past = statusLook(one, t)
          return (
            <Box key={`hist-${one.job}`} gap={1} justifyContent="space-between">
              <Box gap={1} flexShrink={1} minWidth={0}>
                <Text color={past.color}>{past.icon}</Text>
                <Text size="footnote" wrap="truncate">{oneLine(one.prompt, 80)}</Text>
              </Box>
              {/* The meta keeps its one line; the prompt gives way. */}
              <Box flexShrink={0}>
                <Text size="footnote" dimColor wrap="truncate">{one.account ? `@${one.account} · ` : ''}{fmtAgo(one.startedAt, t)}</Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    ) : null

    // ---- settings, folded into one line at the bottom
    const modelOptions = [
      { value: '', label: t.agyDefault },
      ...models,
      ...(settings.model && !models.some(m => m.value === settings.model) ? [{ value: settings.model, label: settings.model }] : []),
    ]
    const modelName = settings.model ? (models.find(m => m.value === settings.model)?.label ?? settings.model) : t.agyDefault
    const settingsBar = (
      <Box flexDirection="column" backgroundColor="#F4F4F5" paddingX={1}>
        <Box justifyContent="space-between" alignItems="center" gap={1}>
          <Text size="footnote" color="#52525B" wrap="truncate">⚙ {modelName}{settings.effort ? ` · ${settings.effort}` : ''} · {t.rotShort[settings.rotation]} · {t.langShort[settings.language]}</Text>
          <Button key="settings" plain onPress={() => { void $.state.set(SETTINGS_OPEN, !open) }}>{open ? t.close : t.settings}</Button>
        </Box>
        {open && Select ? (
          <Box flexDirection="column">
            <Select key="model" label={t.model} options={modelOptions} value={settings.model}
              onSelect={value => { void saveSetting($, { model: value }) }} />
            <Select key="effort" label={t.effort} options={[{ value: '', label: t.agyDefault }, ...EFFORTS.map(v => ({ value: v }))]} value={settings.effort}
              onSelect={value => { void saveSetting($, { effort: asEffort(value) }) }} />
            <Select key="rotation" label={t.rotation} value={settings.rotation}
              options={ROTATIONS.map(v => ({ value: v, label: t.rot[v] }))}
              onSelect={value => { void saveSetting($, { rotation: asRotation(value) }) }} />
            <Select key="language" label={t.language} value={settings.language}
              options={[{ value: 'auto', label: t.langAuto }, { value: 'en', label: 'English' }, { value: 'zh-TW', label: '繁體中文' }]}
              onSelect={value => { void saveSetting($, { language: asLanguage(value) }) }} />
          </Box>
        ) : null}
      </Box>
    )

    // The pane fills its room: history and settings sink to the bottom, a spacer takes what is left.
    const room = (e.props as { scroll?: { bodyRows?: number } }).scroll?.bodyRows
    return (
      <Box flexDirection="column" gap={1} minHeight={room && room > 0 ? room : undefined}>
        {header}
        {healthLine}
        {stage}
        {cancelRow}
        {run
          ? <Box flexDirection="column" gap={1}>{thread.map((one, i) => bubble(one, i))}</Box>
          : (
            <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
              <Text weight="semibold">{t.emptyTitle}</Text>
              <Text dimColor wrap="wrap">{t.emptyBody}</Text>
            </Box>
          )}
        {activity}
        <Box flexGrow={1} />
        {historyBox}
        {settingsBar}
      </Box>
    )
  })
}
