import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Installation seam red tests.
 *
 * These tests intentionally use only the injected fake Omarchy ports. The
 * implementation must expose the same ports to the human-authorized setup
 * path. No real filesystem, shell IPC, QML host, or user configuration is
 * touched here.
 */

type CompanionModules = Record<string, any>

let modulesPromise: Promise<CompanionModules> | undefined

async function modules(): Promise<CompanionModules> {
  modulesPromise ??= Promise.all([
    import('../contracts.ts'),
    import('../installation.ts'),
    import('../fake-omarchy.ts'),
  ]).then(([contracts, installation, fake]) => ({ ...contracts, ...installation, ...fake }))
  return modulesPromise
}

const PLUGIN_ID = 'omarchestra.agent-console'
const PLUGIN_VERSION = '0.2.0'
const PROTOCOL_ID = 'omarchestra.companion/v1'
const COMPATIBILITY = {
  omarchy: '4.0.2-1',
  quickshell: '0.3.1-1',
}

const BASE_ASSETS: Record<string, string> = {
  'manifest.json': JSON.stringify({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Omarchestra Agent Console',
    version: PLUGIN_VERSION,
    author: 'Omarchestra',
    license: 'MIT',
    description: 'Presentation-only Agent Console cards for a committed team projection.',
    kinds: ['panel'],
    activation: 'on-demand',
    entryPoints: { panel: 'AgentConsole.qml' },
  }),
  'AgentConsole.qml': 'import QtQuick\nItem { function open(payloadJson) {} function close() {} }\n',
  'AgentConsoleCards.qml': 'import QtQuick\nItem {}\n',
}

function release(version: string = PLUGIN_VERSION, changes: Record<string, string> = {}): Record<string, any> {
  const assets = { ...BASE_ASSETS, ...changes }
  assets['manifest.json'] = JSON.stringify({
    schemaVersion: 1,
    id: PLUGIN_ID,
    name: 'Omarchestra Agent Console',
    version,
    author: 'Omarchestra',
    license: 'MIT',
    description: 'Presentation-only Agent Console cards for a committed team projection.',
    kinds: ['panel'],
    activation: 'on-demand',
    entryPoints: { panel: 'AgentConsole.qml' },
  })
  return {
    pluginId: PLUGIN_ID,
    version,
    protocol: PROTOCOL_ID,
    compatibility: { ...COMPATIBILITY },
    assets,
  }
}

const RELEASE_V1 = release()
const RELEASE_V2 = release('0.2.1', {
  'AgentConsole.qml': 'import QtQuick\nItem { property string release: "0.2.1" }\n',
})

async function harness(options: Record<string, any> = {}): Promise<{ fake: any; installer: any }> {
  const { FakeOmarchy, CompanionInstallation } = await modules()
  const fake = new FakeOmarchy({
    compatibility: { ...COMPATIBILITY },
    ...options,
  })
  const installer = new CompanionInstallation(fake.ports())
  return { fake, installer }
}

async function planFor(
  installer: any,
  operation: 'install' | 'update' | 'rollback' | 'uninstall',
  pluginRelease?: Record<string, any>,
): Promise<any> {
  return installer.inspect({ operation, release: pluginRelease })
}

function authorize(fake: any, plan: any, overrides: Record<string, any> = {}): any {
  return fake.authorization.grant(plan, overrides)
}

function forgedAuthorization(plan: any, overrides: Record<string, any> = {}): Record<string, any> {
  return {
    operation: plan.operation,
    planDigest: plan.planDigest,
    authorizationId: 'forged-authorization',
    token: 'not-issued-by-the-fake-authorizer',
    ...overrides,
  }
}

function fingerprint(fake: any): any {
  return structuredClone(fake.fingerprint())
}

function clearMutations(fake: any): void {
  fake.clearMutationLog()
}

function mutationLog(fake: any): any[] {
  return fake.mutationLog()
}

function errorHasCode(codes: RegExp): (error: any) => boolean {
  return (error: any) => {
    const code = String(error?.code ?? error?.name ?? '')
    return codes.test(code) || codes.test(String(error?.message ?? ''))
  }
}

