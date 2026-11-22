/** Host-facing structural types: the plugin only needs this slice of DSH. */
import type { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FeishuEvent } from './event.js'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  debug(message: string): void
}

export interface SessionControllerLike {
  create(request: {
    cwd?: string
    workspaceId?: string
    agentPreset?: string
  }): Promise<{ sessionId: string }>
  rename(request: { sessionId: string; title: string }): Promise<unknown>
  prompt(
    request: {
      requestId: string
      sessionId: string
      mode: 'queue'
      content: Array<{ type: 'text'; text: string }>
    },
    signal: AbortSignal,
  ): Promise<unknown>
  cancel(request: { sessionId: string }): unknown
  fork(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }>
  resolveAgent(sessionId: string): Promise<{ agent?: { inject(message: unknown): void } }>
  list?(request: unknown, signal: AbortSignal): Promise<{ items: Array<{ id: string; updatedAt?: number; projectionValues?: Record<string, unknown> }> }>
  projections?(request: unknown, signal: AbortSignal): Promise<unknown>
}

export interface SubprocessOutcome {
  exitCode: number | null
  signal: string | null
}

export interface SubprocessHandle {
  stdin: unknown
  stdout: Readable
  stderr: Readable
  done: Promise<SubprocessOutcome>
  collected?: {
    stdout?: { readFrom(offset: number): { text: string } }
    stderr?: { readFrom(offset: number): { text: string } }
  }
  terminate(): void
}

export interface SubprocessLike {
  resolveExecutable(name: string): Promise<string>
  spawn(request: {
    argv: string[]
    cwd?: string
    stdio?: { stdin?: unknown; stdout?: unknown; stderr?: unknown }
    graceMs?: number
  }): SubprocessHandle
}

export interface WorkspaceLike {
  readonly sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<void>
}

/** Minimal slice of the DSH subagent seam used for long-task delegation. */
export interface SubagentActivationLike {
  readonly childId: string
  readonly result: Promise<{ output: Array<{ type?: string; text?: string }>; stopReason?: string; diagnostic?: string }>
  dispose(): Promise<void>
}

export interface SubagentsLike {
  startActivation(spec: {
    provider: string
    parent: unknown
    prompt: Array<{ type: 'text'; text: string }>
    signal: AbortSignal
    delivery: 'parent' | 'caller'
    label?: string
    name?: string
  }): Promise<SubagentActivationLike>
}

export interface HostContext {
  logger: Logger
  get(name: string): unknown
  on(
    name: string,
    listener: (...args: any[]) => any,
    options?: { prepend?: boolean; global?: boolean },
  ): () => void
  effect(callback: () => (() => void) | void, label?: string): unknown
  subprocess: SubprocessLike
  sessionController: SessionControllerLike
  subagents?: SubagentsLike
  sessionProjections: { register(definition: unknown): Promise<unknown> }
  tools: { register(definition: Record<string, unknown>): () => void }
  sessions: { get(sessionId: string): unknown }
  permissionPresets: { set(session: unknown, name: string): void }
  webServer: { register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void }
}

/** The fields of a session/event the bridge consumes. */
export interface SessionEventLike {
  type: string
  time?: number
  data: {
    title?: string
    name?: string
    arguments?: unknown
    turn?: number
    message?: { content?: Array<{ type?: string; text?: string }> }
  }
}

export interface SessionLike {
  id: string
}

export type Job = { event: FeishuEvent; text: string; enqueuedAt: number }
