import React, { useEffect, useMemo, useState } from 'react'
import { nanoid } from 'nanoid'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core'
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

const MONITOR_TABS = [
  { key: 'scan', label: 'Scan' },
  { key: 'syncAll', label: 'Sync All' },
  { key: 'ghSync', label: 'gh Sync' },
  { key: 'pullLocal', label: 'Pull Local' }
]

function clampText(s) {
  return (s ?? '').trim()
}

function toErrorText(prefix, e) {
  return `${prefix}：${String(e?.message || e)}`
}

function normalizeTodo(todo) {
  if (!todo || typeof todo !== 'object') return null
  const text = clampText(todo.text)
  if (!text) return null

  return {
    id: typeof todo.id === 'string' && todo.id ? todo.id : nanoid(),
    text,
    done: !!todo.done,
    createdAt: Number.isFinite(todo.createdAt) ? todo.createdAt : Date.now(),
    source: todo.source === 'repo-scan' ? 'repo-scan' : 'manual',
    meta: todo.source === 'repo-scan' && todo.meta ? todo.meta : null,
    pushState: todo.pushState === 'pending' || todo.pushState === 'pushed'
      ? todo.pushState
      : 'none'
  }
}

function normalizeTodos(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeTodo).filter(Boolean)
}

function isAutoTodo(todo) {
  return todo?.source === 'repo-scan'
}

function splitTodos(items) {
  const manualIncomplete = []
  const manualComplete = []
  const autoIncomplete = []
  const autoComplete = []

  for (const todo of items) {
    if (isAutoTodo(todo)) {
      if (todo.done) autoComplete.push(todo)
      else autoIncomplete.push(todo)
    } else if (todo.done) {
      manualComplete.push(todo)
    } else {
      manualIncomplete.push(todo)
    }
  }

  // Keep unfinished todos at the top while preserving the existing order
  // within each completion state (including any drag-and-drop ordering).
  return {
    manual: [...manualIncomplete, ...manualComplete],
    auto: [...autoIncomplete, ...autoComplete]
  }
}

function SortableTodoItem({
  todo,
  onToggle,
  onDelete,
  showPushHint = false,
  onConfirmPush,
  selectable = false,
  selected = false,
  onSelectChange
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: todo.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1
  }

  return (
    <div className={todo.done ? 'done' : ''} ref={setNodeRef} style={style}>
      <div className={`item ${selectable ? 'item-with-selector' : ''}`}>
        {selectable && (
          <label className="selector-wrap" title="选中后可加入扫描黑名单">
            <input
              type="checkbox"
              checked={selected}
              onChange={(e) => {
                e.stopPropagation()
                onSelectChange?.(todo.id, e.target.checked)
              }}
            />
          </label>
        )}
        <div className="drag" {...attributes} {...listeners} title="拖动排序">☰</div>

        <div
          className="text"
          onClick={() => {
            if (todo.done) onDelete(todo.id)
          }}
          title={todo.done ? '已完成：点文字删除' : ''}
        >
          <span className="todo-main-text">{todo.text}</span>
          {showPushHint && todo.done && todo.pushState !== 'pushed' && (
            <button
              className="button button-push"
              title="点击后将该条目的 Push 提醒标记为已处理"
              onClick={(e) => {
                e.stopPropagation()
                onConfirmPush?.(todo.id)
              }}
            >
              Push
            </button>
          )}
        </div>

        <button className="check" onClick={() => onToggle(todo.id)} title={todo.done ? '取消完成' : '标记完成'}>
          <span>{todo.done ? '✓' : ''}</span>
        </button>
      </div>
    </div>
  )
}

