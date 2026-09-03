/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Failure-cleanup seam (S4) for the live Agent Console gate resources.
 *
 * A forced failure after fake resource registration must remove only the
 * exact registered fake resources — PIDs, window classes/addresses, sockets,
 * and scratch directories — while unrelated resources survive untouched.
 * Exact registered identities authorize cleanup; names, prefixes, wildcards,
 * focus, or global operations never do. Cleanup must work on failure,
 * interruption, and assertion paths and must be idempotent.
 *
 * Fully fake: process/window controls are injected fakes, no real process is
 * ever spawned, signalled, or observed, and no live desktop is contacted.
 * Only bounded real temporary files/directories under the OS temp location
 * are used for the socket and directory cleanup rules, never inside the
 * repository.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  GateResourceRegistry,
  type GateCleanupReport,
  type GateProcessControl,
  type GateWindowControl,
} from '../live-gate-resources.ts'

interface FakeProcessState {
  /** pid -> simulated /proc/<pid>/cmdline (null once exited). */
  cmdlines: Map<number, string | null>
  /** pid -> signals delivered by the registry. */
  signals: Array<{ pid: number; signal: 'SIGTERM' | 'SIGKILL' }>
  /** Optional forced failure injection keyed by pid. */
  failFor?: Set<number>
}

function fakeProcessControl(state: FakeProcessState): GateProcessControl {
  return {
    identity(pid) {
      return state.cmdlines.get(pid) ?? null
    },
    terminate(pid, signal) {
      if (state.failFor?.has(pid)) throw new Error(`injected control failure for pid ${pid}`)
      state.signals.push({ pid, signal })
      state.cmdlines.set(pid, null)
    },
  }
}

interface FakeWindowState {
  released: Array<{ windowClass: string; address: string }>
  failFor?: Set<string>
}

function fakeWindowControl(state: FakeWindowState): GateWindowControl {
  return {
    release(windowClass, address) {
      if (state.failFor?.has(address)) throw new Error(`injected release failure for ${address}`)
      state.released.push({ windowClass, address })
    },
  }
}

/** Fresh outside-repository scratch root with mode 0700. */
function makeScratchRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchestra-gate-resources-'))
  fs.chmodSync(root, 0o700)
  return root
}

/** Create a genuine bound Unix socket at socketPath; caller must close it. */
function makeSocketFile(socketPath: string): net.Server {
  const server = net.createServer()
  server.listen(socketPath)
  return server
}

function closeAll(servers: net.Server[]): void {
  for (const server of servers) {
    try {
      server.close()
    } catch {
      // already closed
    }
  }
}

