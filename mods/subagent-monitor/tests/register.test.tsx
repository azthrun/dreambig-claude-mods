import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'subagent-monitor',
  component: 'Pane',
  requestId: 'subagents',
  props: {
    title: 'Subagents',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SPAWN = {
  tool_use_id: 'tu1',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
} as const

const USAGE = {
  model: 'claude-haiku-5-5',
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 0,
}

test('a spawn opens the panel and its steps, end and session cost show in it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: {} as never, rateLimits: [], cost: { usd: 1.5 } },
  }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [{ name: 'Grep', input: {} }],
      stopReason: 'tool_use' as const,
      usage: USAGE,
    }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    ...SPAWN,
    prompt: 'Find every caller of\n  parseConfig and report them',
    description: 'Find callers',
    subagentType: 'Explore',
  })
  expect(opened).toEqual(['subagents'])

  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', effort: 'high', messageCount: 1, agentId: 'a1' })
  for await (const _ of step) {
    // drain
  }
  await clock.advance(65_000)
  await $.turn.complete({
    turnId: 't1',
    answer: 'done',
    durationMs: 65_000,
    isAborted: false,
    reason: 'answer',
    agentId: 'a1',
    usage: USAGE,
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^≈\$/ }))?.text).toBe('≈$1.50')
    // The step's tokens counted once: the end's usage is not added again.
    expect((await ui.find({ type: 'Text', text: /^3\.5k$/ }))?.text).toBe('3.5k')
    expect((await ui.find({ type: 'Text', text: /^1:05$/ }))?.text).toBe('1:05')
    expect((await ui.find({ type: 'Text', text: /^Find callers$/ }))?.text).toBe('Find callers')
    expect((await ui.find({ type: 'Text', text: /Haiku 5\.5/ }))?.text).toBe('careful Haiku 5.5 · Explore')
    expect((await ui.find({ type: 'Text', text: /steps? ·/ }))?.text).toBe('1 step · Done')
    expect((await ui.find({ type: 'Text', text: /^ctx/ }))?.text).toBe('ctx 3.0k · 3.5k tok · 1:05')
    expect((await ui.find({ type: 'Text', text: /parseConfig/ }))?.text).toBe('Find every caller of parseConfig and report them')
    await ui.unmount()
  }
})

test('a turn with no steps seen takes its tokens from its end', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {} as never, rateLimits: [] } }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a2' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ ...SPAWN, prompt: 'Review', description: 'Review diff', subagentType: 'general-purpose' })
  await $.turn.complete({
    turnId: 't2',
    answer: '',
    durationMs: 0,
    isAborted: false,
    reason: 'error',
    agentId: 'a2',
    usage: USAGE,
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^\$/ }))?.text).toBe('$—')
  expect((await ui.find({ type: 'Text', text: /^3\.5k$/ }))?.text).toBe('3.5k')
  expect((await ui.find({ type: 'Text', text: /steps? ·/ }))?.text).toBe('0 steps · Failed')
  expect((await ui.find({ type: 'Text', text: /^✕$/ }))?.text).toBe('✕')
  await ui.unmount()
})

test('a resume keeps the row, and a child is drawn under its own parent', async ($, on) => {
  mock.clock(on, { now: 0 })
  const ids = ['A', 'B', 'A1', 'A']
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {} as never, rateLimits: [] } }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: ids.shift() }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ ...SPAWN, prompt: 'a', description: 'Agent A', subagentType: 'Explore' })
  await $.agent.spawn({ ...SPAWN, prompt: 'b', description: 'Agent B', subagentType: 'Explore' })
  await $.agent.spawn({ ...SPAWN, prompt: 'a1', description: 'Agent A1', subagentType: 'Explore', parentAgentId: 'A' })
  await $.turn.complete({ turnId: 'tA', answer: '', durationMs: 0, isAborted: false, reason: 'answer', agentId: 'A', usage: USAGE })
  await $.agent.spawn({ ...SPAWN, prompt: '', description: 'resumed', subagentType: 'Explore', resume: { agentId: 'A' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = (await ui.findAll({ type: 'Text', text: /^Agent / })).map(one => one.text)
  expect(rows).toEqual(['Agent A', 'Agent A1', 'Agent B'])
  expect((await ui.find({ type: 'Text', text: /^Running/ }))?.text).toBe('Running · 3')
  expect((await ui.find({ type: 'Text', text: /^3\.5k$/ }))?.text).toBe('3.5k')
  await ui.unmount()
})

test('Collapse hides tasks, and the Finished group folds', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {} as never, rateLimits: [] } }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'c1' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ ...SPAWN, prompt: 'Scan the repo', description: 'Scanner', subagentType: 'Explore' })
  await $.turn.complete({ turnId: 'tc', answer: '', durationMs: 0, isAborted: false, reason: 'answer', agentId: 'c1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Scan the repo/ }))?.text).toBe('Scan the repo')
  await ui.press({ key: 'compact' })
  expect(await ui.find({ type: 'Text', text: /Scan the repo/ })).toBeUndefined()
  await ui.press({ key: 'finished' })
  expect(await ui.find({ type: 'Text', text: /^Scanner$/ })).toBeUndefined()
  await ui.unmount()
})