async function assertRejected(
  operation: Promise<unknown> | (() => unknown),
  codes: RegExp,
): Promise<void> {
  await assert.rejects(operation, errorHasCode(codes))
}

async function assertRejectedWithoutWrites(
  fake: any,
  operation: Promise<unknown> | (() => unknown),
  codes: RegExp,
): Promise<void> {
  const before = fingerprint(fake)
  clearMutations(fake)
  await assertRejected(operation, codes)
  assert.deepEqual(fingerprint(fake), before, 'rejected installation operation must preserve every fake byte')
  assert.deepEqual(mutationLog(fake), [], 'rejected installation operation must perform zero writes')
}

/**
 * Invalid current state may be rejected while planning or immediately before
 * execution. Both are required to be fail-closed and neither may write.
 */
async function assertPlanOrExecutionRejected(
  fake: any,
  installer: any,
  operation: 'install' | 'update' | 'rollback' | 'uninstall',
  pluginRelease: Record<string, any> | undefined,
  codes: RegExp,
): Promise<void> {
  const before = fingerprint(fake)
  clearMutations(fake)
  let plan: any
  try {
    plan = await planFor(installer, operation, pluginRelease)
  } catch (error) {
    assert.equal(errorHasCode(codes)(error), true, `unexpected installation planning error: ${String(error)}`)
    assert.deepEqual(fingerprint(fake), before, 'rejected plan must preserve every fake byte')
    assert.deepEqual(mutationLog(fake), [], 'rejected plan must perform zero writes')
    return
  }
  assert.deepEqual(fingerprint(fake), before, 'planning must be read-only')
  assert.deepEqual(mutationLog(fake), [], 'planning must perform zero writes')
  await assertRejectedWithoutWrites(fake, () => installer.execute(plan, authorize(fake, plan)), codes)
}

async function installAuthorized(
  fake: any,
  installer: any,
  pluginRelease: Record<string, any> = RELEASE_V1,
): Promise<{ plan: any; result: any }> {
  const plan = await planFor(installer, 'install', pluginRelease)
  const result = await installer.execute(plan, authorize(fake, plan))
  return { plan, result }
}

async function updateAuthorized(
  fake: any,
  installer: any,
  pluginRelease: Record<string, any> = RELEASE_V2,
): Promise<{ plan: any; result: any }> {
  const plan = await planFor(installer, 'update', pluginRelease)
  const result = await installer.execute(plan, authorize(fake, plan))
  return { plan, result }
}

test('the contract pins one persistent plugin, protocol, release, and exact host compatibility', async () => {
  const {
    COMPANION_PLUGIN_ID,
    COMPANION_PLUGIN_VERSION,
    COMPANION_PROTOCOL_ID,
    SUPPORTED_COMPATIBILITY,
  } = await modules()

  assert.equal(COMPANION_PLUGIN_ID, PLUGIN_ID)
  assert.equal(COMPANION_PLUGIN_VERSION, PLUGIN_VERSION)
  assert.equal(COMPANION_PROTOCOL_ID, PROTOCOL_ID)
  assert.deepEqual(SUPPORTED_COMPATIBILITY, COMPATIBILITY)
})

test('inspection is read-only and returns an immutable plan snapshot with a stable digest', async () => {
  const { fake, installer } = await harness()
  const inputRelease = release()
  const plan = await planFor(installer, 'install', inputRelease)

  assert.equal(plan.operation, 'install')
  assert.equal(plan.pluginId, PLUGIN_ID)
  assert.equal(plan.release.version, PLUGIN_VERSION)
  assert.deepEqual(plan.compatibility, COMPATIBILITY)
  assert.equal(typeof plan.planDigest, 'string')
  assert.ok(plan.planDigest.length > 0)
  assert.equal(Object.isFrozen(plan), true)
  assert.equal(Object.isFrozen(plan.release), true)
  assert.equal(Object.isFrozen(plan.release.assets), true)
  assert.deepEqual(mutationLog(fake), [])

  const digest = plan.planDigest
  inputRelease.version = '9.9.9'
  inputRelease.assets['AgentConsole.qml'] = 'caller mutation must not alter the plan'
  assert.equal(plan.release.version, PLUGIN_VERSION)
  assert.notEqual(plan.release.assets['AgentConsole.qml'], inputRelease.assets['AgentConsole.qml'])
  assert.equal(plan.planDigest, digest)

  assert.throws(() => {
    plan.operation = 'uninstall'
  }, TypeError)
  assert.throws(() => {
    plan.release.assets['foreign.txt'] = 'mutation'
  }, TypeError)
})

