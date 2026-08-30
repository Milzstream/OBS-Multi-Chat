import fs from 'node:fs'
import path from 'node:path'

export type YouTubeChatMessage = {
  id: string
  user: string
  text: string
  userId?: string
  avatar?: string
  time: string
  badges?: { title: string; url?: string; label?: string }[]
  parts?: ({ type: 'text'; text: string } | { type: 'emote'; name: string; url: string })[]
  videoId: string
}

export type YouTubeChatTarget = { videoId: string; liveChatId?: string; label?: string }

type Session = { videoId: string; apiKey: string; clientVersion: string; continuation: string; visitorData?: string }

const BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
}

function browserPath() {
  const candidates = [
    process.env.KICK_BROWSER_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  return candidates.find((candidate) => candidate && fs.existsSync(candidate))
}

async function loadChromium() {
  try {
    const specifier = ['playwright', 'core'].join('-')
    const playwright = await import(specifier) as { chromium: { launch: (options: object) => Promise<any> } }
    return playwright.chromium
  } catch {
    return undefined
  }
}

function decodeHtml(value: string) {
  return value.replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\\//g, '/')
}

function extractSession(html: string, videoId: string): Session | undefined {
  if (/"isReplay"\s*:\s*true/.test(html)) return
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1]
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || html.match(/"clientVersion":"([\d.]+)"/)?.[1]
  const visitorData = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || html.match(/"visitorData":"([^"]+)"/)?.[1]
  const continuation = html.match(/"reloadContinuationData":\{"continuation":"([^"]+)"/)?.[1]
    || html.match(/"timedContinuationData":\{"continuation":"([^"]+)"/)?.[1]
    || html.match(/"invalidationContinuationData":\{"continuation":"([^"]+)"/)?.[1]
    || html.match(/"continuation":"([A-Za-z0-9_-]{50,})"/)?.[1]
  const canonical = html.match(/watch\?v=([a-zA-Z0-9_-]{11})/)?.[1]
  if (!apiKey || !clientVersion || !continuation) return
  return { videoId: canonical || videoId, apiKey, clientVersion, continuation, visitorData }
}