function ScanResult({ result }) {
  if (!result) return <div className="sync-empty">还没有执行过扫描</div>

  const summary = result.summary || {}

  return (
    <div className="sync-result">
      <div className="sync-line">开始：{result.startedAt || '-'}</div>
      <div className="sync-line">结束：{result.finishedAt || '-'}</div>
      <div className="sync-line">仓库数：{summary.repoCount ?? 0}</div>
      <div className="sync-line">新增 Todo：{summary.generated ?? 0}</div>
      <div className="sync-line">去重跳过：{summary.duplicateSkipped ?? 0}</div>
      <div className="sync-line">黑名单跳过：{summary.blacklistedSkipped ?? 0}</div>
      <div className="sync-line">失败仓库：{summary.failed ?? 0}</div>

      {Array.isArray(result.scanPerRepo) && result.scanPerRepo.length > 0 && (
        <div className="sync-group">
          <div className="sync-group-title">逐仓库扫描结果</div>
          {result.scanPerRepo.map((item) => (
            <div key={`scan-${item.repoPath || item.repoName}`} className="sync-item">
              {item.repoName}: {item.status}
              {item.status === 'success' ? ` (matched: ${Array.isArray(item.matchedFolders) ? item.matchedFolders.length : 0})` : ''}
              {item.message ? ` - ${item.message}` : ''}
            </div>
          ))}
        </div>
      )}

      {Array.isArray(result.issues) && result.issues.length > 0 && (
        <div className="sync-group">
          <div className="sync-group-title">错误</div>
          {result.issues.map((issue, index) => (
            <div key={`scan-issue-${index}`} className="sync-item sync-item-error">{issue}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function GhSyncResult({ result }) {
  if (!result) return <div className="sync-empty">还没有执行过 gh sync</div>

  const summary = result.summary || {}

  return (
    <div className="sync-result">
      <div className="sync-line">开始：{result.startedAt || '-'}</div>
      <div className="sync-line">结束：{result.finishedAt || '-'}</div>
      <div className="sync-line">仓库数：{summary.repoCount ?? 0}</div>
      <div className="sync-line">成功：{summary.success ?? 0}</div>
      <div className="sync-line">自动解决冲突：{summary.recovered ?? 0}</div>
      <div className="sync-line">失败：{summary.failed ?? 0}</div>

      {Array.isArray(result.results) && result.results.length > 0 && (
        <div className="sync-group">
          <div className="sync-group-title">逐仓库 gh sync 结果</div>
          {result.results.map((item) => (
            <div key={`gh-${item.repoName}`} className="sync-item">
              {item.repoName}: {item.status}
              {item.message ? ` - ${item.message}` : (item.stderr ? ` - ${item.stderr}` : '')}
              {item.backupRef ? `（备份：${item.backupRef}）` : ''}
            </div>
          ))}
        </div>
      )}

      {Array.isArray(result.issues) && result.issues.length > 0 && (
        <div className="sync-group">
          <div className="sync-group-title">错误</div>
          {result.issues.map((issue, index) => (
            <div key={`gh-issue-${index}`} className="sync-item sync-item-error">{issue}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function PullLocalResult({ result }) {
  if (!result) return <div className="sync-empty">还没有执行过 Pull Local</div>

  const summary = result.summary || {}

  return (
    <div className="sync-result">
      <div className="sync-line">开始：{result.startedAt || '-'}</div>
      <div className="sync-line">结束：{result.finishedAt || '-'}</div>
      <div className="sync-line">仓库数：{result.repoCount ?? 0}</div>
      <div className="sync-line">成功：{summary.success ?? 0}</div>
      <div className="sync-line">失败：{summary.failed ?? 0}</div>
      <div className="sync-line">跳过：{summary.skipped ?? 0}</div>

      {Array.isArray(result.results) && result.results.length > 0 && (
        <div className="sync-group">
          <div className="sync-group-title">逐仓库 Pull 结果</div>
          {result.results.map((item) => (
            <div key={`pull-${item.repoPath || item.repoName}`} className="sync-item">
              {item.repoName}: {item.status}
              {item.message ? ` - ${item.message}` : ''}
            </div>
          ))}
        </div>
      )}

      {Array.isArray(result.issues) && result.issues.length > 0 && (
        <div className="sync-group">
          <div className="sync-group-title">错误</div>
          {result.issues.map((issue, index) => (
            <div key={`pull-issue-${index}`} className="sync-item sync-item-error">{issue}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function SyncAllResult({ result }) {
  if (!result) return <div className="sync-empty">还没有执行过 Sync All</div>

  const summary = result.summary || {}

  return (
    <div className="sync-result">
      <div className="sync-line">开始：{result.startedAt || '-'}</div>
      <div className="sync-line">结束：{result.finishedAt || '-'}</div>
      <div className="sync-line">状态：{result.status || '-'}</div>
      <div className="sync-line">gh sync: 成功 {summary.ghSyncSuccess ?? 0} / 失败 {summary.ghSyncFailed ?? 0}</div>
      <div className="sync-line">pull local: 成功 {summary.pullSuccess ?? 0} / 失败 {summary.pullFailed ?? 0}</div>
      <div className="sync-line">scan: 新增 {summary.scanGenerated ?? 0} / 去重 {summary.scanDuplicateSkipped ?? 0}</div>

      {Array.isArray(result.issues) && result.issues.length > 0 && (
        <div className="sync-group">
          <div className="sync-group-title">错误</div>
          {result.issues.map((issue, index) => (
            <div key={`syncall-issue-${index}`} className="sync-item sync-item-error">{issue}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function MonitorResult({ tab, results }) {
  if (tab === 'scan') return <ScanResult result={results.lastScanResult} />
  if (tab === 'syncAll') return <SyncAllResult result={results.lastSyncAllResult} />
  if (tab === 'ghSync') return <GhSyncResult result={results.lastGhSyncResult} />
  return <PullLocalResult result={results.lastPullLocalResult} />
}

export default function App() {
  const [input, setInput] = useState('')
  const [todos, setTodos] = useState([])

  const [repoPaths, setRepoPaths] = useState([])
  const [scanBlacklist, setScanBlacklist] = useState([])
  const [selectedAutoTodoIds, setSelectedAutoTodoIds] = useState([])
  const [repoPathInput, setRepoPathInput] = useState('')
  const [lastScanResult, setLastScanResult] = useState(null)
  const [lastGhSyncResult, setLastGhSyncResult] = useState(null)
  const [lastPullLocalResult, setLastPullLocalResult] = useState(null)
  const [lastSyncAllResult, setLastSyncAllResult] = useState(null)
  const [monitorTab, setMonitorTab] = useState('syncAll')

  const [scanning, setScanning] = useState(false)
  const [runningGhSync, setRunningGhSync] = useState(false)
  const [pullingLocal, setPullingLocal] = useState(false)
  const [syncingAll, setSyncingAll] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState('')

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  useEffect(() => {
    let cancelled = false

    async function run() {
      try {
        const [loadedTodos, settings] = await Promise.all([
          window.api?.loadTodos?.(),
          window.api?.getSettings?.()
        ])

        if (cancelled) return

        setTodos(normalizeTodos(loadedTodos))
        setRepoPaths(Array.isArray(settings?.repoPaths) ? settings.repoPaths : [])
        setScanBlacklist(Array.isArray(settings?.scanBlacklist) ? settings.scanBlacklist : [])
        setLastScanResult(settings?.lastScanResult || null)
        setLastGhSyncResult(settings?.lastGhSyncResult || null)
        setLastPullLocalResult(settings?.lastPullLocalResult || null)
        setLastSyncAllResult(settings?.lastSyncAllResult || null)
      } catch (e) {
        if (!cancelled) setSettingsMessage(`初始化失败：${String(e?.message || e)}`)
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        window.api?.saveTodos?.(todos)
      } catch (e) {}
    }, 120)
    return () => clearTimeout(t)
  }, [todos])

  const { manualTodos, autoTodos } = useMemo(() => {
    const { manual, auto } = splitTodos(todos)
    return {
      manualTodos: manual,
      autoTodos: auto
    }
  }, [todos])

  const manualRemaining = useMemo(() => manualTodos.filter((t) => !t.done).length, [manualTodos])
  const autoRemaining = useMemo(() => autoTodos.filter((t) => !t.done).length, [autoTodos])
  const selectedAutoTodoCount = useMemo(() => selectedAutoTodoIds.length, [selectedAutoTodoIds])
  const monitorResults = useMemo(() => ({
    lastScanResult,
    lastSyncAllResult,
    lastGhSyncResult,
    lastPullLocalResult
  }), [lastScanResult, lastSyncAllResult, lastGhSyncResult, lastPullLocalResult])

  useEffect(() => {
    const validIds = new Set(autoTodos.map((t) => t.id))
    setSelectedAutoTodoIds((prev) => prev.filter((id) => validIds.has(id)))
  }, [autoTodos])

  function addTodo() {
    const text = clampText(input)
    if (!text) return

    setTodos((prev) => {
      const { manual, auto } = splitTodos(prev)
      return [
        {
          id: nanoid(),
          text,
          done: false,
          createdAt: Date.now(),
          source: 'manual',
          meta: null
        },
        ...manual,
        ...auto
      ]
    })

    setInput('')
  }

  function onKeyDown(e) {
    if (e.key === 'Enter') addTodo()
  }

  function toggleTodo(id) {
    setTodos((prev) => prev.map((t) => {
      if (t.id !== id) return t
      const nextDone = !t.done
      if (t.source === 'repo-scan') {
        return {
          ...t,
          done: nextDone,
          pushState: nextDone ? 'pending' : 'none'
        }
      }
      return { ...t, done: nextDone }
    }))
  }

  function confirmTodoPushed(id) {
    setTodos((prev) => prev.map((t) => {
      if (t.id !== id) return t
      if (t.source !== 'repo-scan' || !t.done) return t
      return { ...t, pushState: 'pushed' }
    }))
  }

  function deleteTodo(id) {
    setTodos((prev) => prev.filter((t) => t.id !== id))
    setSelectedAutoTodoIds((prev) => prev.filter((v) => v !== id))
  }

  function toggleAutoTodoSelection(id, checked) {
    setSelectedAutoTodoIds((prev) => {
      if (checked) {
        if (prev.includes(id)) return prev
        return [...prev, id]
      }
      return prev.filter((v) => v !== id)
    })
  }

  function reorderWithinSource(source, activeId, overId) {
    setTodos((prev) => {
      const { manual, auto } = splitTodos(prev)

      if (source === 'manual') {
        const oldIndex = manual.findIndex((i) => i.id === activeId)
        const newIndex = manual.findIndex((i) => i.id === overId)
        if (oldIndex < 0 || newIndex < 0) return prev
        return [...arrayMove(manual, oldIndex, newIndex), ...auto]
      }

      const oldIndex = auto.findIndex((i) => i.id === activeId)
      const newIndex = auto.findIndex((i) => i.id === overId)
      if (oldIndex < 0 || newIndex < 0) return prev
      return [...manual, ...arrayMove(auto, oldIndex, newIndex)]
    })
  }

  function onManualDragEnd(event) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    reorderWithinSource('manual', active.id, over.id)
  }

  function onAutoDragEnd(event) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    reorderWithinSource('auto', active.id, over.id)
  }

  async function addRepoPath() {
    const raw = clampText(repoPathInput)
    if (!raw) return

    setSettingsMessage('')
    try {
      const res = await window.api?.addRepoPath?.(raw)
      if (res?.ok) {
        setRepoPaths(Array.isArray(res.repoPaths) ? res.repoPaths : [])
        setRepoPathInput('')
        setSettingsMessage(res.alreadyExists ? '路径已存在，未重复添加' : '仓库路径已添加')
      } else {
        setSettingsMessage(`添加失败：${res?.error || '未知错误'}`)
      }
    } catch (e) {
      setSettingsMessage(toErrorText('添加失败', e))
    }
  }

  async function removeRepoPath(repoPath) {
    setSettingsMessage('')
    try {
      const res = await window.api?.removeRepoPath?.(repoPath)
      if (res?.ok) {
        setRepoPaths(Array.isArray(res.repoPaths) ? res.repoPaths : [])
      }
    } catch (e) {
      setSettingsMessage(toErrorText('删除路径失败', e))
    }
  }

  async function scanRepos() {
    setMonitorTab('scan')
    setScanning(true)
    setSettingsMessage('')

    try {
      const result = await window.api?.scanRepos?.()
      setLastScanResult(result || null)

      const reloaded = await window.api?.loadTodos?.()
      setTodos(normalizeTodos(reloaded))
      setSelectedAutoTodoIds([])

      setSettingsMessage('扫描完成')
    } catch (e) {
      setSettingsMessage(toErrorText('扫描失败', e))
    } finally {
      setScanning(false)
    }
  }

  async function runGhSync() {
    setMonitorTab('ghSync')
    setRunningGhSync(true)
    setSettingsMessage('')

    try {
      const result = await window.api?.runGhSync?.()
      setLastGhSyncResult(result || null)
      setSettingsMessage('gh sync 执行完成')
    } catch (e) {
      setSettingsMessage(toErrorText('gh sync 失败', e))
    } finally {
      setRunningGhSync(false)
    }
  }

  async function pullLocal() {
    setMonitorTab('pullLocal')
    setPullingLocal(true)
    setSettingsMessage('')

    try {
      const result = await window.api?.pullLocal?.()
      setLastPullLocalResult(result || null)
      setSettingsMessage('Pull Local 执行完成')
    } catch (e) {
      setSettingsMessage(toErrorText('Pull Local 失败', e))
    } finally {
      setPullingLocal(false)
    }
  }

  async function syncAll() {
    setMonitorTab('syncAll')
    setSyncingAll(true)
    setSettingsMessage('')

    try {
      const result = await window.api?.syncAll?.()
      setLastSyncAllResult(result || null)

      const settings = await window.api?.getSettings?.()
      setLastGhSyncResult(settings?.lastGhSyncResult || null)
      setLastPullLocalResult(settings?.lastPullLocalResult || null)
      setLastScanResult(settings?.lastScanResult || null)

      const reloaded = await window.api?.loadTodos?.()
      setTodos(normalizeTodos(reloaded))
      setSelectedAutoTodoIds([])
      setSettingsMessage('Sync All 执行完成')
    } catch (e) {
      setSettingsMessage(toErrorText('Sync All 失败', e))
    } finally {
      setSyncingAll(false)
    }
  }

  async function addSelectedAutoTodosToBlacklist() {
    const selectedAutoTodos = autoTodos.filter((todo) => selectedAutoTodoIds.includes(todo.id))
    const titles = Array.from(new Set(selectedAutoTodos.map((todo) => clampText(todo.text)).filter(Boolean)))
    if (titles.length === 0) {
      setSettingsMessage('请先在右侧勾选要忽略的任务')
      return
    }

    setSettingsMessage('')
    try {
      const res = await window.api?.addScanBlacklist?.(titles)
      if (!res?.ok) {
        setSettingsMessage(`加入黑名单失败：${res?.error || '未知错误'}`)
        return
      }

      setScanBlacklist(Array.isArray(res.scanBlacklist) ? res.scanBlacklist : scanBlacklist)
      const selectedSet = new Set(selectedAutoTodoIds)
      setTodos((prev) => prev.filter((todo) => !selectedSet.has(todo.id)))
      setSelectedAutoTodoIds([])
      setSettingsMessage(`已加入黑名单：${res.added ?? titles.length} 条；后续扫描将忽略`)
    } catch (e) {
      setSettingsMessage(toErrorText('加入黑名单失败', e))
    }
  }

  return (
    <div className="container">
      <h1 className="title">TodoToggle</h1>

      <div className="settings-card">
        <div className="settings-shell">
          <section className="pane pane-config">
            <div className="settings-head">课程作业扫描设置</div>
            <div className="settings-row">
              <input
                className="input"
                placeholder="添加本地 repo 路径，例如 /Users/xxx/Desktop/Github/2025-AIL"
                value={repoPathInput}
                onChange={(e) => setRepoPathInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addRepoPath()
                }}
              />
              <button className="button" onClick={addRepoPath}>添加路径</button>
            </div>
            <div className="repo-list repo-list-scroll">
              {repoPaths.length === 0 ? (
                <div className="repo-empty">还没有配置 repo 路径</div>
              ) : (
                repoPaths.map((repoPath) => (
                  <div key={repoPath} className="repo-item">
                    <span className="repo-path">{repoPath}</span>
                    <button className="button button-danger" onClick={() => removeRepoPath(repoPath)}>删除</button>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="pane pane-monitor">
            <div className="settings-head">Monitor</div>
            <div className="tab-row">
              {MONITOR_TABS.map((tab) => (
                <button
                  key={tab.key}
                  className={`tab-btn ${monitorTab === tab.key ? 'tab-btn-active' : ''}`}
                  onClick={() => setMonitorTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="monitor-actions">
              <button className="button button-hero" onClick={syncAll} disabled={syncingAll}>
                {syncingAll ? 'Syncing All...' : 'Sync All'}
              </button>
              <button className="button button-primary" onClick={scanRepos} disabled={scanning}>
                {scanning ? '扫描中...' : 'Scan'}
              </button>
              <button className="button" onClick={runGhSync} disabled={runningGhSync}>
                {runningGhSync ? '执行中...' : 'Run gh sync'}
              </button>
              <button className="button" onClick={pullLocal} disabled={pullingLocal}>
                {pullingLocal ? 'Pulling...' : 'Pull Local'}
              </button>
            </div>
            {settingsMessage && <div className="settings-message">{settingsMessage}</div>}
            <div className="monitor-result">
              <MonitorResult tab={monitorTab} results={monitorResults} />
            </div>
          </section>
        </div>
      </div>

      <div className="columns">
        <section className="column">
          <div className="section-title">手动添加</div>

          <div className="row">
            <input
              className="input"
              placeholder="输入一条 todo，回车添加"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <button className="button" onClick={addTodo}>添加</button>
          </div>

          <div className="hint">拖动 ☰ 调整优先级；点勾切换完成/未完成；完成后点文字删除。</div>

          <div className="list">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onManualDragEnd}>
              <SortableContext items={manualTodos.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                {manualTodos.map((todo) => (
                  <SortableTodoItem key={todo.id} todo={todo} onToggle={toggleTodo} onDelete={deleteTodo} />
                ))}
              </SortableContext>
            </DndContext>
          </div>

          <div className="footer">
            <span className="small">未完成：{manualRemaining}</span>
            <span className="small">已完成：{manualTodos.length - manualRemaining}</span>
          </div>
        </section>

        <section className="column">
          <div className="section-title">自动扫描</div>

          <div className="hint">来自 repo 扫描自动生成，不能手工输入创建；可勾选完成，完成后点文字删除。</div>
          <div className="auto-actions">
            <button
              className="button"
              onClick={addSelectedAutoTodosToBlacklist}
              disabled={selectedAutoTodoCount === 0}
            >
              加入黑名单（忽略后续扫描）
            </button>
            <span className="small">
              已选：{selectedAutoTodoCount}，黑名单：{scanBlacklist.length}
            </span>
          </div>

          <div className="list">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onAutoDragEnd}>
              <SortableContext items={autoTodos.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                {autoTodos.map((todo) => (
                  <SortableTodoItem
                    key={todo.id}
                    todo={todo}
                    onToggle={toggleTodo}
                    onDelete={deleteTodo}
                    showPushHint
                    onConfirmPush={confirmTodoPushed}
                    selectable
                    selected={selectedAutoTodoIds.includes(todo.id)}
                    onSelectChange={toggleAutoTodoSelection}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>

          <div className="footer">
            <span className="small">未完成：{autoRemaining}</span>
            <span className="small">已完成：{autoTodos.length - autoRemaining}</span>
          </div>
        </section>
      </div>

      <div className="hint global-hint">
        全局快捷键 <kbd>⌘</kbd>+<kbd>T</kbd> 显示/隐藏窗口。
      </div>
    </div>
  )
}