test('authorization is bound to the exact immutable plan and operation', async () => {
  const { fake, installer } = await harness()
  const installPlan = await planFor(installer, 'install', RELEASE_V1)
  const updatePlan = await planFor(installer, 'update', RELEASE_V2)

  await assertRejectedWithoutWrites(
    fake,
    () => installer.execute(installPlan, undefined),
    /authoriz|permission|grant|plan/i,
  )
  await assertRejectedWithoutWrites(
    fake,
    () => installer.execute(installPlan, forgedAuthorization(installPlan, { planDigest: 'wrong-digest' })),
    /authoriz|permission|grant|digest|plan/i,
  )
  await assertRejectedWithoutWrites(
    fake,
    () => installer.execute(installPlan, authorize(fake, updatePlan)),
    /authoriz|operation|digest|plan/i,
  )
  await assertRejectedWithoutWrites(
    fake,
    () => installer.execute(installPlan, forgedAuthorization(installPlan)),
    /authoriz|permission|grant|token/i,
  )
})

test('every install, update, rollback, and uninstall operation rejects forged authorization without writes', async () => {
  const { fake, installer } = await harness()
  await installAuthorized(fake, installer, RELEASE_V1)

  const updatePlan = await planFor(installer, 'update', RELEASE_V2)
  await assertRejectedWithoutWrites(
    fake,
    () => installer.execute(updatePlan, forgedAuthorization(updatePlan, { planDigest: 'wrong-update-digest' })),
    /authoriz|permission|grant|digest|plan/i,
  )

  await updateAuthorized(fake, installer, RELEASE_V2)
  const rollbackPlan = await planFor(installer, 'rollback', RELEASE_V1)
  await assertRejectedWithoutWrites(
    fake,
    () => installer.execute(rollbackPlan, forgedAuthorization(rollbackPlan)),
    /authoriz|permission|grant|token|plan/i,
  )

  const uninstallPlan = await planFor(installer, 'uninstall')
  await assertRejectedWithoutWrites(
    fake,
    () => installer.execute(uninstallPlan, forgedAuthorization(uninstallPlan, { operation: 'update' })),
    /authoriz|operation|grant|plan/i,
  )
})

test('compatibility is pinned exactly and unknown host versions fail before mutation', async () => {
  for (const compatibility of [
    { omarchy: '4.0.2-2', quickshell: COMPATIBILITY.quickshell },
    { omarchy: COMPATIBILITY.omarchy, quickshell: '0.3.1-2' },
    { omarchy: 'unknown', quickshell: 'unknown' },
  ]) {
    const { fake, installer } = await harness({ compatibility })
    await assertPlanOrExecutionRejected(fake, installer, 'install', RELEASE_V1, /compatib|version|unsupported/i)
  }

  const { fake, installer } = await harness()
  const plan = await planFor(installer, 'install', RELEASE_V1)
  fake.setCompatibility({ omarchy: '4.0.2-2', quickshell: COMPATIBILITY.quickshell })
  await assertRejectedWithoutWrites(
    fake,
    () => installer.execute(plan, authorize(fake, plan)),
    /compatib|version|stale|precondition/i,
  )
})

test('a plan is stale when shell or host state changes after inspection', async () => {
  const { fake, installer } = await harness()
  const plan = await planFor(installer, 'install', RELEASE_V1)
  const authorization = authorize(fake, plan)

  fake.configuration.setShellJsonBytes(`${fake.configuration.shellJsonBytes()}\n`)
  await assertRejectedWithoutWrites(fake, () => installer.execute(plan, authorization), /stale|precondition|digest|changed/i)

  const second = await harness()
  const secondPlan = await planFor(second.installer, 'install', RELEASE_V1)
  const secondAuthorization = authorize(second.fake, secondPlan)
  second.fake.filesystem.addForeignFile(second.fake.paths.pluginRoot, 'unexpected-before-apply.txt', 'foreign')
  await assertRejectedWithoutWrites(
    second.fake,
    () => second.installer.execute(secondPlan, secondAuthorization),
    /stale|foreign|extra|asset|precondition/i,
  )
})

