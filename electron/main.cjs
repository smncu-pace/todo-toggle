const path = require('path')
const fs = require('fs/promises')
const os = require('os')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { randomUUID } = require('crypto')
const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron')
const { isGhSyncConflict, recoverForkConflict } = require('./repo-sync.cjs')

const execFileAsync = promisify(execFile)

/**
 * 可改配置：
 */
const GLOBAL_TOGGLE_HOTKEY = 'CommandOrControl+T' // mac 上就是 ⌘T
const WINDOW_WIDTH = 1120
const WINDOW_HEIGHT = 820
const ALWAYS_ON_TOP = true
const HIDE_DOCK_ICON_ON_MAC = true
const DEFAULT_BRANCH = 'main'
const COMMAND_TIMEOUT_MS = 180000

// 只在打包后的 App 里尝试开机自启动（开发模式路径会变）
const OPEN_AT_LOGIN = true

const GITHUB_OWNER = 'smncu-pace'

let mainWindow = null
let store = null
let isQuitting = false

function nowIso() {
  return new Date().toISOString()
}

function asTrimmedString(v) {
  return String(v || '').trim()
}

function asErrorMessage(e, fallback = 'unknown error') {
  return String(e?.message || e || fallback)
}

function getRepoSpecs() {
  return getRepoPathsFromStore().map((repoPath) => ({
    repoPath,
    repoName: path.basename(repoPath)
  }))
}

function countByStatus(items, status) {
  if (!Array.isArray(items)) return 0
  return items.filter((item) => item?.status === status).length
}

function buildCommandEnv() {
  const currentPath = String(process.env.PATH || '')
  const extraPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  const merged = [...extraPaths, ...currentPath.split(':').filter(Boolean)]
  const unique = Array.from(new Set(merged))
  return {
    ...process.env,
    PATH: unique.join(':')
  }
}

function ensureTodoShape(todo) {
  if (!todo || typeof todo !== 'object') return null
  const text = typeof todo.text === 'string' ? todo.text.trim() : ''
  if (!text) return null

  const done = !!todo.done
  const createdAt = Number.isFinite(todo.createdAt) ? todo.createdAt : Date.now()
  const source = todo.source === 'repo-scan' ? 'repo-scan' : 'manual'
  const pushState = todo.pushState === 'pending' || todo.pushState === 'pushed'
    ? todo.pushState
    : 'none'

  let meta = null
  if (source === 'repo-scan' && todo.meta && typeof todo.meta === 'object') {
    meta = {
      repoName: typeof todo.meta.repoName === 'string' ? todo.meta.repoName : '',
      folderName: typeof todo.meta.folderName === 'string' ? todo.meta.folderName : '',
      folderPath: typeof todo.meta.folderPath === 'string' ? todo.meta.folderPath : ''
    }
  }

  return {
    id: typeof todo.id === 'string' && todo.id ? todo.id : randomUUID(),
    text,
    done,
    createdAt,
    source,
    meta,
    pushState
  }
}

function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map(ensureTodoShape).filter(Boolean)
}

function expandUserPath(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  return raw
}

async function resolveRepoPath(input) {
  const expanded = expandUserPath(input)
  const resolved = path.resolve(expanded)
  const stat = await fs.stat(resolved)

  if (!stat.isDirectory()) {
    throw new Error('路径存在，但不是目录')
  }

  const gitStat = await fs.stat(path.join(resolved, '.git'))
  if (!gitStat) throw new Error('缺少 .git 目录')

  return resolved
}

function getRepoPathsFromStore() {
  const raw = store?.get('repoPaths', [])
  if (!Array.isArray(raw)) return []
  return raw.filter((p) => typeof p === 'string' && p.trim())
}

function getScanBlacklistFromStore() {
  const raw = store?.get('scanBlacklist', [])
  if (!Array.isArray(raw)) return []
  const cleaned = raw
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
  return Array.from(new Set(cleaned))
}

async function runCommand(cmd, args, cwd) {
  return execFileAsync(cmd, args, {
    cwd,
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
    env: buildCommandEnv()
  })
}

