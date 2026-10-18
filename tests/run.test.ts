import type { On, ProcessSpawnChunk } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const FULL_TOOL = 'mcp__agy4claude__run'
const OPTIONS = { agy_path: 'agy', default_cwd: '', model: '' }
const PANE_PROPS = { title: 'Antigravity', isFocused: false } as never

const line = (value: unknown) => `${JSON.stringify(value)}\n`
const out = (text: string): ProcessSpawnChunk => ({ stream: 'stdout', text })
const err = (text: string): ProcessSpawnChunk => ({ stream: 'stderr', text })
const version = { exitCode: 0, stdout: '1.3.3\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

/** What the engine itself answers beneath the plugin; the test stands in for it. */
const engineBottom = (on: On, { agyFound = true } = {}) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__agy4claude__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', () => {
    if (!agyFound) return { deny: 'ENOENT' }
    return { value: version }
  })
  mock.env(on, {})
  mock.store(on)
  mock.clock(on)
}

test('runs a prompt through agy, folds its stream-json output and shows the run in the pane', { options: OPTIONS }, async ($, on) => {
  engineBottom(on)
  let spawned: readonly string[] = []
  let spawnCwd: string | undefined = 'unset'

  on('process.spawn', async function* (_$, e) {
    spawned = e.argv
    spawnCwd = e.cwd
    // Pieces end wherever the child's write did: one holds several lines, the next starts mid-line.
    yield out(
      line({ event: 'init', init: { cwd: '/work' } }) +
      line({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 1, state: 'DONE', step_type: 'tool', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi' } } }) +
      '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":2,',
    )
    yield out('"state":"ACTIVE","step_type":"agent_response","text_delta":"Hello "}}\n')
    yield err('some warning\n')
    yield out(
      line({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'from agy' } }) +
      line({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'Hello from agy', duration_seconds: 1.2, num_turns: 1 } }),
    )
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const ran = await $.tool.call({ tool: FULL_TOOL, prompt: 'say hi', timeout_minutes: 5 } as never)
  expect(ran.deny).toBeUndefined()
  const text = String(ran.result)
  expect(text).toContain('agy done')
  expect(text).toContain('conversation conv-1')
  expect(text).toContain('tools: run_command')
  expect(text).toContain('Hello from agy')
  expect(text).not.toContain('ERROR')

  expect(spawned[0]).toBe('agy')
  expect(spawned).toContain('--output-format')
  expect(spawned).toContain('stream-json')
  expect(spawned).toContain('--dangerously-skip-permissions')
  expect(spawned[spawned.indexOf('--print-timeout') + 1]).toBe('5m')
  expect(spawned[spawned.length - 2]).toBe('-p')
  expect(spawned[spawned.length - 1]).toBe('say hi')
  expect(spawned).not.toContain('--conversation')
  expect(spawnCwd).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agy4claude', surface, component: 'Pane', requestId: 'agy', props: PANE_PROPS })
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /Done/ })).toBeDefined()
    else expect(await ui.find({ type: 'Svg', alt: /Done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /run_command/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Hello from agy/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /agy 1\.3\.3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /agent_response/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /1 tool call/ })).toBeDefined()
    await ui.unmount()
  }
})

test('continue_conversation resumes the last run and an explicit cwd is passed through', { options: { ...OPTIONS, default_cwd: '/repo', model: 'gemini-x' } }, async ($, on) => {
  engineBottom(on)
  const calls: { argv: readonly string[]; cwd?: string }[] = []

  on('process.spawn', async function* (_$, e) {
    calls.push({ argv: e.argv, cwd: e.cwd })
    yield out(line({ event: 'result', result: { conversation_id: `conv-${calls.length}`, status: 'SUCCESS', response: `answer ${calls.length}` } }))
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: FULL_TOOL, prompt: 'first' } as never)
  const second = await $.tool.call({ tool: FULL_TOOL, prompt: 'then this', continue_conversation: true, cwd: '/elsewhere' } as never)

  expect(String(second.result)).toContain('answer 2')
  expect(calls[0].cwd).toBe('/repo')
  expect(calls[0].argv).not.toContain('--conversation')
  expect(calls[0].argv[calls[0].argv.indexOf('--model') + 1]).toBe('gemini-x')
  expect(calls[1].cwd).toBe('/elsewhere')
  expect(calls[1].argv[calls[1].argv.indexOf('--conversation') + 1]).toBe('conv-1')
})

