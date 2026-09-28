const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const { isGhSyncConflict, recoverForkConflict } = require('../electron/repo-sync.cjs')

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd })
}

async function configureRepo(cwd) {
  await git(cwd, ['config', 'user.name', 'Todo Toggle Test'])
  await git(cwd, ['config', 'user.email', 'todo-toggle@example.test'])
}

async function write(cwd, filename, contents) {
  await fs.writeFile(path.join(cwd, filename), contents)
}

test('recognizes only sync-conflict style gh failures', () => {
  assert.equal(isGhSyncConflict({ stderr: 'branch could not be synced because of conflicts; use --force' }), true)
  assert.equal(isGhSyncConflict({ stderr: 'authentication failed' }), false)
  assert.equal(isGhSyncConflict({ stderr: 'network timeout' }), false)
})

test('preserves local and old fork work while adding teacher updates', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-toggle-sync-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const teacher = path.join(root, 'teacher')
  const studentRemote = path.join(root, 'student-remote')
  const local = path.join(root, 'local')

  await git(root, ['init', '--bare', '--initial-branch=main', origin])
  await git(root, ['init', '--initial-branch=main', seed])
  await configureRepo(seed)
  await write(seed, 'assignment-1.txt', 'starter\n')
  await git(seed, ['add', '.'])
  await git(seed, ['commit', '-m', 'initial teacher assignment'])
  await git(seed, ['remote', 'add', 'origin', origin])
  await git(seed, ['push', '-u', 'origin', 'main'])

  await git(root, ['clone', origin, teacher])
  await configureRepo(teacher)
  await git(root, ['clone', origin, studentRemote])
  await configureRepo(studentRemote)
  await git(root, ['clone', origin, local])
  await configureRepo(local)

  await write(teacher, 'assignment-2.txt', 'new teacher homework\n')
  await write(teacher, 'assignment-1.txt', 'teacher revised starter\n')
  await git(teacher, ['add', '.'])
  await git(teacher, ['commit', '-m', 'new teacher assignment'])
  const teacherSha = (await git(teacher, ['rev-parse', 'HEAD'])).stdout.trim()

  await write(studentRemote, 'submitted-elsewhere.txt', 'remote student answer\n')
  await git(studentRemote, ['add', '.'])
  await git(studentRemote, ['commit', '-m', 'student work from another machine'])
  await git(studentRemote, ['push', 'origin', 'main'])
  const oldForkSha = (await git(studentRemote, ['rev-parse', 'HEAD'])).stdout.trim()

  await write(local, 'local-answer.txt', 'uncommitted local answer\n')
  await write(local, 'assignment-1.txt', 'student completed answer\n')

  const runCommand = async (cmd, args, cwd) => {
    if (cmd === 'gh') {
      assert.deepEqual(args, ['repo', 'sync', 'student/course', '--force'])
      await git(teacher, ['push', '--force', origin, `${teacherSha}:refs/heads/main`])
      return { stdout: 'forced upstream sync', stderr: '' }
    }
    return execFileAsync(cmd, args, { cwd })
  }

  const result = await recoverForkConflict({
    repo: { repoName: 'course', repoPath: local },
    fullName: 'student/course',
    defaultBranch: 'main',
    runCommand
  })

  assert.equal(result.status, 'recovered')
  assert.match(result.backupRef, /^refs\/todo-toggle\/backups\/origin-main-/)
  assert.equal((await git(local, ['rev-parse', result.backupRef])).stdout.trim(), oldForkSha)
  assert.equal(await fs.readFile(path.join(local, 'assignment-2.txt'), 'utf8'), 'new teacher homework\n')
  assert.equal(await fs.readFile(path.join(local, 'assignment-1.txt'), 'utf8'), 'student completed answer\n')
  assert.equal(await fs.readFile(path.join(local, 'submitted-elsewhere.txt'), 'utf8'), 'remote student answer\n')
  assert.equal(await fs.readFile(path.join(local, 'local-answer.txt'), 'utf8'), 'uncommitted local answer\n')

  const localSha = (await git(local, ['rev-parse', 'main'])).stdout.trim()
  const pushedSha = (await git(root, ['--git-dir', origin, 'rev-parse', 'main'])).stdout.trim()
  assert.equal(pushedSha, localSha)
  assert.equal((await git(local, ['status', '--porcelain'])).stdout.trim(), '')
})