function extractVideoId(html: string) {
  if (/"isReplay"\s*:\s*true/.test(html) || /LIVE_STREAM_OFFLINE|This live event has ended/i.test(html)) return
  return html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([^"]+)"/)?.[1]
    || html.match(/"videoDetails":\{"videoId":"([a-zA-Z0-9_-]{11})"/)?.[1]
    || html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/)?.[1]
}

function parseYouTubeViewers(html: string) {
  const watching = html.match(/([\d,.]+)\s+watching now/i)?.[1]
  if (watching) return Number(watching.replace(/,/g, ''))
  const concurrent = html.match(/"concurrentViewers":"(\d+)"/)?.[1]
  if (concurrent) return Number(concurrent)
  const runs = html.match(/"viewCount":\{"runs":\[\{"text":"([\d,.]+)"/)?.[1]
  if (runs) return Number(runs.replace(/,/g, ''))
  const details = html.match(/"videoDetails":\{[^}]{0,400}"viewCount":"(\d+)"/)?.[1]
  if (details) return Number(details)
}

function runsToParts(runs: any[]): YouTubeChatMessage['parts'] {
  const parts: NonNullable<YouTubeChatMessage['parts']> = []
  for (const run of runs || []) {
    if (run?.text) parts.push({ type: 'text', text: String(run.text) })
    else if (run?.emoji) {
      const url = run.emoji.image?.thumbnails?.slice(-1)[0]?.url || run.emoji.image?.thumbnails?.[0]?.url
      const name = run.emoji.shortcuts?.[0] || run.emoji.emojiId || 'emoji'
      if (url) parts.push({ type: 'emote', name: String(name), url: String(url) })
      else if (run.emoji.emojiId) parts.push({ type: 'text', text: String(run.emoji.emojiId) })
    }
  }
  return parts
}

function authorBadges(renderer: any): YouTubeChatMessage['badges'] {
  const badges: NonNullable<YouTubeChatMessage['badges']> = []
  for (const entry of renderer?.authorBadges || []) {
    const badge = entry.liveChatAuthorBadgeRenderer
    if (!badge) continue
    const icon = String(badge.icon?.iconType || '')
    if (icon === 'OWNER') badges.push({ title: 'Owner', label: 'HOST' })
    else if (icon === 'MODERATOR') badges.push({ title: 'Moderator', label: 'MOD' })
    else if (icon === 'VERIFIED') badges.push({ title: 'Verified', label: '✓' })
    else if (badge.customThumbnail) badges.push({ title: badge.tooltip || 'Member', label: 'MEM', url: badge.customThumbnail.thumbnails?.slice(-1)[0]?.url })
  }
  return badges
}

function parseActions(payload: any, videoId: string, ignoreBefore = 0): YouTubeChatMessage[] {
  const actions = payload?.continuationContents?.liveChatContinuation?.actions || payload?.actions || []
  const messages: YouTubeChatMessage[] = []
  for (const action of actions) {
    const item = action.addChatItemAction?.item
    const renderer = item?.liveChatTextMessageRenderer || item?.liveChatPaidMessageRenderer || item?.liveChatPaidStickerRenderer
    if (!renderer) continue
    const paid = renderer.purchaseAmountText?.simpleText ? `[${renderer.purchaseAmountText.simpleText}] ` : ''
    const parts = runsToParts(renderer.message?.runs || renderer.headerSubtext?.runs || [])
    const text = `${paid}${parts?.filter((part) => part.type === 'text').map((part) => part.text).join('') || ''}`.trim()
    const time = renderer.timestampUsec ? new Date(Number(renderer.timestampUsec) / 1000).toISOString() : new Date().toISOString()
    if (ignoreBefore && Date.parse(time) < ignoreBefore) continue
    if (!text && !parts?.some((part) => part.type === 'emote')) continue
    messages.push({
      id: String(renderer.id || `${videoId}-${renderer.timestampUsec || Date.now()}`),
      user: String(renderer.authorName?.simpleText || 'YouTube user').replace(/^@+/, ''),
      text: text || ' ',
      userId: renderer.authorExternalChannelId,
      avatar: renderer.authorPhoto?.thumbnails?.slice(-1)[0]?.url,
      time,
      badges: authorBadges(renderer),
      parts,
      videoId,
    })
  }
  return messages
}

function nextContinuation(payload: any): { continuation?: string; timeoutMs: number; ended: boolean } {
  const items = payload?.continuationContents?.liveChatContinuation?.continuations || []
  for (const item of items) {
    const data = item.timedContinuationData || item.invalidationContinuationData || item.liveChatReplayContinuationData
    if (data?.continuation) return { continuation: data.continuation, timeoutMs: Number(data.timeoutMs || 5000), ended: false }
  }
  if (!items.length) return { ended: true, timeoutMs: 8000 }
  return { ended: false, timeoutMs: 8000 }
}

async function fetchHtml(url: string) {
  try {
    const response = await fetch(url, { headers: BROWSER_HEADERS })
    if (!response.ok) return
    return decodeHtml(await response.text())
  } catch {
    return
  }
}

async function fetchHtmlWithBrowser(url: string) {
  const executablePath = browserPath()
  const chromium = await loadChromium()
  if (!executablePath || !chromium) return
  let browser: any
  try {
    browser = await chromium.launch({ headless: true, executablePath })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, userAgent: BROWSER_HEADERS['User-Agent'] })
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return decodeHtml(await page.content())
  } catch (error) {
    console.error('YouTube chat page:', error instanceof Error ? error.message : error)
    return
  } finally {
    await browser?.close()
  }
}

function extractInitialPayload(html: string) {
  const marker = html.search(/ytInitialData["']?\s*=\s*\{/)
  if (marker < 0) return
  const brace = html.indexOf('{', marker)
  if (brace < 0) return
  let depth = 0
  for (let i = brace; i < html.length && i - brace < 2_000_000; i++) {
    const char = html[i]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(html.slice(brace, i + 1)) } catch { return }
      }
    }
  }
}

async function loadLivePage(videoId: string) {
  for (const url of [
    `https://www.youtube.com/live_chat?is_popout=1&v=${encodeURIComponent(videoId)}`,
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
  ]) {
    const html = await fetchHtml(url) || await fetchHtmlWithBrowser(url)
    if (!html) continue
    const session = extractSession(html, videoId)
    if (!session) continue
    const initial = extractInitialPayload(html)
    return { session, bootstrap: initial ? parseActions(initial, session.videoId) : [] }
  }
}

async function pollLiveChat(session: Session) {
  const response = await fetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false&key=${encodeURIComponent(session.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: session.clientVersion,
          hl: 'en',
          gl: 'US',
          ...(session.visitorData ? { visitorData: session.visitorData } : {}),
        },
      },
      continuation: session.continuation,
    }),
  })
  if (!response.ok) throw new Error(`InnerTube live chat ${response.status}`)
  return response.json() as Promise<any>
}