test('symlinked ancestors, plugin roots, manifests, and assets are rejected without following them', async () => {
  const cases = [
    async (fake: any) => fake.filesystem.addSymlink(fake.paths.pluginsRoot),
    async (fake: any) => fake.filesystem.addSymlink(fake.paths.pluginRoot),
    async (fake: any) => {
      fake.filesystem.ensureDirectory(fake.paths.pluginRoot)
      fake.filesystem.addSymlink(fake.paths.manifestPath)
    },
    async (fake: any) => {
      fake.filesystem.ensureDirectory(fake.paths.pluginRoot)
      fake.filesystem.addSymlink(fake.paths.asset('AgentConsole.qml'))
    },
  ]

  for (const prepare of cases) {
    const { fake, installer } = await harness()
    await prepare(fake)
    await assertPlanOrExecutionRejected(fake, installer, 'install', RELEASE_V1, /symlink|unsafe|path/i)
  }
})

test('foreign ownership and unsafe modes on every installation component fail closed', async () => {
  const cases = [
    async (fake: any) => {
      fake.filesystem.ensureDirectory(fake.paths.pluginsRoot)
      fake.filesystem.setMetadata(fake.paths.pluginsRoot, { owner: 'foreign-user' })
    },
    async (fake: any) => {
      fake.filesystem.ensureDirectory(fake.paths.pluginsRoot)
      fake.filesystem.setMetadata(fake.paths.pluginsRoot, { mode: 0o777 })
    },
    async (fake: any) => {
      fake.filesystem.ensureDirectory(fake.paths.pluginRoot)
      fake.filesystem.setMetadata(fake.paths.pluginRoot, { owner: 'foreign-user' })
    },
    async (fake: any) => {
      fake.filesystem.ensureDirectory(fake.paths.pluginRoot)
      fake.filesystem.addFile(fake.paths.manifestPath, BASE_ASSETS['manifest.json'])
      fake.filesystem.setMetadata(fake.paths.manifestPath, { owner: 'foreign-user' })
    },
    async (fake: any) => {
      fake.filesystem.ensureDirectory(fake.paths.pluginRoot)
      fake.filesystem.addFile(fake.paths.manifestPath, BASE_ASSETS['manifest.json'])
      fake.filesystem.setMetadata(fake.paths.manifestPath, { mode: 0o777 })
    },
  ]

  for (const prepare of cases) {
    const { fake, installer } = await harness()
    await prepare(fake)
    await assertPlanOrExecutionRejected(fake, installer, 'install', RELEASE_V1, /owner|mode|permission|unsafe|foreign/i)
  }
})

test('malformed shell.json is rejected before plugin assets or enablement can change', async () => {
  const { fake, installer } = await harness()
  fake.configuration.setShellJsonBytes('{ this is not json')
  await assertPlanOrExecutionRejected(fake, installer, 'install', RELEASE_V1, /shell|json|config|malformed/i)
})

test('conflicting or duplicate shell enablement is rejected without rewriting unrelated configuration', async () => {
  for (const prepare of [
    (fake: any) => fake.configuration.addConflictingPluginEntry(PLUGIN_ID, '/foreign/plugin'),
    (fake: any) => fake.configuration.addDuplicateEnabledPlugin(PLUGIN_ID),
  ]) {
    const { fake, installer } = await harness()
    prepare(fake)
    const before = fake.configuration.shellJsonBytes()
    await assertPlanOrExecutionRejected(fake, installer, 'install', RELEASE_V1, /conflict|duplicate|shell|config|foreign/i)
    assert.equal(fake.configuration.shellJsonBytes(), before)
  }
})

test('a pre-existing plugin target without a verified receipt is foreign and cannot be adopted', async () => {
  const { fake, installer } = await harness()
  fake.seedForeignPlugin({
    pluginId: PLUGIN_ID,
    assets: { ...BASE_ASSETS },
  })
  await assertPlanOrExecutionRejected(fake, installer, 'install', RELEASE_V1, /foreign|receipt|owned|collision/i)
})

