const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  loadTodos: () => ipcRenderer.invoke('todos:get'),
  saveTodos: (todos) => ipcRenderer.invoke('todos:set', todos),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  getRepoPaths: () => ipcRenderer.invoke('settings:getRepoPaths'),
  addRepoPath: (repoPath) => ipcRenderer.invoke('settings:addRepoPath', repoPath),
  removeRepoPath: (repoPath) => ipcRenderer.invoke('settings:removeRepoPath', repoPath),
  addScanBlacklist: (titles) => ipcRenderer.invoke('settings:addScanBlacklist', titles),

  scanRepos: () => ipcRenderer.invoke('repos:scan'),
  runGhSync: () => ipcRenderer.invoke('repos:runGhSync'),
  pullLocal: () => ipcRenderer.invoke('repos:pullLocal'),
  syncAll: () => ipcRenderer.invoke('repos:syncAll')
})