test('a non-zero exit without a result event is reported with stderr', { options: OPTIONS }, async ($, on) => {
  engineBottom(on)
  on('process.spawn', async function* () {
    yield out(line({ event: 'init', init: {} }))
    yield err('auth expired: run agy to sign in\n')
    return { value: { code: 2, signal: null } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: FULL_TOOL, prompt: 'anything' } as never)
  const text = String(ran.result)
  expect(text).toContain('agy error')
  expect(text).toContain('ERROR: agy exited with code 2')
  expect(text).toContain('auth expired')
})

test('an agy that cannot start answers the model with an error text instead of failing the call', { options: { ...OPTIONS, agy_path: '/nowhere/agy' } }, async ($, on) => {
  engineBottom(on, { agyFound: false })
  on('process.spawn', async function* () {
    return { deny: 'spawn /nowhere/agy ENOENT' }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: FULL_TOOL, prompt: 'anything' } as never)
  expect(ran.deny).toBeUndefined()
  expect(String(ran.result)).toContain('could not start agy (/nowhere/agy)')
  expect(String(ran.result)).toContain('ENOENT')

  const ui = await $.ui.mount({ plugin: 'agy4claude', surface: 'terminal', component: 'Pane', requestId: 'agy', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /agy not available/ })).toBeDefined()
  await ui.unmount()
})

test('every launch option becomes the matching agy flag, defaults coming from the plugin options', { options: { ...OPTIONS, effort: 'high', agent: 'reviewer', sandbox: true } }, async ($, on) => {
  engineBottom(on)
  const calls: (readonly string[])[] = []
  on('process.spawn', async function* (_$, e) {
    calls.push(e.argv)
    yield out(line({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: '{"ok":true}' } }))
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const explicit = await $.tool.call({
    tool: FULL_TOOL, prompt: 'plan it', mode: 'plan', effort: 'low', agent: 'planner', project: 'proj-1',
    add_dirs: ['/shared/lib', '/shared/docs'], json_schema: '{"type":"object"}', sandbox: false,
  } as never)
  const argv = calls[0]
  const after = (flag: string) => argv[argv.indexOf(flag) + 1]
  expect(after('--mode')).toBe('plan')
  expect(after('--effort')).toBe('low')
  expect(after('--agent')).toBe('planner')
  expect(after('--project')).toBe('proj-1')
  expect(after('--json-schema')).toBe('{"type":"object"}')
  expect(argv.filter(a => a === '--add-dir').length).toBe(2)
  expect(argv).toContain('/shared/docs')
  expect(argv).not.toContain('--sandbox')
  expect(argv[argv.length - 1]).toBe('plan it')
  expect(String(explicit.result)).toContain('mode plan')
  expect(String(explicit.result)).toContain('json-schema')

  await $.tool.call({ tool: FULL_TOOL, prompt: 'defaults' } as never)
  const plain = calls[1]
  expect(plain[plain.indexOf('--effort') + 1]).toBe('high')
  expect(plain[plain.indexOf('--agent') + 1]).toBe('reviewer')
  expect(plain).toContain('--sandbox')
  expect(plain).not.toContain('--mode')
  expect(plain).not.toContain('--json-schema')

  const bad = await $.tool.call({ tool: FULL_TOOL, prompt: 'x', mode: 'yolo' } as never)
  expect(String(bad.result)).toContain('mode must be one of')
  expect(calls.length).toBe(2)
})

test('when agy is not on PATH a well-known install location is found and used', { options: OPTIONS }, async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__agy4claude__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  mock.env(on, { HOME: '/Users/me' })
  mock.store(on)
  mock.clock(on)
  on('process.run', (_$, e) => (e.argv[0] === '/opt/homebrew/bin/agy' ? { value: version } : { deny: 'ENOENT' }))
  let spawnedWith = ''
  on('process.spawn', async function* (_$, e) {
    spawnedWith = e.argv[0]
    yield out(line({ event: 'result', result: { status: 'SUCCESS', response: 'hi' } }))
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const opened = await $.command.run({ command: 'agy', args: '' } as never)
  expect(String(opened.text)).toContain('agy 1.3.3 at /opt/homebrew/bin/agy')
  await $.tool.call({ tool: FULL_TOOL, prompt: 'hello' } as never)
  expect(spawnedWith).toBe('/opt/homebrew/bin/agy')
})

// ---- sign-ins ---------------------------------------------------------------

const usage = (weekly: number, fiveHour: number) => ({
  exitCode: 0,
  stdout:
    `Gemini Models\tWeekly Limit Remaining\t${weekly}%\t2026-10-25T14:00:00Z\n` +
    `Gemini Models\tFive Hour Limit Remaining\t${fiveHour}%\t2026-10-18T19:00:00Z\n` +
    'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-25T14:00:00Z\n',
  stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
})

const mkdirCalls: (readonly string[])[] = []

/** An engine with profiles b and c beside main; `left` is each sign-in's Gemini percent. */
const withProfiles = (on: On, left: Record<string, number>) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__agy4claude__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  mock.env(on, { HOME: '/Users/me' })
  mock.store(on)
  mock.clock(on)
  on('fs.list', (_$, e) => (e.path === '/Users/me/.agy-profiles'
    ? { value: [{ name: 'c', kind: 'dir', size: 0, mtimeMs: 0 }, { name: 'b', kind: 'dir', size: 0, mtimeMs: 0 }, { name: '.DS_Store', kind: 'file', size: 1, mtimeMs: 0 }] as never }
    : { deny: 'ENOENT' }))
  on('fs.exists', () => ({ value: false }))
  const usageCalls: string[] = []
  mkdirCalls.length = 0
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'mkdir') {
      mkdirCalls.push(e.argv)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[1] === 'models') {
      const stdout = 'Fetching available models...\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n'
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv.includes('/usage')) {
      const home = e.init?.env?.HOME ?? '/Users/me'
      const name = home === '/Users/me' ? 'main' : home.split('/').pop()!
      usageCalls.push(name)
      return { value: usage(left[name] ?? 100, left[name] ?? 100) }
    }
    return { value: version }
  })
  return usageCalls
}