test('clean install writes the exact release, receipt, and supported enablement while preserving unrelated resources', async () => {
  const { fake, installer } = await harness()
  const unrelatedBefore = fake.unrelatedFingerprint()
  const shellBefore = fake.configuration.shellJsonBytes()
  const { plan, result } = await installAuthorized(fake, installer)

  assert.equal(result.operation, 'install')
  assert.equal(result.pluginId, PLUGIN_ID)
  assert.equal(result.version, PLUGIN_VERSION)
  assert.equal(fake.installedRelease().version, PLUGIN_VERSION)
  assert.deepEqual(fake.installedAssetNames(), Object.keys(RELEASE_V1.assets).sort())
  assert.deepEqual(fake.unrelatedFingerprint(), unrelatedBefore)
  assert.equal(fake.configuration.shellJsonBytes() === shellBefore, false)
  assert.equal(fake.configuration.enabledPluginCount(PLUGIN_ID), 1)
  const installShellCalls = fake.shell.calls().map((call: any) => call.operation)
  assert.deepEqual(new Set(installShellCalls), new Set(['rescan', 'enable']))
  assert.equal(installShellCalls.some((operation: string) => operation === 'writeShellJson'), false)

  const receipt = fake.receipt()
  assert.equal(receipt.pluginId, PLUGIN_ID)
  assert.equal(receipt.release.version, PLUGIN_VERSION)
  assert.deepEqual(receipt.compatibility, COMPATIBILITY)
  assert.equal(typeof receipt.planDigest, 'string')
  assert.equal(typeof receipt.installedAt, 'string')
  assert.equal(typeof receipt.shellJson.preimageHash, 'string')
  assert.equal(typeof receipt.shellJson.postimageHash, 'string')
  assert.deepEqual(
    receipt.assets.map((asset: any) => asset.relativePath).sort(),
    Object.keys(RELEASE_V1.assets).sort(),
  )
  for (const asset of receipt.assets) {
    assert.equal(typeof asset.sha256, 'string')
    assert.equal(typeof asset.owner, 'string')
    assert.equal(typeof asset.mode, 'number')
    assert.equal(asset.path, fake.paths.asset(asset.relativePath))
  }
  assert.equal(plan.planDigest, receipt.planDigest)
})

test('update replaces only the verified owned release and records the previous release for rollback', async () => {
  const { fake, installer } = await harness()
  await installAuthorized(fake, installer, RELEASE_V1)
  const unrelatedBefore = fake.unrelatedFingerprint()
  const before = fake.installationFingerprint()

  const { plan, result } = await updateAuthorized(fake, installer, RELEASE_V2)
  assert.equal(result.operation, 'update')
  assert.equal(fake.installedRelease().version, '0.2.1')
  assert.notDeepEqual(fake.installationFingerprint(), before)
  assert.deepEqual(fake.unrelatedFingerprint(), unrelatedBefore)
  assert.equal(fake.configuration.enabledPluginCount(PLUGIN_ID), 1)
  assert.equal(fake.receipt().release.version, '0.2.1')
  assert.equal(fake.receipt().previousRelease.version, PLUGIN_VERSION)
  assert.equal(plan.release.version, '0.2.1')
})

test('missing, extra, or changed owned assets make update and uninstall fail before mutation', async () => {
  const mutations = [
    (fake: any) => fake.filesystem.remove(fake.paths.asset('AgentConsole.qml')),
    (fake: any) => fake.filesystem.addFile(fake.paths.asset('unexpected.txt'), 'foreign extra asset'),
    (fake: any) => fake.filesystem.writeBytes(fake.paths.asset('AgentConsole.qml'), 'changed after install'),
  ]

  for (const mutate of mutations) {
    const { fake, installer } = await harness()
    await installAuthorized(fake, installer, RELEASE_V1)
    mutate(fake)
    await assertPlanOrExecutionRejected(fake, installer, 'update', RELEASE_V2, /asset|changed|missing|extra|foreign|receipt/i)
    await assertPlanOrExecutionRejected(fake, installer, 'uninstall', undefined, /asset|changed|missing|extra|foreign|receipt/i)
  }
})

