export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const NULL_BODY = new Set([101, 204, 205, 304])

function timeoutError(ms: number) {
  return new Error(`Request timed out after ${ms}ms`)
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

type BodyReader = ReadableStreamDefaultReader<Uint8Array>

function armBody(body: ReadableStream<Uint8Array>, signal: AbortSignal, ms: number, finish: () => void) {
  const mutable = body as ReadableStream<Uint8Array> & {
    getReader: (...args: never[]) => BodyReader
    cancel: (reason?: unknown) => Promise<void>
  }
  const originalGetReader = mutable.getReader.bind(mutable)
  const originalCancel = mutable.cancel.bind(mutable)
  const fail = () => {
    finish()
    throw timeoutError(ms)
  }
  mutable.cancel = (reason) => {
    finish()
    return originalCancel(reason)
  }
  mutable.getReader = ((...args: never[]) => {
    if (signal.aborted) fail()
    const reader = originalGetReader(...args)
    const originalRead = reader.read.bind(reader) as () => Promise<ReadableStreamReadResult<Uint8Array>>
    const originalReaderCancel = reader.cancel.bind(reader)
    reader.read = (async () => {
      if (signal.aborted) fail()
      try {
        const result = await originalRead()
        if (signal.aborted) fail()
        if (result.done) finish()
        return result
      } catch (error) {
        finish()
        if (signal.aborted || isAbortError(error)) throw timeoutError(ms)
        throw error
      }
    }) as typeof reader.read
    reader.cancel = (reason) => {
      finish()
      return originalReaderCancel(reason)
    }
    return reader
  }) as typeof mutable.getReader
  if (signal.aborted) finish()
  else signal.addEventListener('abort', () => finish(), { once: true })
}

export async function fetchTimed(url: string, options: RequestInit = {}, ms = 8_000, fetchImpl: FetchLike = fetch) {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ms)
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    clearTimeout(timer)
  }
  try {
    const response = await fetchImpl(url, { ...options, signal: abort.signal })
    if (!response.body || NULL_BODY.has(response.status)) {
      finish()
      return response
    }
    armBody(response.body, abort.signal, ms, finish)
    return response
  } catch (error) {
    finish()
    if (abort.signal.aborted || isAbortError(error)) throw timeoutError(ms)
    throw error
  }
}