test('runs rotate to the first sign-in with Gemini quota left, with HOME pointed at its profile', { options: OPTIONS }, async ($, on) => {
  withProfiles(on, { b: 3, c: 40, main: 90 })
  const homes: (string | undefined)[] = []
  const ssh: (string | undefined)[] = []
  on('process.spawn', async function* (_$, e) {
    homes.push(e.env?.HOME)
    ssh.push(e.env?.SSH_CONNECTION)
    yield out(line({ event: 'result', result: { conversation_id: 'conv-c', status: 'SUCCESS', response: 'ok' } }))
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const ran = await $.tool.call({ tool: FULL_TOOL, prompt: 'hi' } as never)
  expect(String(ran.result)).toContain('account c')
  expect(homes[0]).toBe('/Users/me/.agy-profiles/c')
  // A profile keeps its token in a file (agy does when it sees SSH), not in the OS keychain.
  expect(ssh[0]).toBeDefined()

  const pinned = await $.tool.call({ tool: FULL_TOOL, prompt: 'on main', account: 'main' } as never)
  expect(String(pinned.result)).toContain('account main')
  expect(homes[1]).toBeUndefined()
  expect(ssh[1]).toBeUndefined()

  const unknown = await $.tool.call({ tool: FULL_TOOL, prompt: 'x', account: 'zz' } as never)
  expect(String(unknown.result)).toContain('no agy sign-in named "zz"')

  const ui = await $.ui.mount({ plugin: 'agy4claude', surface: 'desktop', component: 'Pane', requestId: 'agy', props: PANE_PROPS })
  expect(await ui.find({ type: 'Svg', alt: /b 3%, c 40%, main 90%/ })).toBeDefined()
  await ui.unmount()
})

test('a run that runs out of quota is retried once on the next sign-in; a follow-up stays on its sign-in', { options: OPTIONS }, async ($, on) => {
  withProfiles(on, { b: 80, c: 80, main: 80 })
  const homes: (string | undefined)[] = []
  on('process.spawn', async function* (_$, e) {
    homes.push(e.env?.HOME)
    if (homes.length === 1) {
      yield out(line({ event: 'result', result: { status: 'ERROR', error: { message: 'RESOURCE_EXHAUSTED: quota exceeded' } } }))
      return { value: { code: 1, signal: null } }
    }
    yield out(line({ event: 'result', result: { conversation_id: `conv-${homes.length}`, status: 'SUCCESS', response: 'done' } }))
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: FULL_TOOL, prompt: 'work' } as never)
  expect(homes.slice(0, 2)).toEqual(['/Users/me/.agy-profiles/b', '/Users/me/.agy-profiles/c'])
  expect(String(ran.result)).toContain('agy done')
  expect(String(ran.result)).toContain('account c')

  // b was marked spent, and the follow-up resumes conv-2 on c rather than rotating.
  const again = await $.tool.call({ tool: FULL_TOOL, prompt: 'more', continue_conversation: true } as never)
  expect(homes[2]).toBe('/Users/me/.agy-profiles/c')
  expect(String(again.result)).toContain('account c')
})

test('when every sign-in is out of quota the run is refused, and /agy usage lists each one', { options: OPTIONS }, async ($, on) => {
  withProfiles(on, { b: 0, c: 2, main: 5 })
  let spawned = 0
  on('process.spawn', async function* () {
    spawned++
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: FULL_TOOL, prompt: 'x' } as never)
  expect(String(ran.result)).toContain('out of Gemini quota')
  expect(spawned).toBe(0)

  const listed = await $.command.run({ command: 'agy', args: 'usage' } as never)
  expect(String(listed.text)).toContain('b: Gemini 0%')
  expect(String(listed.text)).toContain('main: Gemini 5% (resets 2026-10-25T14:00:00Z)')
})

const okRun = (homes: (string | undefined)[]) => async function* (_$: unknown, e: { env?: Record<string, string> }) {
  homes.push(e.env?.HOME)
  yield out(line({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))
  return { value: { code: 0, signal: null } }
}
const short = (home: string | undefined) => (home ? home.split('/').pop() : 'main')

test('round-robin takes the next sign-in each run; most-left takes the fullest', { options: { ...OPTIONS, rotation: 'round-robin' } }, async ($, on) => {
  withProfiles(on, { b: 50, c: 90, main: 70 })
  const homes: (string | undefined)[] = []
  on('process.spawn', okRun(homes) as never)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 4; i++) await $.tool.call({ tool: FULL_TOOL, prompt: `r${i}` } as never)
  expect(homes.map(short)).toEqual(['b', 'c', 'main', 'b'])

  // The pane's Rotation picker changes it for later runs.
  const ui = await $.ui.mount({ plugin: 'agy4claude', surface: 'desktop', component: 'Pane', requestId: 'agy', props: PANE_PROPS })
  await ui.press({ key: 'settings' })
  await ui.select({ key: 'rotation', value: 'most-left' })
  await ui.unmount()
  await $.tool.call({ tool: FULL_TOOL, prompt: 'fullest' } as never)
  expect(short(homes[4])).toBe('c')
})

test('account_order sets which sign-ins are used and in what order', { options: { ...OPTIONS, account_order: 'main, c, nope' } }, async ($, on) => {
  withProfiles(on, { b: 90, c: 90, main: 3 })
  const homes: (string | undefined)[] = []
  on('process.spawn', okRun(homes) as never)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: FULL_TOOL, prompt: 'x' } as never)
  expect(short(homes[0])).toBe('c')
  const listed = await $.command.run({ command: 'agy', args: 'accounts' } as never)
  expect(String(listed.text)).toContain('main')
  expect(String(listed.text)).not.toContain('/b')
})