export class YouTubeLiveChat {
  private loops = new Map<string, { stop: () => void }>()
  private onMessage?: (message: YouTubeChatMessage, target: YouTubeChatTarget) => void
  private closed = true
  private lastOk = 0
  private failures = 0
  private key = ''

  get connected() { return !this.closed && this.loops.size > 0 && Date.now() - this.lastOk < 45_000 }
  get failed() { return !this.closed && this.loops.size > 0 && this.failures >= 3 && Date.now() - this.lastOk > 20_000 }

  async start(targets: YouTubeChatTarget[], onMessage: (message: YouTubeChatMessage, target: YouTubeChatTarget) => void) {
    this.onMessage = onMessage
    this.closed = false
    const nextKey = targets.map((target) => target.videoId).sort().join(',')
    const current = [...this.loops.keys()].sort().join(',')
    if (nextKey === current && nextKey) return
    this.key = nextKey
    const keep = new Set(targets.map((target) => target.videoId))
    for (const videoId of [...this.loops.keys()]) if (!keep.has(videoId)) this.loops.get(videoId)?.stop()
    for (const target of targets) if (!this.loops.has(target.videoId)) this.spawn(target)
    if (!targets.length) this.clearLoops()
  }

  async stop() {
    this.closed = true
    this.onMessage = undefined
    this.key = ''
    this.failures = 0
    this.clearLoops()
  }

  async discoverLive(input: { channelId?: string; handle?: string }) {
    const urls: string[] = []
    if (input.channelId) urls.push(`https://www.youtube.com/channel/${encodeURIComponent(input.channelId)}/live`)
    const handle = input.handle?.replace(/^@+/, '').trim()
    if (handle && !handle.includes(' ') && handle.toLowerCase() !== 'youtube') urls.push(`https://www.youtube.com/@${encodeURIComponent(handle)}/live`)
    for (const url of urls) {
      const html = await fetchHtml(url) || await fetchHtmlWithBrowser(url)
      if (!html) continue
      const videoId = extractVideoId(html)
      if (videoId) return { videoId, viewers: parseYouTubeViewers(html) }
    }
  }

  async viewers(videoId: string) {
    const html = await fetchHtml(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`)
      || await fetchHtmlWithBrowser(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`)
    if (!html) return
    return parseYouTubeViewers(html)
  }

  private spawn(target: YouTubeChatTarget) {
    let stopped = false
    const stop = () => {
      stopped = true
      this.loops.delete(target.videoId)
    }
    this.loops.set(target.videoId, { stop })
    void this.run(target, () => stopped || this.closed)
  }

  private async run(target: YouTubeChatTarget, stopped: () => boolean) {
    while (!stopped()) {
      try {
        const loaded = await loadLivePage(target.videoId)
        if (!loaded) throw new Error('live chat page missing continuation')
        const { session } = loaded
        this.failures = 0
        this.lastOk = Date.now()
        for (const message of loaded.bootstrap) this.onMessage?.(message, target)
        while (!stopped()) {
          const payload = await pollLiveChat(session)
          const messages = parseActions(payload, target.videoId)
          for (const message of messages) this.onMessage?.(message, target)
          const next = nextContinuation(payload)
          if (next.ended || !next.continuation) throw new Error('live chat ended')
          session.continuation = next.continuation
          this.lastOk = Date.now()
          this.failures = 0
          await wait(Math.min(15_000, Math.max(4_000, next.timeoutMs || 8_000)))
        }
      } catch (error) {
        if (stopped()) return
        this.failures += 1
        console.error(`YouTube InnerTube (${target.videoId}):`, error instanceof Error ? error.message : error)
        await wait(Math.min(20_000, 2_000 * 2 ** Math.min(this.failures, 4)))
      }
    }
  }

  private clearLoops() {
    const loops = [...this.loops.values()]
    this.loops.clear()
    for (const loop of loops) loop.stop()
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
