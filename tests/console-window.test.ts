import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLogBuffer, formatLogArgs } from '../server/log-buffer.js'
import { isAppWindowUrl } from '../electron/window-policy.js'
import { consoleWindowPlan, createHostSession, findAppBrowser, findCompanionExe, nativeWindowPlan, serverShouldOpenWindow, shouldOpenConsoleWindow, windowsMessageBoxPlan } from '../server/console-window.js'

describe('companion window launch', () => {
  it('opens only for the packaged Windows exe unless forced', () => {
    assert.equal(shouldOpenConsoleWindow({ packaged: false, platform: 'win32', argv: [], env: {} }), false)
    assert.equal(shouldOpenConsoleWindow({ packaged: true, platform: 'linux', argv: [], env: {} }), false)
    assert.equal(shouldOpenConsoleWindow({ packaged: true, platform: 'win32', argv: [], env: {} }), true)
    assert.equal(shouldOpenConsoleWindow({ packaged: true, platform: 'win32', argv: ['--no-window'], env: {} }), false)
    assert.equal(shouldOpenConsoleWindow({ packaged: true, platform: 'win32', argv: ['--add-obs-docks'], env: {} }), false)
    assert.equal(shouldOpenConsoleWindow({ packaged: false, platform: 'win32', argv: [], env: { RELAY_CONSOLE_WINDOW: '1' } }), true)
    assert.equal(shouldOpenConsoleWindow({ packaged: true, platform: 'win32', argv: [], env: { RELAY_NO_WINDOW: '1' } }), false)
    assert.equal(serverShouldOpenWindow({ packaged: true, platform: 'win32', argv: [], env: { RELAY_ELECTRON: '1' } }), false)
    assert.equal(serverShouldOpenWindow({ packaged: true, platform: 'win32', argv: [], env: {} }), true)
  })

  it('keeps only the console page inside the app window', () => {
    assert.equal(isAppWindowUrl('http://127.0.0.1:4173/console'), true)
    assert.equal(isAppWindowUrl('http://localhost:4173/console/'), true)
    assert.equal(isAppWindowUrl('http://[::1]:4173/console'), true)
    assert.equal(isAppWindowUrl('http://127.0.0.1:4173/'), false)
    assert.equal(isAppWindowUrl('http://127.0.0.1:4173/oauth/twitch'), false)
    assert.equal(isAppWindowUrl('http://127.0.0.1:4173/activity'), false)
    assert.equal(isAppWindowUrl('https://id.twitch.tv/oauth2/authorize'), false)
    assert.equal(isAppWindowUrl('not a url'), false)
  })

  it('prefers the companion exe so the taskbar icon is ours', () => {
    const exe = findCompanionExe(['C:\\app', 'C:\\app\\deploy'], (file) => file === 'C:\\app\\deploy\\relay-chat-dock-window.exe')
    assert.equal(exe, 'C:\\app\\deploy\\relay-chat-dock-window.exe')
    const plan = nativeWindowPlan(exe!, 'http://127.0.0.1:4173/console')
    assert.deepEqual(plan.args, ['--url', 'http://127.0.0.1:4173/console'])
    assert.equal(plan.options.windowsHide, true)
  })

  it('launches Edge or Chrome in app mode against a private profile', () => {
    const found = findAppBrowser({ BROWSER_PATH: 'C:\\Edge\\msedge.exe', PROGRAMFILES: 'C:\\Program Files' }, (file) => file.endsWith('msedge.exe'))
    assert.equal(found, 'C:\\Edge\\msedge.exe')
    const plan = consoleWindowPlan(found!, 'http://127.0.0.1:4173/console?host=1', 'C:\\Relay\\console-profile')
    assert.equal(plan.command, found)
    assert.equal(plan.args[0], '--app=http://127.0.0.1:4173/console?host=1')
    assert.equal(plan.args[1], '--user-data-dir=C:\\Relay\\console-profile')
    assert.equal(plan.options.windowsHide, true)
    assert.equal(plan.options.detached, true)
  })

  it('shows startup failures in a message box instead of a console pause', () => {
    const plan = windowsMessageBoxPlan('Already running on port 4173.', 'Relay Chat Dock')
    assert.equal(plan.command, 'powershell.exe')
    assert.match(plan.args.join(' '), /Already running on port 4173/)
    assert.equal(plan.options.windowsHide, true)
  })
})

describe('companion host session', () => {
  it('ignores a close until the window has checked in, and cancels on refresh', () => {
    const exits: number[] = []
    let scheduled: (() => void) | undefined
    const session = createHostSession(() => exits.push(1), 50, ((fn: () => void) => {
      scheduled = fn
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout, (() => { scheduled = undefined }) as typeof clearTimeout)
    assert.equal(session.bye(), false)
    session.hello()
    assert.equal(session.bye(), true)
    session.hello()
    assert.equal(scheduled, undefined)
    assert.equal(session.bye(), true)
    scheduled?.()
    assert.deepEqual(exits, [1])
  })
})

describe('companion log buffer', () => {
  it('keeps a ring of formatted lines and can wrap console', () => {
    const buffer = createLogBuffer(2)
    buffer.push('log', ['hello', { ok: true }])
    buffer.push('warn', ['careful'])
    buffer.push('error', ['boom'])
    assert.equal(buffer.lines().length, 2)
    assert.equal(buffer.lines()[0].level, 'warn')
    assert.match(formatLogArgs(['quota', 35]), /quota 35/)
    const seen: string[] = []
    const stop = buffer.subscribe((line) => seen.push(line.text))
    const target = { log() {}, info() {}, warn() {}, error() {} } as Console
    const restore = buffer.capture(target)
    target.log('from-console')
    restore()
    target.log('after')
    assert.deepEqual(seen, ['from-console'])
    assert.equal(buffer.since(buffer.lines()[0].id).at(-1)?.text, 'from-console')
  })
})