async function scanRepoForTodos(repoPath, repoName) {
  const generated = []
  const scanInfo = {
    repoName,
    repoPath,
    matchedFolders: [],
    skippedFolders: []
  }

  const rootEntries = await fs.readdir(repoPath, { withFileTypes: true })
  const firstLevelDirs = rootEntries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))

  for (const dir of firstLevelDirs) {
    const folderName = dir.name
    const folderPath = path.join(repoPath, folderName)

    let childEntries
    try {
      childEntries = await fs.readdir(folderPath, { withFileTypes: true })
    } catch (e) {
      scanInfo.skippedFolders.push({ folderName, reason: 'read-failed' })
      continue
    }

    const visibleEntries = childEntries.filter((entry) => {
      if (!entry || !entry.name) return false
      if (entry.name === '.DS_Store') return false
      if (entry.name.startsWith('.')) return false
      return true
    })

    const completionMarkers = new Set([
      `${folderName.toLowerCase()}.md`,
      'homework.md',
      'homework.pdf'
    ])
    const hasCompletionMarker = visibleEntries.some((entry) => (
      entry.isFile() && completionMarkers.has(entry.name.toLowerCase())
    ))
    if (hasCompletionMarker) {
      scanInfo.skippedFolders.push({ folderName, reason: 'has-completion-marker' })
      continue
    }

    generated.push({
      id: randomUUID(),
      text: `${repoName}-${folderName}`,
      done: false,
      createdAt: Date.now(),
      source: 'repo-scan',
      pushState: 'none',
      meta: {
        repoName,
        folderName,
        folderPath
      }
    })

    scanInfo.matchedFolders.push(folderName)
  }

  return { generated, scanInfo }
}

async function scanReposAndCreateTodos() {
  const startedAt = nowIso()
  const repos = getRepoSpecs()
  const scanBlacklist = new Set(getScanBlacklistFromStore())

  const existingTodos = normalizeTodos(store?.get('todos', []))
  const existingTitles = new Set(existingTodos.map((t) => t.text))

  const generatedTodos = []
  const duplicateSkippedTitles = []
  const blacklistedSkippedTitles = []
  const scanPerRepo = []
  const issues = []

  for (const repo of repos) {
    try {
      const { generated, scanInfo } = await scanRepoForTodos(repo.repoPath, repo.repoName)

      for (const todo of generated) {
        if (scanBlacklist.has(todo.text)) {
          blacklistedSkippedTitles.push(todo.text)
          continue
        }

        if (existingTitles.has(todo.text)) {
          duplicateSkippedTitles.push(todo.text)
          continue
        }

        existingTitles.add(todo.text)
        generatedTodos.push(todo)
      }

      scanPerRepo.push({ status: 'success', ...scanInfo })
    } catch (e) {
      const message = asErrorMessage(e, 'scan failed')
      scanPerRepo.push({
        status: 'failed',
        repoName: repo.repoName,
        repoPath: repo.repoPath,
        message
      })
      issues.push(`Scan failed: ${repo.repoName} - ${message}`)
    }
  }

  // Put fresh scan-generated todos first so the auto list shows newest items on top.
  const mergedTodos = [...generatedTodos, ...existingTodos]
  store?.set('todos', mergedTodos)

  const result = {
    startedAt,
    finishedAt: nowIso(),
    summary: {
      repoCount: repos.length,
      generated: generatedTodos.length,
      duplicateSkipped: duplicateSkippedTitles.length,
      blacklistedSkipped: blacklistedSkippedTitles.length,
      failed: scanPerRepo.filter((r) => r.status === 'failed').length
    },
    scanPerRepo,
    generatedTodos,
    duplicateSkippedTitles,
    blacklistedSkippedTitles,
    issues
  }

  store?.set('lastScanResult', result)
  return result
}

