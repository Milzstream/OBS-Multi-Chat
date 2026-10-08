import { formatWithOptions } from 'node:util'

/**
 * In-memory ring the companion window reads over SSE. `log-file.ts` writes the
 * same lines to disk (secrets redacted) so a crash still leaves a trace.
 */
export type LogLevel = 'log' | 'info' | 'warn' | 'error'
export type LogLine = { id: number; time: string; level: LogLevel; text: string }

const LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error']

export function formatLogArgs(args: unknown[]) {
  if (!args.length) return ''
  return formatWithOptions({ colors: false }, ...(args as [unknown, ...unknown[]]))
}

export function createLogBuffer(max = 1500) {
  const lines: LogLine[] = []
  const listeners = new Set<(line: LogLine) => void>()
  let nextId = 1

  function push(level: LogLevel, args: unknown[]) {
    const line: LogLine = { id: nextId++, time: new Date().toISOString(), level, text: formatLogArgs(args) }
    lines.push(line)
    if (lines.length > max) lines.splice(0, lines.length - max)
    for (const listener of listeners) listener(line)
    return line
  }

  function capture(target: Console = console) {
    const original = {
      log: target.log.bind(target),
      info: target.info.bind(target),
      warn: target.warn.bind(target),
      error: target.error.bind(target),
    }
    for (const level of LEVELS) {
      const write = original[level]
      target[level] = (...args: unknown[]) => {
        push(level, args)
        try { write(...args) } catch { /* packaged GUI builds have no console */ }
      }
    }
    return () => {
      target.log = original.log
      target.info = original.info
      target.warn = original.warn
      target.error = original.error
    }
  }

  return {
    push,
    capture,
    lines: () => lines.slice(),
    since: (id: number) => lines.filter((line) => line.id > id),
    subscribe(listener: (line: LogLine) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
