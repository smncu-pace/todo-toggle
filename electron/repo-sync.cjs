function asText(value) {
  return String(value || '').trim()
}

function isGhSyncConflict(error) {
  const output = [error?.message, error?.stdout, error?.stderr]
    .map(asText)
    .filter(Boolean)
    .join('\n')
    .toLowerCase()

  if (!output) return false

  return output.includes('--force') || [
    'conflict',
    'diverg',
    'cannot be synced',
    'could not be synced',
    '冲突',
    '无法同步'
  ].some((marker) => output.includes(marker))
}

function backupRefName(date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:.TZ]/g, '')
  return `refs/todo-toggle/backups/origin-main-${timestamp}`
}

async function runStep(runCommand, steps, cmd, args, cwd) {
  try {
    const output = await runCommand(cmd, args, cwd)
    steps.push({
      cmd: [cmd, ...args].join(' '),
      status: 'success',
      stdout: asText(output?.stdout),
      stderr: asText(output?.stderr)
    })
    return output
  } catch (error) {
    steps.push({
      cmd: [cmd, ...args].join(' '),
      status: 'failed',
      stdout: asText(error?.stdout),
      stderr: asText(error?.stderr || error?.message || error)
    })
    throw error
  }
}

/**
 * Recover a fork that GitHub cannot sync normally.
 *
 * The local main branch is the safety copy. We first commit its working tree and
 * merge any commits that only exist on the old fork. Only after that succeeds do
 * we force the fork to the teacher/upstream version. Finally, we merge those new
 * teacher commits into local main (preferring the student's files on conflicts)
 * and push the combined history back to the fork.
 */
async function recoverForkConflict({ repo, fullName, defaultBranch = 'main', runCommand }) {
  const steps = []
  const cwd = repo.repoPath
  let backupRef = ''
  let forcedRemote = false

  try {
    const branchOut = await runStep(runCommand, steps, 'git', ['branch', '--show-current'], cwd)
    const branch = asText(branchOut.stdout)
    if (branch !== defaultBranch) {
      throw new Error(`自动冲突恢复只会处理 ${defaultBranch} 分支；当前分支是 ${branch || 'detached HEAD'}`)
    }

    const unresolvedOut = await runStep(
      runCommand,
      steps,
      'git',
      ['diff', '--name-only', '--diff-filter=U'],
      cwd
    )
    if (asText(unresolvedOut.stdout)) {
      throw new Error('本地已经存在未解决的 Git 冲突，请先处理后再同步')
    }

    const statusOut = await runStep(runCommand, steps, 'git', ['status', '--porcelain'], cwd)
    if (asText(statusOut.stdout)) {
      await runStep(runCommand, steps, 'git', ['add', '-A'], cwd)
      await runStep(
        runCommand,
        steps,
        'git',
        ['commit', '-m', 'chore: preserve local work before teacher sync'],
        cwd
      )
    }

    await runStep(runCommand, steps, 'git', ['fetch', 'origin'], cwd)
    const oldOriginOut = await runStep(
      runCommand,
      steps,
      'git',
      ['rev-parse', `origin/${defaultBranch}`],
      cwd
    )
    const oldOriginSha = asText(oldOriginOut.stdout)
    backupRef = backupRefName()
    await runStep(runCommand, steps, 'git', ['update-ref', backupRef, oldOriginSha], cwd)

    // Capture work that may have been pushed from another computer before the
    // fork is reset to upstream.
    await runStep(
      runCommand,
      steps,
      'git',
      ['merge', '--no-edit', '-X', 'ours', `origin/${defaultBranch}`],
      cwd
    )

    await runStep(runCommand, steps, 'gh', ['repo', 'sync', fullName, '--force'], cwd)
    forcedRemote = true
    await runStep(runCommand, steps, 'git', ['fetch', 'origin'], cwd)

    try {
      await runStep(
        runCommand,
        steps,
        'git',
        ['merge', '--no-edit', '-X', 'ours', `origin/${defaultBranch}`],
        cwd
      )
    } catch (error) {
      try {
        await runStep(runCommand, steps, 'git', ['merge', '--abort'], cwd)
      } catch (_) {}
      throw error
    }

    await runStep(runCommand, steps, 'git', ['push', 'origin', defaultBranch], cwd)

    return {
      status: 'recovered',
      message: '已先同步老师版本，再合并并上传本地内容',
      backupRef,
      steps
    }
  } catch (error) {
    const detail = asText(error?.stderr || error?.message || error)
    const phaseHint = forcedRemote
      ? '远端已对齐老师版本；本地内容仍保留，请根据备份引用继续处理'
      : '尚未强制修改远端，本地内容仍保留'
    const wrapped = new Error(`${detail}（${phaseHint}${backupRef ? `；备份：${backupRef}` : ''}）`)
    wrapped.stdout = error?.stdout
    wrapped.stderr = error?.stderr
    wrapped.steps = steps
    wrapped.backupRef = backupRef
    wrapped.forcedRemote = forcedRemote
    throw wrapped
  }
}

module.exports = {
  backupRefName,
  isGhSyncConflict,
  recoverForkConflict
}