async function runGhSyncBatch() {
  const startedAt = nowIso()
  const repos = getRepoSpecs()

  const results = []
  const issues = []

  try {
    await runCommand('gh', ['--version'])
  } catch (e) {
    const message = '未找到 gh 命令，或 gh 不可执行。请先安装 GitHub CLI 并完成 gh auth login。'
    const failed = {
      startedAt,
      finishedAt: nowIso(),
      summary: {
        repoCount: repos.length,
        success: 0,
        failed: repos.length
      },
      results: repos.map((repo) => ({
        repoName: repo.repoName,
        status: 'failed',
        stdout: '',
        stderr: message
      })),
      issues: [message]
    }
    store?.set('lastGhSyncResult', failed)
    return failed
  }

  for (const repo of repos) {
    const fullName = `${GITHUB_OWNER}/${repo.repoName}`
    try {
      const { stdout, stderr } = await runCommand('gh', ['repo', 'sync', fullName], repo.repoPath)
      results.push({
        repoName: repo.repoName,
        status: 'success',
        stdout: asTrimmedString(stdout),
        stderr: asTrimmedString(stderr)
      })
    } catch (e) {
      const stderr = asErrorMessage(e?.stderr || e, 'gh repo sync failed')
      if (isGhSyncConflict(e)) {
        try {
          const recovered = await recoverForkConflict({
            repo,
            fullName,
            defaultBranch: DEFAULT_BRANCH,
            runCommand
          })
          results.push({
            repoName: repo.repoName,
            repoPath: repo.repoPath,
            status: recovered.status,
            message: recovered.message,
            backupRef: recovered.backupRef,
            stdout: asTrimmedString(e?.stdout),
            stderr,
            steps: recovered.steps
          })
        } catch (recoveryError) {
          const recoveryMessage = asErrorMessage(recoveryError, 'automatic conflict recovery failed')
          results.push({
            repoName: repo.repoName,
            repoPath: repo.repoPath,
            status: 'failed',
            stdout: asTrimmedString(recoveryError?.stdout),
            stderr: recoveryMessage,
            backupRef: recoveryError?.backupRef || '',
            steps: recoveryError?.steps || []
          })
          issues.push(`gh sync conflict recovery failed: ${repo.repoName} - ${recoveryMessage}`)
        }
      } else {
        results.push({
          repoName: repo.repoName,
          status: 'failed',
          stdout: asTrimmedString(e?.stdout),
          stderr
        })
        issues.push(`gh sync failed: ${repo.repoName} - ${stderr}`)
      }
    }
  }

  const recoveredCount = countByStatus(results, 'recovered')

  const result = {
    startedAt,
    finishedAt: nowIso(),
    summary: {
      repoCount: repos.length,
      success: countByStatus(results, 'success') + recoveredCount,
      recovered: recoveredCount,
      failed: countByStatus(results, 'failed')
    },
    results,
    issues
  }

  store?.set('lastGhSyncResult', result)
  return result
}

async function pullLocalReposBatch() {
  const startedAt = nowIso()
  const repos = getRepoSpecs()

  const results = []
  const issues = []

  for (const repo of repos) {
    const steps = []

    try {
      const fetchOut = await runCommand('git', ['fetch', 'origin'], repo.repoPath)
      steps.push({
        cmd: 'git fetch origin',
        stdout: asTrimmedString(fetchOut.stdout),
        stderr: asTrimmedString(fetchOut.stderr)
      })

      const checkoutOut = await runCommand('git', ['checkout', DEFAULT_BRANCH], repo.repoPath)
      steps.push({
        cmd: `git checkout ${DEFAULT_BRANCH}`,
        stdout: asTrimmedString(checkoutOut.stdout),
        stderr: asTrimmedString(checkoutOut.stderr)
      })

      const pullOut = await runCommand('git', ['pull', '--ff-only', 'origin', DEFAULT_BRANCH], repo.repoPath)
      steps.push({
        cmd: `git pull --ff-only origin ${DEFAULT_BRANCH}`,
        stdout: asTrimmedString(pullOut.stdout),
        stderr: asTrimmedString(pullOut.stderr)
      })

      results.push({
        repoName: repo.repoName,
        repoPath: repo.repoPath,
        status: 'success',
        message: 'Pulled successfully',
        steps
      })
    } catch (e) {
      const message = asErrorMessage(e?.stderr || e, 'Pull local failed')
      const failedCmd = Array.isArray(e?.spawnargs) && e.spawnargs.length > 0
        ? e.spawnargs.join(' ')
        : (typeof e?.cmd === 'string' && e.cmd ? e.cmd : 'git command')
      steps.push({
        cmd: failedCmd,
        stdout: asTrimmedString(e?.stdout),
        stderr: asTrimmedString(e?.stderr)
      })
      results.push({
        repoName: repo.repoName,
        repoPath: repo.repoPath,
        status: 'failed',
        message,
        steps
      })
      issues.push(`Pull local failed: ${repo.repoName} - ${message}`)
    }
  }

  const result = {
    startedAt,
    finishedAt: nowIso(),
    repoCount: repos.length,
    results,
    summary: {
      success: countByStatus(results, 'success'),
      failed: countByStatus(results, 'failed'),
      skipped: countByStatus(results, 'skipped')
    },
    issues
  }

  store?.set('lastPullLocalResult', result)
  return result
}