test('the pane pickers set model and effort for later runs; a Claude model is judged by its own quota pool', { options: OPTIONS }, async ($, on) => {
  withProfiles(on, { b: 90, c: 90, main: 90 })
  const calls: (readonly string[])[] = []
  on('process.spawn', async function* (_$, e) {
    calls.push(e.argv)
    yield out(line({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'agy', args: '' } as never) // loads the model list
  const ui = await $.ui.mount({ plugin: 'agy4claude', surface: 'desktop', component: 'Pane', requestId: 'agy', props: PANE_PROPS })
  await ui.press({ key: 'settings' })
  await ui.select({ key: 'model', value: 'claude-sonnet-4-6' })
  await ui.select({ key: 'effort', value: 'high' })
  await ui.unmount()
  await $.tool.call({ tool: FULL_TOOL, prompt: 'x' } as never)
  const argv = calls[0]!
  expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-4-6')
  expect(argv[argv.indexOf('--effort') + 1]).toBe('high')
  // A tool call's own model wins over the picker.
  await $.tool.call({ tool: FULL_TOOL, prompt: 'y', model: 'gemini-3.8-flash-low' } as never)
  expect(calls[1]![calls[1]!.indexOf('--model') + 1]).toBe('gemini-3.8-flash-low')
})

test('/agy accounts add makes the profile folder and says how to sign it in', { options: OPTIONS }, async ($, on) => {
  withProfiles(on, {})
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const added = await $.command.run({ command: 'agy', args: 'accounts add work2' } as never)
  expect(mkdirCalls[0]).toEqual(['mkdir', '-p', '/Users/me/.agy-profiles/work2'])
  expect(String(added.text)).toContain('HOME="/Users/me/.agy-profiles/work2" agy')
  const bad = await $.command.run({ command: 'agy', args: 'accounts add ../x' } as never)
  expect(String(bad.text)).toContain('Usage')
})

test('the Language picker switches the pane and the /agy replies to Traditional Chinese', { options: OPTIONS }, async ($, on) => {
  withProfiles(on, { b: 90, c: 90, main: 90 })
  on('process.spawn', async function* () {
    yield out(line({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: FULL_TOOL, prompt: 'x' } as never)
  let ui = await $.ui.mount({ plugin: 'agy4claude', surface: 'desktop', component: 'Pane', requestId: 'agy', props: PANE_PROPS })
  expect(await ui.find({ type: 'Svg', alt: /Done/ })).toBeDefined()
  await ui.press({ key: 'settings' })
  await ui.select({ key: 'language', value: 'zh-TW' })
  await ui.unmount()
  ui = await $.ui.mount({ plugin: 'agy4claude', surface: 'desktop', component: 'Pane', requestId: 'agy', props: PANE_PROPS })
  expect(await ui.find({ type: 'Svg', alt: /完成 · 帳號 b/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Gemini 回報/ })).toBeDefined()
  await ui.unmount()
  const listed = await $.command.run({ command: 'agy', args: 'accounts' } as never)
  expect(String(listed.text)).toContain('依序')
})

// ---- review fixes -----------------------------------------------------------

test('a run that ran out of quota after doing work is not run again on another sign-in', { options: OPTIONS }, async ($, on) => {
  withProfiles(on, { b: 80, c: 80, main: 80 })
  let spawns = 0
  on('process.spawn', async function* () {
    spawns++
    yield out(line({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_info: { name: 'edit_file', parameters: { path: 'a.ts' } } } }))
    yield out(line({ event: 'result', result: { status: 'ERROR', error: { message: 'RESOURCE_EXHAUSTED: quota exceeded' } } }))
    return { value: { code: 1, signal: null } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: FULL_TOOL, prompt: 'edit things' } as never)
  expect(spawns).toBe(1)
  expect(String(ran.result)).toContain('quota exceeded')
})

test('a second call while one is starting is turned away instead of starting a second agy', { options: OPTIONS }, async ($, on) => {
  withProfiles(on, { b: 80, c: 80, main: 80 })
  let spawns = 0
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  on('process.spawn', async function* () {
    spawns++
    await gate
    yield out(line({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const first = $.tool.call({ tool: FULL_TOOL, prompt: 'one' } as never)
  const second = await $.tool.call({ tool: FULL_TOOL, prompt: 'two' } as never)
  expect(String(second.result)).toContain('already in progress')
  release()
  expect(String((await first).result)).toContain('agy done')
  expect(spawns).toBe(1)
})

test('a run left marked live by a reload is closed out when the session starts again', { options: OPTIONS }, async ($, on) => {
  engineBottom(on)
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  on('process.spawn', async function* () {
    yield out(line({ event: 'init', init: {} }))
    await gate
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const pending = $.tool.call({ tool: FULL_TOOL, prompt: 'long job' } as never)
  await new Promise(resolve => setTimeout(resolve, 10))
  // What a hot reload does: session.start runs again while the record still says "running".
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'agy4claude', surface: 'terminal', component: 'Pane', requestId: 'agy', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /interrupted \(plugin reloaded\)/ })).toBeDefined()
  await ui.unmount()
  release()
  await pending
})

test('a long answer is folded behind a button that shows it whole', { options: OPTIONS }, async ($, on) => {
  engineBottom(on)
  const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
  on('process.spawn', async function* () {
    yield out(line({ event: 'result', result: { status: 'SUCCESS', response: long } }))
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const ran = await $.tool.call({ tool: FULL_TOOL, prompt: 'long' } as never)
  expect(String(ran.result)).toContain('line 30')
  const ui = await $.ui.mount({ plugin: 'agy4claude', surface: 'desktop', component: 'Pane', requestId: 'agy', props: PANE_PROPS })
  expect(await ui.find({ type: 'Markdown', text: /line 30/ })).toBeUndefined()
  const button = await ui.find({ type: 'Button', text: /Show the whole answer/ })
  expect(button).toBeDefined()
  await ui.press({ key: String((button as { key?: string }).key) })
  expect(await ui.find({ type: 'Markdown', text: /line 30/ })).toBeDefined()
  await ui.unmount()
})