test('missing, tampered, or inconsistent receipts never authorize destructive operations', async () => {
  const tamper = [
    (fake: any) => fake.receipts.remove(),
    (fake: any) => fake.receipts.replace({ pluginId: PLUGIN_ID, release: RELEASE_V1 }),
    (fake: any) => fake.receipts.mutate((receipt: any) => {
      receipt.assets[0].sha256 = 'tampered-hash'
    }),
    (fake: any) => fake.receipts.setMetadata({ owner: 'foreign-user' }),
    (fake: any) => fake.receipts.setMetadata({ mode: 0o644 }),
  ]

  for (const change of tamper) {
    const { fake, installer } = await harness()
    await installAuthorized(fake, installer, RELEASE_V1)
    change(fake)
    const before = fingerprint(fake)
    await assertPlanOrExecutionRejected(fake, installer, 'update', RELEASE_V2, /receipt|owned|hash|invalid|tamper/i)
    await assertPlanOrExecutionRejected(fake, installer, 'uninstall', undefined, /receipt|owned|hash|invalid|tamper/i)
    assert.deepEqual(fingerprint(fake), before)
  }
})

test('forced install and update failures recover the exact prior state', async () => {
  {
    const { fake, installer } = await harness()
    const before = fingerprint(fake)
    fake.failAt('after-plugin-assets')
    const plan = await planFor(installer, 'install', RELEASE_V1)
    await assertRejected(() => installer.execute(plan, authorize(fake, plan)), /failure|recovery|rollback|install/i)
    assert.deepEqual(fake.fingerprint(), before)
    assert.equal(fake.lastRecovery().complete, true)
    assert.equal(fake.installedPluginExists(), false)
  }

  {
    const { fake, installer } = await harness()
    await installAuthorized(fake, installer, RELEASE_V1)
    const before = fingerprint(fake)
    fake.failAt('after-shell-enable')
    const plan = await planFor(installer, 'update', RELEASE_V2)
    await assertRejected(() => installer.execute(plan, authorize(fake, plan)), /failure|recovery|rollback|update/i)
    assert.deepEqual(fake.fingerprint(), before)
    assert.equal(fake.lastRecovery().complete, true)
    assert.equal(fake.installedRelease().version, PLUGIN_VERSION)
  }
})

test('incomplete recovery is reported and never overwrites state drift introduced during recovery', async () => {
  const { fake, installer } = await harness()
  await installAuthorized(fake, installer, RELEASE_V1)
  const before = fingerprint(fake)
  fake.failAt('after-plugin-assets')
  fake.failRecoveryWithDrift({
    path: fake.paths.asset('AgentConsole.qml'),
    bytes: 'drifted while recovery was in progress',
  })
  const plan = await planFor(installer, 'update', RELEASE_V2)
  await assertRejected(() => installer.execute(plan, authorize(fake, plan)), /incomplete|recovery|drift|changed/i)
  assert.equal(fake.lastRecovery().complete, false)
  assert.equal(fake.lastRecovery().incomplete, true)
  assert.notDeepEqual(fake.fingerprint(), before, 'the externally drifted state must not be overwritten')
  assert.equal(fake.filesystem.readBytes(fake.paths.asset('AgentConsole.qml')), 'drifted while recovery was in progress')
})

test('rollback is explicit, receipt-backed, and restores the exact prior release', async () => {
  const { fake, installer } = await harness()
  await installAuthorized(fake, installer, RELEASE_V1)
  await updateAuthorized(fake, installer, RELEASE_V2)
  const before = fake.unrelatedFingerprint()

  const plan = await planFor(installer, 'rollback', RELEASE_V1)
  assert.equal(plan.operation, 'rollback')
  const result = await installer.execute(plan, authorize(fake, plan))

  assert.equal(result.operation, 'rollback')
  assert.equal(fake.installedRelease().version, PLUGIN_VERSION)
  assert.deepEqual(fake.unrelatedFingerprint(), before)
  assert.equal(fake.configuration.enabledPluginCount(PLUGIN_ID), 1)
  assert.equal(fake.receipt().release.version, PLUGIN_VERSION)
})

