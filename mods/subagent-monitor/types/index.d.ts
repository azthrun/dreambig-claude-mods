export type SubagentTokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type SubagentStatus = 'running' | 'done' | 'failed'

export type Subagent = {
  id: string
  parentId?: string
  description: string
  type: string
  model: string
  /** The effort its last step ran at: a level or a number. */
  effort?: string | number
  task: string
  status: SubagentStatus
  startedAt: number
  endedAt?: number
  /** Model steps taken so far. */
  steps: number
  /** The last tool it called, if any. */
  lastTool?: string
  /** Prompt tokens of its last step: how full its context is. */
  contextTokens: number
  /** The last turn whose tokens were counted step by step, so its end adds none. */
  steppedTurnId?: string
  tokens: SubagentTokens
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-monitor': {
      agents: Shaped<Subagent[]>
      now: number
      costUsd: number | undefined
      isCompact: boolean
      isFinishedCollapsed: boolean
    }
  }
}
