import type { On, ProcessSpawnChunk } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const FULL_TOOL = 'mcp__agy-bridge__run'
const OPTIONS = { agy_path: 'agy', default_cwd: '', model: '' }
const PANE_PROPS = { title: 'Antigravity', isFocused: false } as never

const line = (value: unknown) => `${JSON.stringify(value)}\n`
const out = (text: string): ProcessSpawnChunk => ({ stream: 'stdout', text })
const err = (text: string): ProcessSpawnChunk => ({ stream: 'stderr', text })
const version = { exitCode: 0, stdout: '1.3.3\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

/** What the engine itself answers beneath the plugin; the test stands in for it. */
const engineBottom = (on: On, { agyFound = true } = {}) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__agy-bridge__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', () => {
    if (!agyFound) return { deny: 'ENOENT' }
    return { value: version }
  })
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
    const ui = await $.ui.mount({ plugin: 'agy-bridge', surface, component: 'Pane', requestId: 'agy', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /DONE/ })).toBeDefined()
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

  const ui = await $.ui.mount({ plugin: 'agy-bridge', surface: 'terminal', component: 'Pane', requestId: 'agy', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /agy not available/ })).toBeDefined()
  await ui.unmount()
})