test('rollback refuses a drifted current installation rather than overwriting it', async () => {
  const { fake, installer } = await harness()
  await installAuthorized(fake, installer, RELEASE_V1)
  await updateAuthorized(fake, installer, RELEASE_V2)
  fake.filesystem.writeBytes(fake.paths.asset('AgentConsole.qml'), 'drift introduced outside Omarchestra')
  const before = fingerprint(fake)

  await assertPlanOrExecutionRejected(fake, installer, 'rollback', RELEASE_V1, /changed|drift|receipt|owned|hash/i)
  assert.deepEqual(fake.fingerprint(), before)
})

test('exact uninstall restores the recorded shell preimage and removes only owned plugin state', async () => {
  const { fake, installer } = await harness()
  const before = fingerprint(fake)
  const shellBefore = fake.configuration.shellJsonBytes()
  const unrelatedBefore = fake.unrelatedFingerprint()
  await installAuthorized(fake, installer, RELEASE_V1)

  const plan = await planFor(installer, 'uninstall')
  const result = await installer.execute(plan, authorize(fake, plan))

  assert.equal(result.operation, 'uninstall')
  assert.equal(fake.installedPluginExists(), false)
  assert.equal(fake.receiptExists(), false)
  assert.equal(fake.configuration.shellJsonBytes(), shellBefore)
  assert.equal(fake.configuration.enabledPluginCount(PLUGIN_ID), 0)
  assert.deepEqual(fake.unrelatedFingerprint(), unrelatedBefore)
  assert.deepEqual(fake.fingerprint(), before)
  const uninstallShellCalls = fake.shell.calls().map((call: any) => call.operation)
  assert.deepEqual(new Set(uninstallShellCalls), new Set(['rescan', 'enable', 'disable']))
  assert.equal(uninstallShellCalls.filter((operation: string) => operation === 'rescan').length, 2)
})

test('uninstall refuses symlink, ownership, mode, and shell drift without deleting anything', async () => {
  const preparations = [
    (fake: any) => fake.filesystem.addSymlink(fake.paths.asset('AgentConsole.qml')),
    (fake: any) => fake.filesystem.setMetadata(fake.paths.pluginRoot, { owner: 'foreign-user' }),
    (fake: any) => fake.filesystem.setMetadata(fake.paths.asset('AgentConsole.qml'), { mode: 0o777 }),
    (fake: any) => fake.configuration.setShellJsonBytes(`${fake.configuration.shellJsonBytes()}\n`),
  ]

  for (const prepare of preparations) {
    const { fake, installer } = await harness()
    await installAuthorized(fake, installer, RELEASE_V1)
    prepare(fake)
    await assertPlanOrExecutionRejected(fake, installer, 'uninstall', undefined, /symlink|owner|mode|shell|changed|drift|unsafe/i)
    assert.equal(fake.installedPluginExists(), true)
    assert.equal(fake.receiptExists(), true)
  }
})

test('all unauthorized and stale destructive operations preserve unrelated resources byte-for-byte', async () => {
  const { fake, installer } = await harness()
  const unrelatedBefore = fake.unrelatedFingerprint()
  const installPlan = await planFor(installer, 'install', RELEASE_V1)
  const forged = forgedAuthorization(installPlan, { planDigest: 'stale-plan-digest' })

  await assertRejectedWithoutWrites(fake, () => installer.execute(installPlan, forged), /authoriz|digest|stale|plan/i)
  assert.deepEqual(fake.unrelatedFingerprint(), unrelatedBefore)

  await installAuthorized(fake, installer, RELEASE_V1)
  const updatePlan = await planFor(installer, 'update', RELEASE_V2)
  const unrelatedAfterPlan = fake.unrelatedFingerprint()
  fake.configuration.setShellJsonBytes(`${fake.configuration.shellJsonBytes()}\n`)
  await assertRejectedWithoutWrites(fake, () => installer.execute(updatePlan, authorize(fake, updatePlan)), /stale|authorization|precondition|digest|changed/i)
  assert.deepEqual(fake.unrelatedFingerprint(), unrelatedAfterPlan)
})
