'use strict'

/**
 * Preload bridge for the standalone Live2D window.
 *
 * The window page (served by the plugin host) needs exactly four OS-window
 * operations that a sandboxed renderer cannot perform itself:
 *   - resize the frameless window (drag the bottom-right grip)
 *   - move it by exact coordinates
 *   - minimise it to the taskbar (normal-window mode)
 *   - close it
 * Everything else (drag regions) is plain CSS app-region.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshLive2DWindow', {
  resizeTo: (width, height) => ipcRenderer.send('dsh-live2d:resize', { width, height }),
  moveTo: (x, y) => ipcRenderer.send('dsh-live2d:move', { x, y }),
  minimize: () => ipcRenderer.send('dsh-live2d:minimize'),
  close: () => ipcRenderer.send('dsh-live2d:close'),
  getBounds: () => ipcRenderer.invoke('dsh-live2d:bounds'),
})
