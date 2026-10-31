import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, Timer } from 'claude-code'

import type { Subagent, SubagentStatus, SubagentTokens } from '../types'

const PANE = 'subagents'
const TITLE = 'Subagents'
const TASK_CHARS = 300

// Change the tag when a row's fields change: it declines what an earlier version stored.
const agents = atom({ plugin: 'subagent-monitor', key: 'agents' } as const, [], { shape: 'agents-2' })
const now = atom({ plugin: 'subagent-monitor', key: 'now' } as const, 0)
const costUsd = atom({ plugin: 'subagent-monitor', key: 'costUsd' } as const, undefined)
const isCompact = atom({ plugin: 'subagent-monitor', key: 'isCompact' } as const, false)
const isFinishedCollapsed = atom({ plugin: 'subagent-monitor', key: 'isFinishedCollapsed' } as const, false)

const NO_TOKENS: SubagentTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

let tick: Timer | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'subagents',
      description: 'Show the subagents of this session in a side panel',
    })
    const list = await read($, agents)
    if (list.some(one => one.status === 'running')) {
      startTick($)
    }

    return next(e)
  })

  on('command.run', { command: 'subagents' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Subagents panel opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || started.agentId === undefined) {
      return started
    }

    const id = started.agentId
    const at = await $.clock.now()
    let isNew = false
    await update($, agents, list => {
      // A resume reuses the id: keep the row's task, tokens and start.
      if (list.some(one => one.id === id)) {
        return list.map(one => (one.id === id ? { ...one, status: 'running', endedAt: undefined } : one))
      }
      isNew = true
      const row: Subagent = {
        id,
        parentId: e.parentAgentId,
        description: e.description,
        type: e.subagentType,
        model: started.model,
        task: oneLine(e.prompt).slice(0, TASK_CHARS),
        status: 'running',
        startedAt: at,
        steps: 0,
        contextTokens: 0,
        tokens: NO_TOKENS,
      }

      return [...list, row]
    })
    await update($, now, () => at)
    if (isNew) {
      $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    }
    startTick($)

    return started
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const id = e.agentId
    const usage = step.usage
    if (id !== undefined && usage !== null) {
      const turnId = e.turnId
      const tool = step.toolUses.at(-1)?.name
      await update($, agents, list =>
        list.map(one =>
          one.id === id
            ? {
                ...one,
                model: usage.model,
                effort: e.effort ?? one.effort,
                status: 'running',
                endedAt: undefined,
                steps: one.steps + 1,
                lastTool: tool ?? one.lastTool,
                contextTokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
                steppedTurnId: turnId,
                tokens: addUsage(one.tokens, usage),
              }
            : one,
        ),
      )
      startTick($)
    }

    return step
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined) {
      return next(e)
    }

    const at = await $.clock.now()
    const isFailed = e.isAborted || e.reason !== 'answer'
    await update($, agents, list =>
      list.map(one => {
        if (one.id !== id) {
          return one
        }
        // A turn whose steps were counted already holds its tokens.
        const usage = one.steppedTurnId === e.turnId ? undefined : e.usage

        return {
          ...one,
          model: usage?.model ?? one.model,
          status: isFailed ? 'failed' : 'done',
          endedAt: at,
          tokens: usage === undefined ? one.tokens : addUsage(one.tokens, usage),
        }
      }),
    )
    await refresh($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, costUsd, () => e.cost?.usd)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
    const list = await read($, agents)
    const at = await read($, now)
    const usd = await read($, costUsd)
    const compact = await read($, isCompact)
    const finishedCollapsed = await read($, isFinishedCollapsed)
    const barCells = Math.max(10, e.props.bodyColumns - 14)

    if (list.length === 0) {
      return <Text dimColor>No subagents yet.</Text>
    }

    const total = list.reduce((sum, one) => addTokens(sum, one.tokens), NO_TOKENS)
    const firstStart = Math.min(...list.map(one => one.startedAt))
    const lastEnd = Math.max(...list.map(one => one.endedAt ?? at))
    const running = list.filter(one => one.status === 'running')
    const finished = list.filter(one => one.status !== 'running')
    // A row keeps its tone and figure by its place in the whole list.
    const look = new Map(list.map((one, index) => [one.id, index % TONES.length]))

    const tile = (label: string, value: string) => (
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="subtle" paddingX="sm">
        <Text size="caption" dimColor>
          {label}
        </Text>
        <Text size="heading" weight="semibold" tabular>
          {value}
        </Text>
      </Box>
    )

    const card = (one: Subagent, level: number) => {
      const index = look.get(one.id) ?? 0
      const tone = toneOf(index)
      const effort = effortTag(one.effort)
      const elapsed = (one.endedAt ?? at) - one.startedAt
      const fill = progress(one)

      return (
        <Box
          key={one.id}
          flexDirection="row"
          gap="md"
          marginLeft={level * 2}
          paddingX="sm"
          paddingY="sm"
          borderStyle="round"
          borderColor={one.status === 'running' ? tone.body : 'subtle'}
          overflow="hidden"
        >
          {Svg !== undefined && (
            <Svg
              source={figure(index, one.status)}
              alt={`${tone.name} Claude`}
              width={FIGURE_PX}
              height={FIGURE_PX}
              isInteractive
            />
          )}
          {/* minWidth 0 lets the column shrink below the bar's own width, so the bar fits the card. */}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Box flexDirection="row" justifyContent="space-between" gap="sm">
              <Text weight="semibold" wrap="truncate-end">
                {one.description}
              </Text>
              <Text color={statusColor(one)}>{statusMark(one)}</Text>
            </Box>
            <Text wrap="truncate-end">
              {effort !== undefined && <Text color={effort.color}>{effort.label} </Text>}
              <Text dimColor>
                {modelName(one.model)} · {one.type}
              </Text>
            </Text>
            <Box flexDirection="row" justifyContent="space-between" gap="sm">
              <Text size="footnote" wrap="truncate-end">
                {activity(one)}
              </Text>
              <Text size="footnote" dimColor tabular>
                ctx {count(one.contextTokens)} · {count(sumTokens(one.tokens))} tok · {clock(elapsed)}
              </Text>
            </Box>
            {Svg !== undefined ? (
              <Svg source={bar(fill, barColor(one, tone))} alt={`${Math.round(fill * 100)}%`} height={BAR_PX} />
            ) : (
              <Text>
                <Text color={barColor(one, tone)}>{'━'.repeat(Math.round(fill * barCells))}</Text>
                <Text dimColor>{'━'.repeat(barCells - Math.round(fill * barCells))}</Text>
              </Text>
            )}
            {!compact && (
              <Text size="footnote" dimColor wrap="truncate-end">
                {one.task}
              </Text>
            )}
          </Box>
        </Box>
      )
    }

    const group = (rows: Subagent[]) => treeOrder(rows).map(({ one, level }) => card(one, level))

    return (
      <Box flexDirection="column" gap="sm">
        <Box flexDirection="row" gap="sm">
          {tile('Cost', usd === undefined ? '$—' : `≈$${usd.toFixed(2)}`)}
          {tile('Tokens', count(sumTokens(total)))}
          {tile('Time', clock(lastEnd - firstStart))}
        </Box>
        <Text size="footnote" dimColor>
          {list.length} subagents · in {count(total.input)} · out {count(total.output)} · cache{' '}
          {count(total.cacheRead + total.cacheWrite)}
        </Text>
        <Box flexDirection="row">
          <Button
            key="compact"
            plain
            dimColor
            label={compact ? 'Expand' : 'Collapse'}
            onPress={() => {
              void update($, isCompact, value => !value)
            }}
          />
        </Box>
        {running.length > 0 && (
          <Box flexDirection="column" gap="sm">
            <Text dimColor>Running · {running.length}</Text>
            {group(running)}
          </Box>
        )}
        {finished.length > 0 && (
          <Box flexDirection="column" gap="sm">
            <Box flexDirection="row">
              <Button
                key="finished"
                plain
                dimColor
                label={`${finishedCollapsed ? '▸' : '▾'} Finished · ${finished.length}`}
                onPress={() => {
                  void update($, isFinishedCollapsed, value => !value)
                }}
              />
            </Box>
            {!finishedCollapsed && group(finished)}
          </Box>
        )}
      </Box>
    )
  })
}

