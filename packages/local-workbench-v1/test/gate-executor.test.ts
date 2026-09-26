/**
 * AL-05 bounded gate-executor tests. Every child is a disposable
 * deterministic Node script inside a temp Project; nothing touches the
 * store, the authority or any shared gate. The executor never escalates
 * past SIGTERM, so all spawned children exit on their own before the suite
 * ends.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeGate, type GateExecution, type GateExecutorOptions } from '../runner/gate-executor.ts'
import type { ResolvedCheckDefinition } from '../runner/check-definition.ts'

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

interface Fixture {
  root: string
  project: string
  scratchRoot: string
  policyPath: string
  checkerPath: string
  writeChecker: (body: string, executable?: boolean) => { path: string; digest: string }
  definition: (overrides?: Partial<ResolvedCheckDefinition>) => ResolvedCheckDefinition
}

function fixture(t: test.TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wb-gate-executor-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const scratchRoot = join(root, 'scratch')
  const checkerPath = join(project, 'checker.cjs')
  mkdirSync(project)
  mkdirSync(scratchRoot)
  const policyPath = join(project, 'policy.txt')
  writeFileSync(policyPath, 'policy-v1\n')
  const writeChecker = (body: string, executable = true) => {
    writeFileSync(checkerPath, `#!${process.execPath}\n${body}`)
    chmodSync(checkerPath, executable ? 0o755 : 0o644)
    return { path: checkerPath, digest: sha256(readFileSync(checkerPath)) }
  }
  const definition = (overrides: Partial<ResolvedCheckDefinition> = {}) => ({
    projectId: 'project-1', checkId: 'check-1', version: 1, name: 'Gate check', summary: 'Bounded gate check',
    mode: 'validator' as const, commandSummary: 'Run the deterministic checker',
    semanticClaim: 'Configured validator exited zero; subject to candidate and resource stability.',
    executable: checkerPath, executableDigest: sha256(readFileSync(checkerPath)),
    argv: [] as string[], cwd: project,
    environment: [{ name: 'GATE_TEST_MARK', value: 'ok' }],
    resources: [{ path: policyPath, digest: sha256('policy-v1\n'), length: 10, mode: 0o644 }],
    timeoutMs: 5000, outputBytes: 4096, maxCorrections: 1, elapsedMs: 60000,
    ...overrides,
  }) as ResolvedCheckDefinition
  return { root, project, scratchRoot, policyPath, checkerPath, writeChecker, definition }
}

function options(f: Fixture, overrides: Partial<GateExecutorOptions> = {}): GateExecutorOptions {
  return { scratchRoot: f.scratchRoot, graceMs: 400, ...overrides }
}

function assertResourceVerified(execution: GateExecution, phase: 'pre' | 'post'): void {
  for (const check of execution.resourceChecks) assert.equal(check[phase], 'verified', `${check.path} ${phase}`)
}

test('a clean zero exit is a provisional pass with verified resources and cleaned scratch', async t => {
  const f = fixture(t)
  f.writeChecker('process.stdout.write("gate-ok\\n")')
  const execution = await executeGate(f.definition(), options(f))
  assert.equal(execution.outcome, 'pass')
  assert.equal(execution.exitCode, 0)
  assert.equal(execution.signal, null)
  assert.equal(execution.reasonCode, null)
  assert.equal(execution.stdout, 'gate-ok\n')
  assert.equal(execution.timedOut, false)
  assertResourceVerified(execution, 'pre')
  assertResourceVerified(execution, 'post')
  assert.equal(execution.scratchCleaned, true)
  assert.equal(existsSync(execution.scratchPath!), false, 'the scratch area must be removed after a known exit')
})

test('the child environment is constructed, scratch-bound and free of ambient state', async t => {
  const f = fixture(t)
  process.env.AMBIENT_SECRET = 'ambient-value'
  t.after(() => { delete process.env.AMBIENT_SECRET })
  f.writeChecker([
    'const fs = require("node:fs")',
    'const report = {',
    '  lang: process.env.LANG, lc: process.env.LC_ALL, mark: process.env.GATE_TEST_MARK,',
    '  home: process.env.HOME, tmp: process.env.TMPDIR, cwd: process.cwd(),',
    '  argv: process.argv.slice(-2), pathSet: Object.hasOwn(process.env, "PATH"),',
    '  ambient: process.env.AMBIENT_SECRET === undefined, stdinEmpty: fs.readFileSync(0, "utf8") === "",',
    '}',
    'process.stdout.write(JSON.stringify(report))',
  ].join('\n'))
  const execution = await executeGate(f.definition({ argv: ['one', 'two'] }), options(f))
  assert.equal(execution.outcome, 'pass')
  const report = JSON.parse(execution.stdout) as Record<string, unknown>
  assert.equal(report.lang, 'C.UTF-8')
  assert.equal(report.lc, 'C.UTF-8')
  assert.equal(report.mark, 'ok')
  assert.equal(report.cwd, f.project)
  assert.deepEqual(report.argv, ['one', 'two'])
  assert.equal(report.pathSet, false, 'PATH must never be inherited')
  assert.equal(report.ambient, true, 'ambient Runner environment must never reach the child')
  assert.equal(report.stdinEmpty, true, 'stdin is ignored, the child reads EOF')
  assert.equal(String(report.home), `${execution.scratchPath}/home`)
  assert.equal(String(report.tmp), `${execution.scratchPath}/tmp`)
})

test('a nonzero exit is nonzero, never a pass', async t => {
  const f = fixture(t)
  f.writeChecker('process.exit(3)')
  const execution = await executeGate(f.definition(), options(f))
  assert.equal(execution.outcome, 'nonzero')
  assert.equal(execution.exitCode, 3)
  assert.equal(execution.scratchCleaned, true)
})

test('an unspawnable declared executable is an explicit spawn error', async t => {
  const f = fixture(t)
  f.writeChecker('process.exit(0)', false) // digest matches the pin, exec bit missing
  const execution = await executeGate(f.definition(), options(f))
  assert.equal(execution.outcome, 'spawn_error')
  assert.match(String(execution.reasonCode), /^spawn_[a-z0-9_]+$/)
  assert.equal(execution.exitCode, null)
  assert.equal(existsSync(execution.scratchPath!), false)
})

test('an output-cap breach is output_limit with capped evidence', async t => {
  const f = fixture(t)
  f.writeChecker('const blob = "x".repeat(4096); for (let i = 0; i < 200; i += 1) process.stdout.write(blob)')
  const execution = await executeGate(f.definition({ outputBytes: 64 }), options(f))
  assert.equal(execution.outcome, 'output_limit')
  assert.equal(execution.stdoutBytes, 64)
  assert.equal(Buffer.byteLength(execution.stdout), 64)
  assert.equal(execution.timedOut, false)
  assert.ok(execution.endedAt - execution.startedAt < 4000)
  assert.equal(execution.scratchCleaned, true)
})

test('a timeout requests cooperative termination and reports timeout, never a pass', async t => {
  const f = fixture(t)
  f.writeChecker('setTimeout(() => {}, 5000)')
  const execution = await executeGate(f.definition({ timeoutMs: 100 }), options(f))
  assert.equal(execution.outcome, 'timeout')
  assert.equal(execution.timedOut, true)
  assert.equal(execution.exitCode, null)
  assert.ok(execution.endedAt - execution.startedAt >= 100)
  assert.ok(execution.endedAt - execution.startedAt < 2000, 'the run must end inside the grace window')
  assert.equal(execution.scratchCleaned, true)
})

test('a child that ignores the cooperative request stays unknown and its scratch is quarantined', async t => {
  const f = fixture(t)
  f.writeChecker([
    'process.on("SIGTERM", () => { setTimeout(() => process.exit(0), 400) })',
    'setTimeout(() => {}, 5000)',
  ].join('\n'))
  const execution = await executeGate(f.definition({ timeoutMs: 200 }), options(f, { graceMs: 150 }))
  assert.equal(execution.outcome, 'unknown')
  assert.equal(execution.reasonCode, 'child_unterminated')
  assert.equal(execution.timedOut, true)
  assert.equal(execution.scratchCleaned, false)
  assert.equal(existsSync(execution.scratchPath!), true, 'an uncertain child must leave its scratch quarantined')
  await sleep(900) // the child exits on its own afterwards; no kill escalation occurred
  assert.equal(existsSync(execution.scratchPath!), true)
})

test('declared-resource drift before spawn is gate_changed and never runs the child', async t => {
  const f = fixture(t)
  f.writeChecker('process.exit(0)')
  const definition = f.definition() // frozen before the mutation
  writeFileSync(f.policyPath, 'policy-v2\n')
  const execution = await executeGate(definition, options(f))
  assert.equal(execution.outcome, 'gate_changed')
  assert.equal(execution.reasonCode, 'resource_changed_pre')
  assert.equal(execution.exitCode, null)
  assert.equal(execution.scratchPath, null, 'no scratch is created when the child never runs')
  assert.equal(execution.resourceChecks[1]!.pre, 'changed')
  assert.equal(execution.resourceChecks[1]!.post, null)
})

test('a missing or unreadable declared resource is nonaccepting before spawn', async t => {
  const f = fixture(t)
  f.writeChecker('process.exit(0)')
  const definition = f.definition()
  rmSync(f.policyPath)
  const missing = await executeGate(definition, options(f))
  assert.equal(missing.outcome, 'gate_changed')
  assert.equal(missing.reasonCode, 'resource_missing_pre')
  writeFileSync(f.policyPath, 'policy-v1\n')
  chmodSync(f.policyPath, 0o000)
  const unreadable = await executeGate(definition, options(f))
  assert.equal(unreadable.outcome, 'gate_changed')
  assert.equal(unreadable.reasonCode, 'resource_unreadable_pre')
})

test('executable drift before spawn is gate_changed', async t => {
  const f = fixture(t)
  f.writeChecker('process.exit(0)')
  const definition = f.definition() // frozen before the mutation
  writeFileSync(f.checkerPath, `#!${process.execPath}\nprocess.exit(1)\nmutated\n`)
  const execution = await executeGate(definition, options(f))
  assert.equal(execution.outcome, 'gate_changed')
  assert.equal(execution.reasonCode, 'executable_drift_pre')
})

test('a child that mutates a declared resource yields gate_changed even on exit zero', async t => {
  const f = fixture(t)
  f.writeChecker('require("node:fs").appendFileSync(process.cwd() + "/policy.txt", "mutated\\n")')
  const execution = await executeGate(f.definition(), options(f))
  assert.equal(execution.outcome, 'gate_changed')
  assert.equal(execution.reasonCode, 'resource_changed_post')
  assert.equal(execution.exitCode, 0, 'the zero exit is recorded truthfully')
})

test('scratch overflow is an explicit unknown with the scratch quarantined', async t => {
  const f = fixture(t)
  f.writeChecker('for (let i = 0; i < 10; i += 1) require("node:fs").writeFileSync(process.env.TMPDIR + "/f" + i, "x")')
  const manyEntries = await executeGate(f.definition(), options(f, { scratchEntryBound: 5 }))
  assert.equal(manyEntries.outcome, 'unknown')
  assert.equal(manyEntries.reasonCode, 'scratch_bound_exceeded')
  assert.equal(manyEntries.exitCode, 0)
  assert.equal(manyEntries.scratchCleaned, false)
  assert.equal(existsSync(manyEntries.scratchPath!), true)
  f.writeChecker('require("node:fs").writeFileSync(process.env.TMPDIR + "/big", "x".repeat(200))')
  const tooManyBytes = await executeGate(f.definition(), options(f, { scratchByteBound: 64 }))
  assert.equal(tooManyBytes.outcome, 'unknown')
  assert.equal(tooManyBytes.reasonCode, 'scratch_bound_exceeded')
  assert.ok(tooManyBytes.scratchBytes > 64)
  assert.equal(existsSync(tooManyBytes.scratchPath!), true)
})

test('out-of-bounds definitions and options are rejected before any child runs', async t => {
  const f = fixture(t)
  f.writeChecker('process.exit(0)')
  await assert.rejects(executeGate(f.definition({ argv: Array.from({ length: 65 }, () => 'a') }), options(f)), /argv exceeds/)
  await assert.rejects(executeGate(f.definition({ timeoutMs: 99 }), options(f)), /timeoutMs/)
  await assert.rejects(executeGate(f.definition({ outputBytes: 0 }), options(f)), /outputBytes/)
  await assert.rejects(
    executeGate(f.definition({ environment: [{ name: 'PATH', value: '/tmp' }] }), options(f)),
    /reserved/,
  )
  await assert.rejects(
    executeGate(f.definition({ environment: Array.from({ length: 33 }, (_, index) => ({ name: `V_${index}`, value: 'x' })) }), options(f)),
    /at most 32/,
  )
  await assert.rejects(
    executeGate(f.definition({ environment: [{ name: 'GATE_TOKEN', value: 'x' }] }), options(f)),
    /secret/,
  )
  await assert.rejects(executeGate(f.definition({ executable: 'checker.cjs' }), options(f)), /absolute/)
  await assert.rejects(
    executeGate(f.definition(), { scratchRoot: join(f.root, 'absent'), graceMs: 400 }),
    /scratch root/,
  )
  await assert.rejects(executeGate(f.definition(), options(f, { graceMs: 10 })), /graceMs/)
})