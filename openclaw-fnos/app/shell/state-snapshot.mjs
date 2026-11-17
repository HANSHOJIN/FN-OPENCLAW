import fs from 'node:fs'
import path from 'node:path'

// These paths survive version switches. Session databases, credentials and
// unrecognised state remain in the rollback snapshot, even when large.
const sharedRoots = ['workspace', 'tmp', 'cache', '.cache', 'logs', 'backups', 'session-sqlite-migration-runs']

export function normalizePreserved(paths) {
  if (!Array.isArray(paths) || paths.some(value => typeof value !== 'string' ||
      value.includes('\\') || value.includes(':') || value.includes('\0') ||
      value.split('/').some(part => !part || part === '.' || part === '..'))) {
    throw new Error('用户数据保留路径无效。')
  }
  const ordered = [...new Set(paths)].sort()
  return ordered.filter((value, index) => !ordered.slice(0, index).some(parent => value.startsWith(parent + '/')))
}

function entries(directory) {
  try { return fs.readdirSync(directory, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

export function preservedStatePaths(root) {
  const preserved = [...sharedRoots]
  const top = entries(root)
  for (const entry of top) {
    if (entry.name.startsWith('workspace-')) preserved.push(entry.name)
  }
  // Never traverse a linked agents directory or a linked agent directory.
  if (top.some(entry => entry.name === 'agents' && entry.isDirectory())) {
    for (const agent of entries(path.join(root, 'agents')).filter(entry => entry.isDirectory())) {
      preserved.push('agents/' + agent.name + '/session-sqlite-import-archive')
      const nested = entries(path.join(root, 'agents', agent.name))
      if (!nested.some(entry => entry.name === 'agent' && entry.isDirectory())) continue
      for (const entry of entries(path.join(root, 'agents', agent.name, 'agent'))) {
        if (entry.name.startsWith('openclaw-transcript-labels-recovery-')) {
          preserved.push('agents/' + agent.name + '/agent/' + entry.name)
        }
      }
    }
  }
  return normalizePreserved(preserved)
}

export function stateFilter(root, preserved) {
  const excluded = normalizePreserved(preserved)
  return absolute => {
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    return !excluded.some(value => relative === value || relative.startsWith(value + '/'))
  }
}

export async function cloneRuntimeState(source, destination, preserved) {
  await fs.promises.cp(source, destination, {
    recursive: true, verbatimSymlinks: true,
    // CoW when supported; ordinary independent copies elsewhere. Never hardlink
    // live databases to their rollback point.
    mode: fs.constants.COPYFILE_FICLONE,
    filter: stateFilter(source, preserved),
  })
}

function directoryChain(root, parts, create = false) {
  let current = root
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part)
    let info
    try { info = fs.lstatSync(current) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (!create) return false
      fs.mkdirSync(current, { mode: 0o700 })
      info = fs.lstatSync(current)
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('用户数据的父目录不是独立目录。')
  }
  return true
}

function exists(file) {
  try { fs.lstatSync(file); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

export function movePreservedState(source, destination, preserved) {
  for (const relative of normalizePreserved(preserved)) {
    const parts = relative.split('/')
    if (!directoryChain(source, parts.slice(0, -1))) continue
    const from = path.join(source, ...parts)
    if (!exists(from)) continue // Already moved, or absent in this version.
    directoryChain(destination, parts.slice(0, -1), true)
    const to = path.join(destination, ...parts)
    if (exists(to)) throw new Error('用户数据路径发生冲突，已停止恢复，不会覆盖现有文件。')
    // A rename preserves files, symlinks and inodes without reading their data.
    fs.renameSync(from, to)
  }
}