function countFailedFromSummary(summaryObj, failedKey = 'failed') {
  if (!summaryObj || typeof summaryObj !== 'object') return 0
  const n = summaryObj[failedKey]
  return Number.isFinite(n) ? n : 0
}

async function syncAllSequentially() {
  const startedAt = nowIso()
  const repoCount = getRepoSpecs().length
  const steps = {
    ghSync: null,
    pullLocal: null,
    scan: null
  }
  const issues = []

  try {
    steps.ghSync = await runGhSyncBatch()
  } catch (e) {
    const message = asErrorMessage(e, 'Run gh sync failed')
    issues.push(`SyncAll step failed (ghSync): ${message}`)
    steps.ghSync = {
      startedAt: nowIso(),
      finishedAt: nowIso(),
      summary: { repoCount, success: 0, failed: repoCount },
      results: [],
      issues: [message]
    }
  }

  try {
    steps.pullLocal = await pullLocalReposBatch()
  } catch (e) {
    const message = asErrorMessage(e, 'Pull Local failed')
    issues.push(`SyncAll step failed (pullLocal): ${message}`)
    steps.pullLocal = {
      startedAt: nowIso(),
      finishedAt: nowIso(),
      repoCount,
      results: [],
      summary: { success: 0, failed: repoCount, skipped: 0 },
      issues: [message]
    }
  }

  try {
    steps.scan = await scanReposAndCreateTodos()
  } catch (e) {
    const message = asErrorMessage(e, 'Scan failed')
    issues.push(`SyncAll step failed (scan): ${message}`)
    steps.scan = {
      startedAt: nowIso(),
      finishedAt: nowIso(),
      summary: {
        repoCount,
        generated: 0,
        duplicateSkipped: 0,
        blacklistedSkipped: 0,
        failed: repoCount
      },
      scanPerRepo: [],
      generatedTodos: [],
      duplicateSkippedTitles: [],
      blacklistedSkippedTitles: [],
      issues: [message]
    }
  }

  const ghSyncFailed = countFailedFromSummary(steps.ghSync?.summary, 'failed')
  const ghSyncSuccess = Number.isFinite(steps.ghSync?.summary?.success) ? steps.ghSync.summary.success : 0
  const pullFailed = countFailedFromSummary(steps.pullLocal?.summary, 'failed')
  const pullSuccess = Number.isFinite(steps.pullLocal?.summary?.success) ? steps.pullLocal.summary.success : 0
  const scanFailed = countFailedFromSummary(steps.scan?.summary, 'failed')
  const scanGenerated = Number.isFinite(steps.scan?.summary?.generated) ? steps.scan.summary.generated : 0
  const scanDuplicateSkipped = Number.isFinite(steps.scan?.summary?.duplicateSkipped) ? steps.scan.summary.duplicateSkipped : 0

  const anyHardFailure = ghSyncFailed > 0 || pullFailed > 0 || scanFailed > 0
  const hasSevereStepFailure = issues.length > 0
  let status = 'success'
  if (hasSevereStepFailure && ghSyncSuccess === 0 && pullSuccess === 0 && scanGenerated === 0) {
    status = 'failed'
  } else if (anyHardFailure || hasSevereStepFailure) {
    status = 'partial'
  }

  const combinedIssues = [
    ...issues,
    ...(Array.isArray(steps.ghSync?.issues) ? steps.ghSync.issues : []),
    ...(Array.isArray(steps.pullLocal?.issues) ? steps.pullLocal.issues : []),
    ...(Array.isArray(steps.scan?.issues) ? steps.scan.issues : [])
  ]

  const result = {
    startedAt,
    finishedAt: nowIso(),
    status,
    steps,
    summary: {
      ghSyncSuccess,
      ghSyncFailed,
      pullSuccess,
      pullFailed,
      scanGenerated,
      scanDuplicateSkipped
    },
    issues: combinedIssues
  }

  store?.set('lastSyncAllResult', result)
  return result
}

