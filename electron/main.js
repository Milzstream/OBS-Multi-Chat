import { app, BrowserWindow, dialog, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAppWindowUrl } from './window-policy.js'

process.env.RELAY_ELECTRON = '1'
process.env.RELAY_PACKAGED = app.isPackaged ? '1' : '0'

let windowRef

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 760,
    minHeight: 520,
    title: 'Relay Chat Dock',
    backgroundColor: '#111416',
    autoHideMenuBar: true,
    icon: path.join(app.getAppPath(), 'assets', 'app-icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  windowRef = win
  win.setMenuBarVisibility(false)
  win.webContents.setBackgroundThrottling(false)
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppWindowUrl(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })
  win.loadURL(`http://127.0.0.1:${port}/console`)
  win.on('closed', () => {
    if (windowRef === win) windowRef = undefined
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!windowRef) return
    if (windowRef.isMinimized()) windowRef.restore()
    windowRef.show()
    windowRef.focus()
  })
  app.whenReady().then(async () => {
    process.env.RELAY_APP_ROOT = app.getAppPath()
    const serverPath = path.join(app.getAppPath(), 'dist-server', 'server.js')
    const server = await import(pathToFileURL(serverPath).href)
    const port = await server.relayReady
    createWindow(port)
  }).catch((error) => {
    dialog.showErrorBox('Relay Chat Dock', error instanceof Error ? error.message : String(error))
    app.quit()
  })
  app.on('window-all-closed', () => app.quit())
}