function startTick($: EngineInterface): void {
  if (tick !== undefined) {
    return
  }
  tick = $.clock.every(1000, () => {
    void onTick($)
  })
}

async function onTick($: EngineInterface): Promise<void> {
  await refresh($)
  const list = await read($, agents)
  if (!list.some(one => one.status === 'running')) {
    tick?.cancel()
    tick = undefined
    // A spawn may have landed while the list was read.
    const again = await read($, agents)
    if (again.some(one => one.status === 'running')) {
      startTick($)
    }
  }
}

async function refresh($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  const usage = await $.session.usage()
  await update($, costUsd, () => usage.cost?.usd)
}

function addUsage(tokens: SubagentTokens, usage: ModelUsage): SubagentTokens {
  return addTokens(tokens, {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  })
}

function addTokens(a: SubagentTokens, b: SubagentTokens): SubagentTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

function sumTokens(tokens: SubagentTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

// Depth-first from the rows whose parent is the main agent or not in the group, so a child sits under its parent.
function treeOrder(list: Subagent[]): { one: Subagent; level: number }[] {
  const ids = new Set(list.map(one => one.id))
  const out: { one: Subagent; level: number }[] = []
  const visit = (one: Subagent, level: number): void => {
    out.push({ one, level })
    for (const child of list) {
      if (child.parentId === one.id && level < 8) {
        visit(child, level + 1)
      }
    }
  }
  for (const one of list) {
    if (one.parentId === undefined || !ids.has(one.parentId)) {
      visit(one, 0)
    }
  }

  return out
}

function statusMark(one: Subagent): string {
  if (one.status === 'running') {
    return '●'
  }

  return one.status === 'failed' ? '✕' : '✓'
}

function statusColor(one: Subagent): 'warning' | 'error' | 'success' {
  if (one.status === 'running') {
    return 'warning'
  }

  return one.status === 'failed' ? 'error' : 'success'
}

function activity(one: Subagent): string {
  const steps = `${one.steps} ${one.steps === 1 ? 'step' : 'steps'}`
  if (one.status === 'done') {
    return `${steps} · Done`
  }
  if (one.status === 'failed') {
    return `${steps} · Failed`
  }

  return one.lastTool === undefined ? `${steps} · Thinking` : `${steps} · ${one.lastTool}`
}

// Finished rows fill the bar; a running one creeps toward full with each step.
function progress(one: Subagent): number {
  if (one.status !== 'running') {
    return 1
  }

  return Math.min(0.9, Math.max(0.06, 1 - 0.88 ** one.steps))
}

function barColor(one: Subagent, tone: Tone): string {
  return one.status === 'failed' ? 'error' : tone.body
}

const EFFORTS: Record<string, { label: string; color: string }> = {
  low: { label: 'light', color: 'success' },
  medium: { label: 'medium', color: 'suggestion' },
  high: { label: 'careful', color: 'warning' },
  xhigh: { label: 'heavy', color: 'error' },
  max: { label: 'max', color: 'merged' },
}

function effortTag(effort: string | number | undefined): { label: string; color: string } | undefined {
  if (effort === undefined) {
    return undefined
  }
  if (typeof effort === 'number') {
    return { label: `effort ${effort}`, color: 'suggestion' }
  }

  return EFFORTS[effort] ?? { label: effort, color: 'suggestion' }
}

// claude-opus-5-5 → Opus 5.5; anything else as given.
function modelName(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model)
  const [, family = '', major, minor] = match ?? []
  if (family === '') {
    return model
  }

  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function count(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 10_000) {
    return `${Math.round(n / 1_000)}k`
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`
  }

  return String(n)
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// Figures: a pixel Clawd, its body in the row's tone, wearing the row's accessory.

type Tone = { name: string; body: string }

const TONES: Tone[] = [
  { name: 'Orange', body: '#D97757' },
  { name: 'Teal', body: '#3FA796' },
  { name: 'Blue', body: '#4A8FE7' },
  { name: 'Purple', body: '#9B6BDF' },
  { name: 'Pink', body: '#E26D9E' },
  { name: 'Green', body: '#5CAE5C' },
  { name: 'Amber', body: '#E0A030' },
  { name: 'Red', body: '#D9534F' },
]

function toneOf(index: number): Tone {
  return TONES[index % TONES.length] ?? TONES[0]!
}

const FIGURE_PX = 48
const BAR_PX = 6
const EYE = '#1A1A1A'

// 16 × 13 cells: B body, E eye, L and M the two pairs of legs that step in turn.
const BODY = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '...BBBBBBBBBB...',
  '...BBEBBBBEBB...',
  '.BBBBEBBBBEBBBB.',
  '.BBBBBBBBBBBBBB.',
  '...BBBBBBBBBB...',
  '...BBBBBBBBBB...',
  '....L.M..L.M....',
  '....L.M..L.M....',
]

// Drawn over the body by row: A, W and D take the accessory's three colors.
type Accessory = { rows: Record<number, string>; A: string; W?: string; D?: string }

const ACCESSORIES: Accessory[] = [
  // hard hat
  { rows: { 2: '.....AAAAAA.....', 3: '....AAAAAAAA....', 4: '..AAAAAAAAAAAA..' }, A: '#F5C542' },
  // headband
  { rows: { 4: '.............AA.', 5: '...AAAAAAAAAAA..', 6: '..............A.' }, A: '#E5484D' },
  // cap with visor
  { rows: { 3: '....AAAAAAA.....', 4: '...AAAAAAAAAAAA.' }, A: '#F2B035' },
  // beanie with pom
  { rows: { 1: '.......WW.......', 2: '.....AAAAAA.....', 3: '....AAAAAAAA....', 4: '...WWWWWWWWWW...' }, A: '#2BB3A3', W: '#F4F4F4' },
  // crown
  { rows: { 2: '...A...AA...A...', 3: '...AA.AAAA.AA...', 4: '...AAAAAAAAAA...' }, A: '#F5C542' },
  // headphones
  { rows: { 3: '...DDDDDDDDDD...', 4: '..D..........D..', 5: '.AA..........AA.', 6: '.AA..........AA.' }, A: '#F4F4F4', D: '#3A3A3A' },
  // wizard hat with star
  { rows: { 0: '.......A........', 1: '......AAA.......', 2: '.....AAWAA......', 3: '....AAAAAAA.....', 4: '..AAAAAAAAAAAA..' }, A: '#5B4BC4', W: '#F5C542' },
  // sunglasses
  { rows: { 6: '....DDDDDDDD....', 7: '....DDD..DDD....' }, A: '#000000', D: '#151515' },
]

// Every figure blinks; a running one walks and bobs fast, a finished one idles; each has its own pace.
function figure(index: number, status: SubagentStatus): string {
  const tone = toneOf(index)
  const gear = ACCESSORIES[index % ACCESSORIES.length] ?? ACCESSORIES[0]!
  const colors: Record<string, string | undefined> = { A: gear.A, W: gear.W, D: gear.D }
  const layers: Record<'body' | 'eyes' | 'gear' | 'L' | 'M', string[]> = { body: [], eyes: [], gear: [], L: [], M: [] }
  const cell = (x: number, y: number, fill: string) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`
  BODY.forEach((line, y) => {
    const over = gear.rows[y]
    for (let x = 0; x < line.length; x++) {
      const mark = line[x]
      if (mark === 'B' || mark === 'E') {
        // Body under the eyes too, so a blink shows skin.
        layers.body.push(cell(x, y, tone.body))
      }
      if (mark === 'E') {
        layers.eyes.push(cell(x, y, EYE))
      }
      if (mark === 'L' || mark === 'M') {
        layers[mark].push(cell(x, y, tone.body))
      }
      const extra = over?.[x]
      const fill = extra === undefined ? undefined : colors[extra]
      if (fill !== undefined) {
        layers.gear.push(cell(x, y, fill))
      }
    }
  })

  const pace = 1 + (index % 5) * 0.12
  const loop = 'repeatCount="indefinite"'
  const bob =
    status === 'failed'
      ? ''
      : `<animateTransform attributeName="transform" type="translate" values="0 0;0 -0.7;0 0" dur="${(status === 'running' ? 0.6 : 2.4) * pace}s" ${loop}/>`
  const blink = `<animate attributeName="opacity" values="1;0;1" keyTimes="0;0.94;0.98" calcMode="discrete" begin="${(index % 4) * 0.7}s" dur="${3.5 * pace}s" ${loop}/>`
  const step = (delay: number) =>
    status === 'running'
      ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0" keyTimes="0;0.5;1" calcMode="discrete" begin="${delay}s" dur="${0.5 * pace}s" ${loop}/>`
      : ''

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -1.5 16 16" width="${FIGURE_PX}" height="${FIGURE_PX}" shape-rendering="crispEdges">`,
    `<g>${step(0)}${layers.L.join('')}</g>`,
    `<g>${step(0.25 * pace)}${layers.M.join('')}</g>`,
    `<g>${bob}${layers.body.join('')}`,
    `<g>${blink}${layers.eyes.join('')}</g>`,
    `${layers.gear.join('')}</g>`,
    '</svg>',
  ].join('')
}

function bar(fill: number, color: string): string {
  const paint = THEME_HEX[color] ?? color
  const width = Math.round(fill * 1000)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 6" width="1000" height="${BAR_PX}" preserveAspectRatio="none"><rect width="1000" height="6" rx="3" fill="#8080804D"/><rect width="${width}" height="6" rx="3" fill="${paint}"/></svg>`
}

// An SVG cannot read the theme, so a theme key a bar names is painted as this hex.
const THEME_HEX: Record<string, string> = { error: '#E5484D' }