test('a forced failure after registration removes exactly the registered fake resources', () => {
  const scratch = makeScratchRoot()
  const servers: net.Server[] = []
  try {
    const processState: FakeProcessState = {
      cmdlines: new Map([
        [41001, 'node runner.ts --state-dir owned-state'],
        [41002, 'ghostty --class=com.omarchestra.Unrelated'],
      ]),
      signals: [],
    }
    const windowState: FakeWindowState = { released: [] }
    const socketPath = path.join(scratch, 'runner.sock')
    servers.push(makeSocketFile(socketPath))
    const ownedDir = path.join(scratch, 'run-scratch')
    fs.mkdirSync(ownedDir, { recursive: true })
    fs.writeFileSync(path.join(ownedDir, 'artifact.txt'), 'owned', { mode: 0o600 })

    const registry = new GateResourceRegistry({
      processControl: fakeProcessControl(processState),
      windowControl: fakeWindowControl(windowState),
    })
    registry.registerProcess(41001, 'node runner.ts --state-dir owned-state')
    registry.registerWindow('com.omarchestra.ManualGate.builder', '0xabc123')
    registry.registerSocket(socketPath)
    registry.registerDirectory(ownedDir)

    // Forced failure between registration and the cleanup path: the error
    // itself must not escape the handler, and the finally-path cleanup must
    // still remove every exact registered resource.
    const forcedError: Error = new Error('forced gate failure')
    let report: GateCleanupReport | null = null
    try {
      throw forcedError
    } catch {
      // failure swallowed by the gate's failure handler, as in the real trap
    } finally {
      report = registry.cleanup()
    }

    assert.equal(forcedError instanceof Error, true)
    assert.ok(report)
    assert.deepEqual(report.terminatedPids, [41001])
    assert.equal(processState.signals.length, 1)
    assert.equal(processState.signals[0].signal, 'SIGTERM')
    assert.deepEqual(report.releasedWindows, [
      { windowClass: 'com.omarchestra.ManualGate.builder', address: '0xabc123' },
    ])
    assert.deepEqual(report.removedSockets, [socketPath])
    assert.deepEqual(report.removedDirectories, [ownedDir])
    assert.ok(fs.existsSync(socketPath) === false, 'registered socket must be removed')
    assert.ok(fs.existsSync(ownedDir) === false, 'registered scratch directory must be removed')
    assert.equal(registry.clean, true, 'registry must report a fully clean state')
  } finally {
    closeAll(servers)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('cleanup preserves every unrelated fake resource', () => {
  const scratch = makeScratchRoot()
  const servers: net.Server[] = []
  try {
    const processState: FakeProcessState = {
      cmdlines: new Map([
        [41101, 'node runner.ts --state-dir owned-state'],
        [41102, 'user-editor --unrelated-session'],
      ]),
      signals: [],
    }
    const windowState: FakeWindowState = { released: [] }
    const registeredSocket = path.join(scratch, 'owned.sock')
    servers.push(makeSocketFile(registeredSocket))
    const unrelatedSocket = path.join(scratch, 'unrelated.sock')
    servers.push(makeSocketFile(unrelatedSocket))
    const ownedDir = path.join(scratch, 'owned-scratch')
    fs.mkdirSync(ownedDir)
    const unrelatedDir = path.join(scratch, 'unrelated-scratch')
    fs.mkdirSync(unrelatedDir)
    fs.writeFileSync(path.join(unrelatedDir, 'keep.txt'), 'keep', { mode: 0o600 })

    const registry = new GateResourceRegistry({
      processControl: fakeProcessControl(processState),
      windowControl: fakeWindowControl(windowState),
    })
    registry.registerProcess(41101, 'node runner.ts --state-dir owned-state')
    registry.registerWindow('com.omarchestra.ManualGate.coordinator', '0xdef456')
    registry.registerSocket(registeredSocket)
    registry.registerDirectory(ownedDir)

    registry.cleanup()

    assert.deepEqual(processState.signals, [{ pid: 41101, signal: 'SIGTERM' }],
      'only the exact registered PID may be signalled')
    assert.equal(processState.cmdlines.get(41102), 'user-editor --unrelated-session',
      'unrelated live PID must survive untouched')
    assert.deepEqual(windowState.released, [
      { windowClass: 'com.omarchestra.ManualGate.coordinator', address: '0xdef456' },
    ], 'only the exact registered window may be released')
    assert.ok(fs.existsSync(unrelatedSocket), 'unrelated socket must survive')
    assert.ok(fs.existsSync(unrelatedDir) && fs.existsSync(path.join(unrelatedDir, 'keep.txt')),
      'unrelated scratch directory must survive with its contents')
  } finally {
    closeAll(servers)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('process registration fails closed unless the expected identity currently matches exactly', () => {
  const processState: FakeProcessState = {
    cmdlines: new Map([[41200, 'process-identity:start=200;run=other']]),
    signals: [],
  }
  const registry = new GateResourceRegistry({
    processControl: fakeProcessControl(processState),
  })

  assert.throws(
    () => registry.registerProcess(41200, 'process-identity:start=100;run=owned'),
    /identity.*exact|exact.*identity|does not match/i,
  )
  assert.equal(registry.clean, true, 'a refused registration must not create cleanup authority')
})

test('exact identity authorizes cleanup: drifted or exited PIDs are refused, never guessed', () => {
  const scratch = makeScratchRoot()
  try {
    const exactIdentity = 'process-identity:start=100;run=owned'
    const processState: FakeProcessState = {
      cmdlines: new Map([
        [41201, exactIdentity],
        [41202, exactIdentity],
      ]),
      signals: [],
    }
    const registry = new GateResourceRegistry({
      processControl: fakeProcessControl(processState),
      windowControl: fakeWindowControl({ released: [] }),
    })
    registry.registerProcess(41201, exactIdentity)
    registry.registerProcess(41202, exactIdentity)

    // One PID is reused by an unrelated process; the other exits after exact
    // registration. Neither condition authorizes a guessed signal.
    processState.cmdlines.set(41201, 'process-identity:start=200;run=unrelated')
    processState.cmdlines.set(41202, null)
    const report = registry.cleanup()

    assert.deepEqual(processState.signals, [], 'identity drift must never authorize a kill')
    assert.ok(report.refused.length >= 2, 'both non-matching resources must be refused explicitly')
    assert.ok(report.refused.some((entry) => entry.kind === 'pid' && entry.identity === '41201'))
    assert.ok(report.refused.some((entry) => entry.kind === 'pid' && entry.identity === '41202'))
    assert.deepEqual(report.terminatedPids, [])
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('process cleanup requires exact identity equality, never substring containment', () => {
  const exactIdentity = 'process-identity:start=300;run=owned'
  const processState: FakeProcessState = {
    cmdlines: new Map([[41203, exactIdentity]]),
    signals: [],
  }
  const registry = new GateResourceRegistry({
    processControl: fakeProcessControl(processState),
    windowControl: fakeWindowControl({ released: [] }),
  })
  registry.registerProcess(41203, exactIdentity)
  processState.cmdlines.set(41203, `unrelated-wrapper:${exactIdentity}:different-run`)

  const report = registry.cleanup()

  assert.deepEqual(processState.signals, [], 'a containing command line is not the registered exact identity')
  assert.deepEqual(report.terminatedPids, [])
  assert.ok(report.refused.some((entry) => entry.kind === 'pid' && entry.identity === '41203'))
})

test('directory registration rejects a symlinked ancestor before cleanup can follow it', () => {
  const scratch = makeScratchRoot()
  try {
    const outsideParent = path.join(scratch, 'outside-parent')
    const outsideOwned = path.join(outsideParent, 'owned')
    const linkedParent = path.join(scratch, 'linked-parent')
    fs.mkdirSync(outsideOwned, { recursive: true })
    fs.writeFileSync(path.join(outsideOwned, 'keep.txt'), 'unrelated', { mode: 0o600 })
    fs.symlinkSync(outsideParent, linkedParent, 'dir')

    const registry = new GateResourceRegistry()
    assert.throws(
      () => registry.registerDirectory(path.join(linkedParent, 'owned')),
      /symbolic link|symlink/i,
    )

    assert.ok(fs.existsSync(outsideOwned), 'the directory behind the symlink must survive')
    assert.ok(fs.existsSync(path.join(outsideOwned, 'keep.txt')), 'unrelated contents must survive')
    assert.equal(registry.clean, true)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('cleanup refuses a symlinked ancestor introduced after directory registration', () => {
  const scratch = makeScratchRoot()
  try {
    const registeredParent = path.join(scratch, 'registered-parent')
    const registeredDirectory = path.join(registeredParent, 'owned')
    const movedParent = path.join(scratch, 'moved-parent')
    const unrelatedParent = path.join(scratch, 'unrelated-parent')
    const unrelatedDirectory = path.join(unrelatedParent, 'owned')
    fs.mkdirSync(registeredDirectory, { recursive: true })
    fs.mkdirSync(unrelatedDirectory, { recursive: true })
    fs.writeFileSync(path.join(unrelatedDirectory, 'keep.txt'), 'unrelated', { mode: 0o600 })

    const registry = new GateResourceRegistry()
    registry.registerDirectory(registeredDirectory)
    fs.renameSync(registeredParent, movedParent)
    fs.symlinkSync(unrelatedParent, registeredParent, 'dir')

    const report = registry.cleanup()

    assert.ok(report.refused.some((entry) => entry.kind === 'directory' && entry.identity === registeredDirectory))
    assert.ok(fs.existsSync(unrelatedDirectory), 'the directory behind the replacement symlink must survive')
    assert.ok(fs.existsSync(path.join(unrelatedDirectory, 'keep.txt')), 'unrelated contents must survive')
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('cleanup refuses a different directory inode substituted at the exact path', () => {
  const scratch = makeScratchRoot()
  try {
    const registeredDirectory = path.join(scratch, 'owned')
    const movedDirectory = path.join(scratch, 'moved-owned')
    fs.mkdirSync(registeredDirectory)

    const registry = new GateResourceRegistry()
    registry.registerDirectory(registeredDirectory)
    fs.renameSync(registeredDirectory, movedDirectory)
    fs.mkdirSync(registeredDirectory)
    fs.writeFileSync(path.join(registeredDirectory, 'keep.txt'), 'unrelated', { mode: 0o600 })

    const report = registry.cleanup()

    assert.ok(report.refused.some((entry) => entry.kind === 'directory' && entry.identity === registeredDirectory))
    assert.ok(fs.existsSync(path.join(registeredDirectory, 'keep.txt')), 'a replacement inode must survive')
    assert.equal(registry.clean, false)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('cleanup refuses a symlinked ancestor introduced after socket registration', () => {
  const scratch = makeScratchRoot()
  const servers: net.Server[] = []
  try {
    const registeredParent = path.join(scratch, 'registered-socket-parent')
    const registeredSocket = path.join(registeredParent, 'runner.sock')
    const movedParent = path.join(scratch, 'moved-socket-parent')
    const unrelatedParent = path.join(scratch, 'unrelated-socket-parent')
    const unrelatedSocket = path.join(unrelatedParent, 'runner.sock')
    fs.mkdirSync(registeredParent)
    fs.mkdirSync(unrelatedParent)
    servers.push(makeSocketFile(registeredSocket))
    servers.push(makeSocketFile(unrelatedSocket))

    const registry = new GateResourceRegistry()
    registry.registerSocket(registeredSocket)
    fs.renameSync(registeredParent, movedParent)
    fs.symlinkSync(unrelatedParent, registeredParent, 'dir')

    const report = registry.cleanup()

    assert.ok(report.refused.some((entry) => entry.kind === 'socket' && entry.identity === registeredSocket))
    assert.ok(fs.existsSync(unrelatedSocket), 'the socket behind the replacement symlink must survive')
  } finally {
    closeAll(servers)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('cleanup refuses a different socket inode substituted at the exact path', () => {
  const scratch = makeScratchRoot()
  const servers: net.Server[] = []
  try {
    const registeredSocket = path.join(scratch, 'runner.sock')
    const movedSocket = path.join(scratch, 'moved-runner.sock')
    servers.push(makeSocketFile(registeredSocket))

    const registry = new GateResourceRegistry()
    registry.registerSocket(registeredSocket)
    fs.renameSync(registeredSocket, movedSocket)
    servers.push(makeSocketFile(registeredSocket))

    const report = registry.cleanup()

    assert.ok(report.refused.some((entry) => entry.kind === 'socket' && entry.identity === registeredSocket))
    assert.ok(fs.existsSync(registeredSocket), 'a replacement socket inode must survive')
    assert.equal(registry.clean, false)
  } finally {
    closeAll(servers)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('sockets are removed only when they are real sockets and directories only at exact paths', () => {
  const scratch = makeScratchRoot()
  const servers: net.Server[] = []
  try {
    const plainFile = path.join(scratch, 'plain.txt')
    fs.writeFileSync(plainFile, 'not a socket', { mode: 0o600 })
    const realSocket = path.join(scratch, 'runner.sock')
    servers.push(makeSocketFile(realSocket))
    const ownedDir = path.join(scratch, 'owned-scratch')
    fs.mkdirSync(ownedDir)

    const registry = new GateResourceRegistry({
      processControl: fakeProcessControl({ cmdlines: new Map(), signals: [] }),
      windowControl: fakeWindowControl({ released: [] }),
    })
    assert.throws(
      () => registry.registerSocket(plainFile),
      /existing Unix socket/i,
      'a non-socket path must never acquire cleanup authority',
    )
    registry.registerSocket(realSocket)
    registry.registerDirectory(ownedDir)

    registry.cleanup()

    assert.ok(fs.existsSync(plainFile), 'a non-socket file must never be unlinked')
    assert.ok(!fs.existsSync(realSocket), 'the exact registered socket must be removed')
    assert.ok(!fs.existsSync(ownedDir))
  } finally {
    closeAll(servers)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('cleanup is idempotent and a second call removes nothing new', () => {
  const scratch = makeScratchRoot()
  const servers: net.Server[] = []
  try {
    const socketPath = path.join(scratch, 'runner.sock')
    servers.push(makeSocketFile(socketPath))
    const ownedDir = path.join(scratch, 'owned-scratch')
    fs.mkdirSync(ownedDir)
    const processState: FakeProcessState = {
      cmdlines: new Map([[41301, 'node runner.ts --state-dir owned-state']]),
      signals: [],
    }
    const registry = new GateResourceRegistry({
      processControl: fakeProcessControl(processState),
      windowControl: fakeWindowControl({ released: [] }),
    })
    registry.registerProcess(41301, 'node runner.ts --state-dir owned-state')
    registry.registerSocket(socketPath)
    registry.registerDirectory(ownedDir)

    const first = registry.cleanup()
    assert.equal(registry.clean, true)
    const second = registry.cleanup()

    assert.equal(processState.signals.length, 1, 'each exact PID is signalled exactly once')
    assert.deepEqual(second.terminatedPids, [])
    assert.deepEqual(second.releasedWindows, [])
    assert.deepEqual(second.removedSockets, [])
    assert.deepEqual(second.removedDirectories, [])
    assert.deepEqual(second.refused, [])
    assert.ok(first.terminatedPids.length + first.removedSockets.length + first.removedDirectories.length > 0)
  } finally {
    closeAll(servers)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('refused resources keep cleanup incomplete and remain retryable', () => {
  const processState: FakeProcessState = {
    cmdlines: new Map([[41302, 'process-identity:start=77;run=owned']]),
    signals: [],
    failFor: new Set([41302]),
  }
  const registry = new GateResourceRegistry({
    processControl: fakeProcessControl(processState),
  })
  registry.registerProcess(41302, 'process-identity:start=77;run=owned')

  const first = registry.cleanup()
  assert.ok(first.refused.some((entry) => entry.kind === 'pid' && entry.identity === '41302'))
  assert.equal(registry.clean, false, 'a refused registered resource keeps cleanup incomplete')

  processState.failFor?.delete(41302)
  const second = registry.cleanup()
  assert.deepEqual(second.terminatedPids, [41302], 'a later cleanup retries the exact refused resource')
  assert.equal(registry.clean, true)

  const third = registry.cleanup()
  assert.deepEqual(third, {
    terminatedPids: [],
    releasedWindows: [],
    removedSockets: [],
    removedDirectories: [],
    refused: [],
  })
})

test('cleanup still runs on interruption and assertion paths and is best-effort under control errors', () => {
  const scratch = makeScratchRoot()
  const servers: net.Server[] = []
  try {
    const socketPath = path.join(scratch, 'runner.sock')
    servers.push(makeSocketFile(socketPath))
    const ownedDir = path.join(scratch, 'owned-scratch')
    fs.mkdirSync(ownedDir)
    const processState: FakeProcessState = {
      cmdlines: new Map([
        [41401, 'node runner.ts --state-dir owned-state'],
        [41402, 'node runner.ts --state-dir owned-state'],
      ]),
      signals: [],
      failFor: new Set([41401]), // one injected control failure
    }
    const windowState: FakeWindowState = {
      released: [],
      failFor: new Set(['0xdead']),
    }
    const registry = new GateResourceRegistry({
      processControl: fakeProcessControl(processState),
      windowControl: fakeWindowControl(windowState),
    })
    registry.registerProcess(41401, 'node runner.ts --state-dir owned-state')
    registry.registerWindow('com.omarchestra.ManualGate.reviewer', '0xdead')
    registry.registerProcess(41402, 'node runner.ts --state-dir owned-state')
    registry.registerSocket(socketPath)
    registry.registerDirectory(ownedDir)

    // Simulated interruption (SIGINT-style abort) inside a failure path: the
    // finally cleanup must still run, must not itself throw, and must clean
    // the remaining exact resources despite one injected control error.
    let report: GateCleanupReport | null = null
    try {
      const abortError = Object.assign(new Error('interrupted'), { code: 'ABORT_ERR' })
      throw abortError
    } catch {
      // interruption swallowed by the handler, as in the real trap
    } finally {
      report = registry.cleanup()
      assert.ok(report, 'cleanup must run on the interruption path')
    }

    assert.ok(report)
    assert.ok(report.refused.some((entry) => entry.identity === '41401'),
      'the failed control call must be reported, not silently dropped')
    assert.ok(report.refused.some((entry) => entry.identity === '0xdead'))
    assert.deepEqual(report.terminatedPids, [41402],
      'remaining registered PIDs must still be cleaned after one failure')
    assert.ok(!fs.existsSync(socketPath), 'socket must be cleaned despite earlier control error')
    assert.ok(!fs.existsSync(ownedDir), 'directory must be cleaned despite earlier control error')
    assert.equal(registry.clean, false, 'failed process/window controls remain explicitly pending')
  } finally {
    closeAll(servers)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('window registration without an injected window control fails closed', () => {
  const registry = new GateResourceRegistry({
    processControl: fakeProcessControl({ cmdlines: new Map(), signals: [] }),
  })
  assert.throws(
    () => registry.registerWindow('com.omarchestra.ManualGate.builder', '0x123'),
    /window control/i,
    'registering a window without an exact release control must fail closed',
  )
})