async function initStore() {
  // electron-store 是 ESM：必须用 import()
  const { default: Store } = await import('electron-store')
  store = new Store({ name: 'todo-toggle' })
}

function createWindow(showAfterReady = false) {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: ALWAYS_ON_TOP,

    // 关键：让窗口支持透明
    transparent: true,
    backgroundColor: '#00000000',

    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const isDev = !!process.env.ELECTRON_DEV
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  if (showAfterReady) {
    const showLater = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
      }
    }

    if (mainWindow.isReadyToShow && mainWindow.isReadyToShow()) {
      showLater()
    } else {
      mainWindow.once('ready-to-show', showLater)
    }
  }

  // 失焦就自动隐藏（你也可以注释掉）
  mainWindow.on('blur', () => {
    if (mainWindow && mainWindow.isVisible()) mainWindow.hide()
  })
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true)
    return
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide()
  } else {
    mainWindow.show()
    mainWindow.focus()
  }
}

function registerHotkey() {
  globalShortcut.unregisterAll()
  const ok = globalShortcut.register(GLOBAL_TOGGLE_HOTKEY, () => toggleWindow())
  if (!ok) console.log('Failed to register global hotkey:', GLOBAL_TOGGLE_HOTKEY)
}

function registerIpc() {
  const handleSafe = (channel, runner, onFallback) => {
    ipcMain.handle(channel, async (...args) => {
      try {
        return await runner(...args)
      } catch (e) {
        return onFallback(e)
      }
    })
  }

  ipcMain.handle('todos:get', async () => {
    const v = normalizeTodos(store?.get('todos', []))
    store?.set('todos', v)
    return v
  })

  ipcMain.handle('todos:set', async (_evt, todos) => {
    const normalized = normalizeTodos(todos)
    store?.set('todos', normalized)
    return true
  })

  ipcMain.handle('settings:get', async () => {
    return {
      repoPaths: getRepoPathsFromStore(),
      scanBlacklist: getScanBlacklistFromStore(),
      lastScanResult: store?.get('lastScanResult', null),
      lastGhSyncResult: store?.get('lastGhSyncResult', null),
      lastPullLocalResult: store?.get('lastPullLocalResult', null),
      lastSyncAllResult: store?.get('lastSyncAllResult', null)
    }
  })

  ipcMain.handle('settings:getRepoPaths', async () => {
    return getRepoPathsFromStore()
  })

  ipcMain.handle('settings:addRepoPath', async (_evt, repoPathInput) => {
    try {
      const resolved = await resolveRepoPath(repoPathInput)
      const existing = getRepoPathsFromStore()

      if (existing.includes(resolved)) {
        return { ok: true, alreadyExists: true, repoPaths: existing }
      }

      const next = [...existing, resolved]
      store?.set('repoPaths', next)
      return { ok: true, alreadyExists: false, repoPaths: next }
    } catch (e) {
      return { ok: false, error: String(e?.message || e || '无效路径') }
    }
  })

  ipcMain.handle('settings:removeRepoPath', async (_evt, repoPathInput) => {
    const target = String(repoPathInput || '').trim()
    const existing = getRepoPathsFromStore()
    const next = existing.filter((p) => p !== target)
    store?.set('repoPaths', next)
    return { ok: true, repoPaths: next }
  })

  ipcMain.handle('settings:addScanBlacklist', async (_evt, titles) => {
    const incoming = Array.isArray(titles)
      ? titles.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)
      : []
    if (incoming.length === 0) {
      return { ok: false, error: '没有可加入黑名单的任务标题' }
    }

    const existing = getScanBlacklistFromStore()
    const nextSet = new Set(existing)
    let added = 0
    for (const title of incoming) {
      if (!nextSet.has(title)) {
        nextSet.add(title)
        added += 1
      }
    }

    const next = Array.from(nextSet)
    store?.set('scanBlacklist', next)
    return { ok: true, added, scanBlacklist: next }
  })

  handleSafe('repos:scan', scanReposAndCreateTodos, (e) => {
    const repoCount = getRepoSpecs().length
    const failed = {
      startedAt: nowIso(),
      finishedAt: nowIso(),
      summary: {
        repoCount,
        generated: 0,
        duplicateSkipped: 0,
        blacklistedSkipped: 0,
        failed: repoCount
      },
      scanPerRepo: [],
      generatedTodos: [],
      duplicateSkippedTitles: [],
      blacklistedSkippedTitles: [],
      issues: [asErrorMessage(e, 'scan failed')]
    }
    store?.set('lastScanResult', failed)
    return failed
  })

  handleSafe('repos:runGhSync', runGhSyncBatch, (e) => {
    const repoCount = getRepoSpecs().length
    const failed = {
      startedAt: nowIso(),
      finishedAt: nowIso(),
      summary: {
        repoCount,
        success: 0,
        failed: repoCount
      },
      results: [],
      issues: [asErrorMessage(e, 'gh sync failed')]
    }
    store?.set('lastGhSyncResult', failed)
    return failed
  })

  handleSafe('repos:pullLocal', pullLocalReposBatch, (e) => {
    const repoCount = getRepoSpecs().length
    const failed = {
      startedAt: nowIso(),
      finishedAt: nowIso(),
      repoCount,
      results: [],
      summary: {
        success: 0,
        failed: repoCount,
        skipped: 0
      },
      issues: [asErrorMessage(e, 'pull local failed')]
    }
    store?.set('lastPullLocalResult', failed)
    return failed
  })

  handleSafe('repos:syncAll', syncAllSequentially, (e) => {
    const repoCount = getRepoSpecs().length
    const failed = {
      startedAt: nowIso(),
      finishedAt: nowIso(),
      status: 'failed',
      steps: {
        ghSync: null,
        pullLocal: null,
        scan: null
      },
      summary: {
        ghSyncSuccess: 0,
        ghSyncFailed: repoCount,
        pullSuccess: 0,
        pullFailed: repoCount,
        scanGenerated: 0,
        scanDuplicateSkipped: 0
      },
      issues: [asErrorMessage(e, 'sync all failed')]
    }
    store?.set('lastSyncAllResult', failed)
    return failed
  })
}

app.on('before-quit', () => {
  isQuitting = true
})

app.on('ready', async () => {
  if (process.platform === 'darwin' && HIDE_DOCK_ICON_ON_MAC) {
    try {
      app.dock.hide()
    } catch (e) {}
  }

  if (app.isPackaged && OPEN_AT_LOGIN) {
    try {
      app.setLoginItemSettings({ openAtLogin: true })
    } catch (e) {
      console.log('setLoginItemSettings failed:', e)
    }
  }

  await initStore()
  registerIpc()

  createWindow()
  registerHotkey()
  // 启动时不自动弹窗：按 ⌘T 再叫出来
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

/**
 * mac: 关闭窗口不退出（因为我们想用快捷键叫出来）
 */
app.on('window-all-closed', (e) => {
  e.preventDefault()
})
