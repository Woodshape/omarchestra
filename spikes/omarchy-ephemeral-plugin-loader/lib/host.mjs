// SPIKE — fake-only model. Not production code, no real filesystem, config,
// shell, GUI, process, or IPC action. This is the reference implementation of
// the frozen `omarchy.temporary-panel/v1` contract behind injected ports:
//
//   fs       — filesystem inspection port (see fixtures/fake-fs.mjs)
//   loader   — panel loader port (see fixtures/fake-loader.mjs)
//   config   — persistence-isolation port; must never be called
//   scan     — installed-plugin registry view (read-only)
//   identity — per-shell nonce + monotonic counters
//   clock    — deterministic async driver (validation, teardown, tombstones)
//
// Behavior is observed only through request(requestJson).

import {
  LIMITS, isPlainObject, depthOf, byteLength, truncateUtf8, diagnose,
  envelope, isSafeEntryPoint, isValidMethodName,
} from './bounds.mjs'

const ACTIVE_STATES = new Set([
  'registered_hidden', 'loading', 'summoned', 'failed', 'failed_collision', 'unregistering',
])
const TERMINAL_STATES = new Set(['unregistered'])

export function createTemporaryPanelHost({ fs, loader, config, scan, identity, clock, shellUid }) {
  void config // persistence isolation: the host never touches configuration.
  const uid = shellUid ?? (typeof process !== 'undefined' && typeof process.getuid === 'function'
    ? process.getuid()
    : 1000)

  /** operationId -> { state, ... } bounded retention */
  const operations = new Map()
  /** registrationId -> record */
  const registrations = new Map()
  /** canonical source dir -> registrationId (active claims only) */
  const bySource = new Map()
  /** plugin id -> registrationId (active claims only) */
  const byPluginId = new Map()
  /** exact register requestJson currently validating (duplicate_pending) */
  const pendingValidations = new Map()
  let operationSequence = 0

  scan.subscribe(() => recheckCollisions())

  // ------------------------------------------------------------ envelopes

  function fail(operation, codeOrPayload, message) {
    const payload = typeof codeOrPayload === 'string'
      ? { code: codeOrPayload, message }
      : codeOrPayload
    return envelope(operation, false, payload)
  }

  function ok(operation, result) {
    return envelope(operation, true, result)
  }

  function respond(parsed) {
    return JSON.stringify(parsed)
  }

  // ------------------------------------------------------------ identities

  function nextOperationId() {
    operationSequence += 1
    return truncateUtf8(`op.${identity.nonce()}.${identity.nextCounter()}`, LIMITS.identityBytes)
  }

  function nextRegistrationId() {
    return truncateUtf8(`reg.${identity.nonce()}.${identity.nextCounter()}`, LIMITS.identityBytes)
  }

  /**
   * Resolve a registration identity to its record.
   * Returns { record } | { tombstone: true } | { error: code }.
   */
  function resolveRegistration(rawId) {
    if (typeof rawId !== 'string' || rawId.length === 0
      || byteLength(rawId) > LIMITS.identityBytes || !rawId.startsWith('reg.')) {
      return { error: 'invalid_identity' }
    }
    const rest = rawId.slice(4)
    const dot = rest.lastIndexOf('.')
    const nonce = dot <= 0 ? null : rest.slice(0, dot)
    if (nonce === null || nonce !== identity.nonce()) return { error: 'stale_registration' }
    const record = registrations.get(rawId)
    if (!record) return { error: 'unknown_registration' }
    if (record.state === 'unregistered') {
      if (clock.now() > record.tombstoneExpiresAt) {
        registrations.delete(rawId)
        return { error: 'unknown_registration' }
      }
      return { tombstone: true }
    }
    return { record }
  }

  // ------------------------------------------------------------ validation

  function failCode(code, message) {
    return { ok: false, error: { code, message } }
  }

  /**
   * Full source validation per the contract's path/source/manifest rules.
   * Synchronous against the injected fs port; re-run before load and at
   * registration commit.
   */
  function validateSource(rawPath, currentRegistrationId = null) {
    if (typeof rawPath !== 'string') return failCode('path_invalid', 'path must be a string')
    if (rawPath.includes('\0') || rawPath.includes('\n')) return failCode('path_invalid', 'path must not contain NUL or newline')
    if (byteLength(rawPath) > LIMITS.pathBytes) return failCode('path_invalid', 'path exceeds 4096 bytes')
    if (!rawPath.startsWith('/')) return failCode('path_invalid', 'path must be absolute')
    const real = fs.realpath(rawPath)
    if (!real.ok || real.canonical !== rawPath) return failCode('path_invalid', 'path must already be canonical')
    let prefix = ''
    for (const part of rawPath.split('/').filter(Boolean)) {
      prefix += `/${part}`
      const component = fs.lstat(prefix)
      if (component.type === 'missing') return failCode('path_invalid', `missing component ${prefix}`)
      if (component.type === 'symlink') return failCode('symlink_component', `symlink component at ${prefix}`)
    }
    const dir = fs.lstat(rawPath)
    if (dir.type !== 'directory') return failCode('path_invalid', 'source must be a directory')
    if (dir.uid !== uid) return failCode('path_not_owned', 'source must be owned by the shell user')
    if ((dir.mode & 0o022) !== 0) return failCode('source_unsafe', 'source must not be group- or world-writable')

    const manifestPath = `${rawPath}/manifest.json`
    const manifestStat = fs.lstat(manifestPath)
    if (manifestStat.type === 'missing') return failCode('path_invalid', 'manifest.json is missing')
    if (manifestStat.type === 'symlink') return failCode('symlink_component', 'manifest.json must not be a symlink')
    if (manifestStat.type !== 'file') return failCode('path_invalid', 'manifest.json must be a regular file')
    if (manifestStat.uid !== uid) return failCode('path_not_owned', 'manifest.json must be owned by the shell user')
    const read = fs.readFile(manifestPath, LIMITS.manifestBytes)
    if (!read.ok) {
      return read.reason === 'too_large'
        ? failCode('manifest_too_large', 'manifest.json exceeds 65536 bytes')
        : failCode('path_invalid', 'manifest.json is unreadable')
    }
    let manifest
    try {
      manifest = JSON.parse(read.content)
    } catch {
      return failCode('manifest_invalid', 'manifest.json is not valid JSON')
    }
    if (!isPlainObject(manifest)) return failCode('manifest_invalid', 'manifest must be one JSON object')
    if (depthOf(manifest) > LIMITS.maxDepth) return failCode('manifest_invalid', 'manifest exceeds depth 16')
    for (const [field, bound] of [
      ['id', LIMITS.manifestIdBytes],
      ['name', LIMITS.manifestNameBytes],
      ['version', LIMITS.manifestVersionBytes],
    ]) {
      const value = manifest[field]
      if (typeof value !== 'string' || value.length === 0 || byteLength(value) > bound) {
        return failCode('manifest_invalid', `manifest field ${field} is missing or exceeds ${bound} bytes`)
      }
    }
    // Installed validator contract (mirrors PluginRegistry.validateManifest).
    if (manifest.schemaVersion !== 1) return failCode('manifest_invalid', 'unsupported schemaVersion')
    for (const required of ['id', 'name', 'version', 'kinds', 'entryPoints']) {
      if (manifest[required] === undefined) return failCode('manifest_invalid', `missing required field ${required}`)
    }
    const pluginId = String(manifest.id)
    if (pluginId.includes('/') || pluginId.includes('..') || pluginId.startsWith('/')) {
      return failCode('manifest_invalid', 'invalid plugin id')
    }
    if (!Array.isArray(manifest.kinds) || manifest.kinds.length === 0) {
      return failCode('manifest_invalid', 'kinds must be a non-empty array')
    }
    if (!isPlainObject(manifest.entryPoints)) return failCode('manifest_invalid', 'entryPoints must be an object')
    // Panel-only scope: exactly one panel kind and one panel entry point.
    if (manifest.kinds.length !== 1 || manifest.kinds[0] !== 'panel') {
      return failCode('panel_scope_required', 'only manifests with exactly kinds ["panel"] are accepted')
    }
    const entryKeys = Object.keys(manifest.entryPoints)
    if (entryKeys.length !== 1 || entryKeys[0] !== 'panel') {
      return failCode('panel_scope_required', 'exactly one panel entry point is required')
    }
    // Entry-point file checks.
    const entry = manifest.entryPoints.panel
    if (!isSafeEntryPoint(entry)) return failCode('entry_point_invalid', 'entry point must be relative and escape-free')
    if (byteLength(entry) > LIMITS.entryPointStringBytes) return failCode('entry_point_invalid', 'entry point exceeds 1024 bytes')
    const resolved = `${rawPath}/${entry}`
    if (!resolved.startsWith(`${rawPath}/`)) return failCode('entry_point_invalid', 'entry point escapes the source directory')
    let entryPrefix = rawPath
    for (const part of entry.split('/')) {
      entryPrefix += `/${part}`
      const component = fs.lstat(entryPrefix)
      if (component.type === 'missing') return failCode('entry_point_invalid', `entry point missing at ${entryPrefix}`)
      if (component.type === 'symlink') return failCode('symlink_component', `entry point symlink at ${entryPrefix}`)
    }
    const entryStat = fs.lstat(resolved)
    if (entryStat.type !== 'file') return failCode('entry_point_invalid', 'entry point must be a regular file')
    if (entryStat.uid !== uid) return failCode('path_not_owned', 'entry point must be owned by the shell user')
    if (entryStat.size > LIMITS.entryPointBytes) return failCode('entry_point_invalid', 'entry point exceeds its size bound')

    // Collision rules: source collisions first, then id collisions.
    const installed = scan.installedPlugins()
    for (const installedId of Object.keys(installed)) {
      const candidate = installed[installedId]
      const sourceDir = candidate && typeof candidate.__sourceDir === 'string'
        ? candidate.__sourceDir.replace(/\/$/, '')
        : ''
      if (sourceDir !== '' && sourceDir === rawPath) {
        return failCode('source_collision', 'canonical source equals an installed plugin source directory')
      }
    }
    const sourceClaim = bySource.get(rawPath)
    if (sourceClaim && sourceClaim !== currentRegistrationId) {
      return failCode('source_collision', 'canonical source is already temporarily registered')
    }
    if (pluginId.startsWith('omarchy.')) return failCode('plugin_id_collision', 'the omarchy.* namespace is reserved')
    if (installed[pluginId]) return failCode('plugin_id_collision', 'plugin id is already installed')
    const pluginIdClaim = byPluginId.get(pluginId)
    if (pluginIdClaim && pluginIdClaim !== currentRegistrationId) {
      return failCode('plugin_id_collision', 'plugin id is already temporarily registered')
    }

    return { ok: true, manifest: { ...manifest, __sourceDir: rawPath } }
  }

  function countValidating() {
    let count = 0
    for (const op of operations.values()) if (op.state === 'validating') count += 1
    return count
  }

  function countActive() {
    let count = 0
    for (const record of registrations.values()) if (ACTIVE_STATES.has(record.state)) count += 1
    return count
  }

  function evictOldOperations() {
    if (operations.size <= LIMITS.operationRecords) return
    const terminal = [...operations.entries()]
      .filter(([, op]) => op.state !== 'validating')
      .sort((a, b) => a[1].sequence - b[1].sequence)
    while (operations.size > LIMITS.operationRecords && terminal.length > 0) {
      const [id] = terminal.shift()
      operations.delete(id)
    }
  }

  // ------------------------------------------------------------ operations

  function dispatchCapabilities() {
    return ok('capabilities', {
      interface: 'omarchy.temporary-panel/v1',
      supported: true,
      scope: ['panel'],
      registration: 'asynchronous',
      persistence: 'process-memory-only',
      restart: 'registrations-cleared',
      limits: { ...LIMITS },
    })
  }

  function dispatchRegister(body, requestJson) {
    const rawPath = body.path
    if (typeof rawPath !== 'string') return fail('register', { code: 'invalid_field', message: 'path is required' })
    if (rawPath.includes('\0') || rawPath.includes('\n')) {
      return fail('register', { code: 'path_invalid', message: 'path must not contain NUL or newline' })
    }
    if (byteLength(rawPath) > LIMITS.pathBytes || !rawPath.startsWith('/')) {
      return fail('register', { code: 'path_invalid', message: 'path must be absolute and bounded' })
    }
    if (scan.state() === 'scanning') {
      return fail('register', { code: 'registry_busy', message: 'installed registry scan is unresolved' })
    }
    if (pendingValidations.has(requestJson)) {
      return fail('register', { code: 'duplicate_pending', message: 'an identical request is already validating' })
    }
    if (countValidating() + countActive() >= LIMITS.registrations) {
      return fail('register', { code: 'capacity_exceeded', message: 'registration capacity is full' })
    }
    const validated = validateSource(rawPath)
    if (!validated.ok) return fail('register', validated.error)

    const operationId = nextOperationId()
    operations.set(operationId, {
      sequence: operationSequence += 1,
      state: 'validating',
      path: rawPath,
      requestJson,
    })
    pendingValidations.set(requestJson, operationId)
    clock.schedule(() => finalizeRegistration(operationId), 0)
    return ok('register', { state: 'validating', operationId })
  }

  /** Deferred commit: revalidate the source, then register or reject. */
  function finalizeRegistration(operationId) {
    const op = operations.get(operationId)
    if (!op || op.state !== 'validating') return
    pendingValidations.delete(op.requestJson)
    const validated = validateSource(op.path)
    if (!validated.ok) {
      op.state = 'rejected'
      op.error = validated.error
      return
    }
    const registrationId = nextRegistrationId()
    const manifest = validated.manifest
    const record = {
      registrationId,
      pluginId: String(manifest.id),
      canonical: op.path,
      manifest,
      state: 'registered_hidden',
      generation: 0,
      queue: [],
      loader: null,
      item: null,
      lastError: null,
      tombstoneExpiresAt: 0,
      sequence: operationSequence += 1,
    }
    registrations.set(registrationId, record)
    bySource.set(record.canonical, registrationId)
    byPluginId.set(record.pluginId, registrationId)
    op.state = 'registered_hidden'
    op.registrationId = registrationId
    op.pluginId = record.pluginId
    evictOldOperations()
  }

  function dispatchStatus(body) {
    const operationId = body.operationId
    if (typeof operationId !== 'string' || operationId.length === 0
      || byteLength(operationId) > LIMITS.identityBytes) {
      return fail('status', { code: 'invalid_identity', message: 'operationId is malformed' })
    }
    if (!operationId.startsWith('op.')) {
      const code = operationId.startsWith('reg.') ? 'unknown_operation_id' : 'invalid_identity'
      return fail('status', { code, message: 'operationId is not a validation operation' })
    }
    const op = operations.get(operationId)
    if (!op) return fail('status', { code: 'unknown_operation_id', message: 'operation is absent or expired' })
    if (op.state === 'validating') return ok('status', { state: 'validating' })
    if (op.state === 'rejected') {
      const result = { state: 'rejected' }
      if (op.error) result.error = { code: op.error.code }
      return ok('status', result)
    }
    return ok('status', { state: 'registered_hidden', registrationId: op.registrationId, pluginId: op.pluginId })
  }

  // ------------------------------------------------------------ lifecycle

  function payloadBytes(payload) {
    try {
      return byteLength(JSON.stringify(payload))
    } catch {
      return Number.POSITIVE_INFINITY
    }
  }

  function checkPayload(payload) {
    if (payload === undefined) return null
    const serialized = (() => {
      try { return JSON.stringify(payload) } catch { return undefined }
    })()
    if (serialized === undefined) return 'invalid_payload'
    if (depthOf(payload) > LIMITS.maxDepth) return 'invalid_payload'
    if (byteLength(serialized) > LIMITS.payloadBytes) return 'invalid_payload'
    return null
  }

  function sourceStillPresent(record) {
    const validated = validateSource(record.canonical, record.registrationId)
    if (!validated.ok) return false
    return JSON.stringify(validated.manifest) === JSON.stringify(record.manifest)
  }

  function dispatchSummon(body) {
    const resolved = resolveRegistration(body.registrationId)
    if (resolved.error) return fail('summon', { code: resolved.error, message: resolved.error })
    if (resolved.tombstone) {
      return fail('summon', { code: 'unknown_registration', message: 'registration is unregistered' })
    }
    const record = resolved.record
    if (record.state === 'unregistering') {
      return fail('summon', { code: 'teardown_pending', message: 'exact teardown has not completed' })
    }
    if (record.state === 'failed' || record.state === 'failed_collision') {
      return fail('summon', { code: 'plugin_load_failed', message: diagnose(record.lastError || 'registration failed') })
    }
    const payloadProblem = checkPayload(body.payload)
    if (payloadProblem) return fail('summon', { code: payloadProblem, message: 'payload exceeds its bounds' })
    if (!sourceStillPresent(record)) {
      record.state = 'failed'
      record.lastError = 'source changed or disappeared before summon'
      return fail('summon', { code: 'source_changed', message: 'source revalidation failed' })
    }
    const openPayloadJson = JSON.stringify(body.payload ?? null)
    const queuedBytes = record.queue.reduce((total, entry) => total + entry.bytes, 0)
    if (record.queue.length >= LIMITS.queuedCallsPerRegistration) {
      return fail('summon', { code: 'queue_full', message: 'queued entry bound reached' })
    }
    if (queuedBytes + byteLength(openPayloadJson) > LIMITS.queuedBytesPerRegistration) {
      return fail('summon', { code: 'queue_full', message: 'queued bytes bound reached' })
    }
    record.queue.push({ kind: 'open', payloadJson: openPayloadJson, bytes: byteLength(openPayloadJson) })
    if (!record.loader) {
      const generation = record.generation + 1
      record.generation = generation
      const controller = loader.create({
        sourceUrl: `file://${record.canonical}/${record.manifest.entryPoints.panel}`,
        registrationId: record.registrationId,
        generation,
        shared: loader.shared,
        onLoaded: (item) => handleLoaded(record.registrationId, generation, item),
        onLoadError: (detail) => handleLoadError(record.registrationId, generation, detail),
        onDestroyed: () => {},
      })
      record.loader = controller
      if (record.state === 'registered_hidden') record.state = 'loading'
    }
    if (record.item) drainQueue(record)
    return ok('summon', { state: record.state, queued: record.queue.length })
  }

  function dispatchCall(body) {
    const resolved = resolveRegistration(body.registrationId)
    if (resolved.error) return fail('call', { code: resolved.error, message: resolved.error })
    if (resolved.tombstone) return fail('call', { code: 'unknown_registration', message: 'registration is a tombstone' })
    const record = resolved.record
    if (record.state === 'unregistering') {
      return fail('call', { code: 'teardown_pending', message: 'exact teardown has not completed' })
    }
    if (record.state !== 'loading' && record.state !== 'summoned') {
      return fail('call', { code: 'not_summoned', message: 'call requires an active or loading summon' })
    }
    if (!isValidMethodName(body.method)) {
      return fail('call', { code: 'invalid_method', message: 'method violates the call seam rules' })
    }
    const payloadProblem = checkPayload(body.payload)
    if (payloadProblem) return fail('call', { code: payloadProblem, message: 'payload exceeds its bounds' })
    const payloadJson = JSON.stringify(body.payload ?? null)
    if (record.state === 'loading') {
      const queuedBytes = record.queue.reduce((total, entry) => total + entry.bytes, 0)
      if (record.queue.length >= LIMITS.queuedCallsPerRegistration) {
        return fail('call', { code: 'queue_full', message: 'queued entry bound reached' })
      }
      if (queuedBytes + byteLength(payloadJson) > LIMITS.queuedBytesPerRegistration) {
        return fail('call', { code: 'queue_full', message: 'queued bytes bound reached' })
      }
      record.queue.push({ kind: 'call', method: body.method, payloadJson, bytes: byteLength(payloadJson) })
      return ok('call', { state: 'queued', queued: record.queue.length })
    }
    // Loaded: invoke immediately.
    if (typeof record.item[body.method] !== 'function') {
      return fail('call', { code: 'unknown_method', message: `loaded item does not expose ${body.method}` })
    }
    let value
    try {
      value = record.item[body.method](payloadJson)
    } catch (error) {
      record.lastError = diagnose(`plugin_call_failed: ${error && error.message ? error.message : 'threw'}`)
      return fail('call', { code: 'plugin_call_failed', message: 'the plugin method threw' })
    }
    const text = value === undefined || value === null ? 'ok' : String(value)
    return ok('call', { state: 'delivered', value: truncateUtf8(text, LIMITS.callValueBytes) })
  }

  function dispatchHide(body) {
    const resolved = resolveRegistration(body.registrationId)
    if (resolved.error) return fail('hide', { code: resolved.error, message: resolved.error })
    if (resolved.tombstone) return ok('hide', { changed: false, state: 'unregistered' })
    const record = resolved.record
    if (record.state === 'registered_hidden' || record.state === 'unregistering'
      || record.state === 'failed' || record.state === 'failed_collision') {
      return ok('hide', { changed: false, state: record.state })
    }
    record.generation += 1
    unloadObject(record)
    record.state = 'registered_hidden'
    return ok('hide', { changed: true, state: record.state })
  }

  function dispatchUnregister(body) {
    const resolved = resolveRegistration(body.registrationId)
    if (resolved.error) return fail('unregister', { code: resolved.error, message: resolved.error })
    if (resolved.tombstone) return ok('unregister', { changed: false, state: 'unregistered' })
    const record = resolved.record
    if (record.state === 'unregistering') {
      return ok('unregister', { changed: false, state: 'unregistering' })
    }
    unloadObject(record)
    record.generation += 1
    record.state = 'unregistering'
    clock.schedule(() => finalizeUnregister(record.registrationId), 0)
    return ok('unregister', { changed: true, state: 'unregistering' })
  }

  function finalizeUnregister(registrationId) {
    const record = registrations.get(registrationId)
    if (!record || record.state !== 'unregistering') return
    releaseClaims(record)
    record.state = 'unregistered'
    record.tombstoneExpiresAt = clock.now() + LIMITS.tombstoneMs
    pruneTombstones()
  }

  function pruneTombstones() {
    const now = clock.now()
    for (const [id, record] of registrations) {
      if (record.state === 'unregistered' && now > record.tombstoneExpiresAt) registrations.delete(id)
    }
    // Hard bound on retained tombstones: evict oldest expired-first.
    const tombstones = [...registrations.entries()]
      .filter(([, record]) => record.state === 'unregistered')
      .sort((a, b) => a[1].tombstoneExpiresAt - b[1].tombstoneExpiresAt)
    while (tombstones.length > LIMITS.tombstones) {
      const [oldest] = tombstones.shift()
      registrations.delete(oldest)
    }
  }

  function unloadObject(record) {
    record.queue = []
    if (record.item && typeof record.item.close === 'function') {
      try {
        record.item.close()
      } catch {
        record.lastError = diagnose('close() threw during unload')
      }
    }
    if (record.loader) {
      record.loader.setActive(false)
      record.loader.setSource(null)
      record.loader.destroy()
      record.loader = null
    }
    record.item = null
  }

  function releaseClaims(record) {
    if (bySource.get(record.canonical) === record.registrationId) bySource.delete(record.canonical)
    if (byPluginId.get(record.pluginId) === record.registrationId) byPluginId.delete(record.pluginId)
  }

  // ------------------------------------------------------------ loader flow

  function handleLoaded(registrationId, generation, item) {
    const record = registrations.get(registrationId)
    if (!record || record.generation !== generation || record.state !== 'loading') return
    record.item = item
    if (item && typeof item === 'object') {
      item.omarchyPath = loader.shared.omarchyPath
      item.shell = loader.shared.shellToken
      if (item.injected && typeof item.injected === 'object') {
        item.injected.omarchyPath = loader.shared.omarchyPath
        item.injected.shellToken = loader.shared.shellToken
      }
    }
    drainQueue(record)
    record.state = 'summoned'
  }

  function handleLoadError(registrationId, generation, detail) {
    const record = registrations.get(registrationId)
    if (!record || record.generation !== generation) return
    record.lastError = diagnose(`plugin_load_failed: ${detail}`)
    record.state = 'failed'
    record.queue = []
    if (record.loader) {
      record.loader.setActive(false)
      record.loader.setSource(null)
      record.loader = null
    }
    record.item = null
  }

  function drainQueue(record) {
    const entries = record.queue
    record.queue = []
    for (const entry of entries) {
      if (!record.item) break
      try {
        if (entry.kind === 'open') record.item.open(entry.payloadJson)
        else record.item[entry.method](entry.payloadJson)
      } catch (error) {
        record.lastError = diagnose(`plugin delivery failed: ${error && error.message ? error.message : 'threw'}`)
      }
    }
  }

  // ------------------------------------------------------------ rescan

  function recheckCollisions() {
    const installed = scan.installedPlugins()
    for (const record of [...registrations.values()]) {
      if (!ACTIVE_STATES.has(record.state) || record.state === 'unregistering') continue
      const idCollision = Boolean(installed[record.pluginId])
      const sourceCollision = Object.values(installed).some((candidate) => {
        const sourceDir = candidate && typeof candidate.__sourceDir === 'string'
          ? candidate.__sourceDir.replace(/\/$/, '')
          : ''
        return sourceDir !== '' && sourceDir === record.canonical
      })
      if (!idCollision && !sourceCollision) continue
      unloadObject(record)
      record.generation += 1
      record.state = 'failed_collision'
      record.lastError = diagnose('installed registry change collided with this temporary registration')
    }
  }

  // ------------------------------------------------------------ dispatcher

  function dispatch(requestJson) {
    if (typeof requestJson !== 'string') {
      return respond(fail('request', { code: 'bad_json', message: 'request must be a JSON string' }))
    }
    if (byteLength(requestJson) > LIMITS.requestBytes) {
      return respond(fail('request', { code: 'request_too_large', message: 'request exceeds 32768 bytes' }))
    }
    let body
    try {
      body = JSON.parse(requestJson)
    } catch {
      return respond(fail('request', { code: 'bad_json', message: 'request is not valid JSON' }))
    }
    if (!isPlainObject(body)) {
      return respond(fail('request', { code: 'bad_json', message: 'request must be one JSON object' }))
    }
    const operation = body.operation
    if (body.version !== 1) {
      return respond(fail(typeof operation === 'string' ? operation : 'request',
        { code: 'unsupported_version', message: 'version must be exactly 1' }))
    }
    if (typeof operation !== 'string') {
      return respond(fail('request', { code: 'unknown_operation', message: 'operation is missing' }))
    }
    switch (operation) {
      case 'capabilities': return respond(dispatchCapabilities())
      case 'register': return respond(dispatchRegister(body, requestJson))
      case 'status': return respond(dispatchStatus(body))
      case 'summon': return respond(dispatchSummon(body))
      case 'call': return respond(dispatchCall(body))
      case 'hide': return respond(dispatchHide(body))
      case 'unregister': return respond(dispatchUnregister(body))
      case 'inspect': return respond(dispatchInspect(body))
      default: return respond(fail(operation, { code: 'unknown_operation', message: 'operation is not part of v1' }))
    }
  }

  function dispatchInspect(body) {
    const resolved = resolveRegistration(body.registrationId)
    if (resolved.error) return fail('inspect', { code: resolved.error, message: resolved.error })
    if (resolved.tombstone) return ok('inspect', { state: 'unregistered' })
    const record = resolved.record
    const result = { state: record.state, pluginId: record.pluginId }
    if (record.lastError) result.lastError = record.lastError
    return ok('inspect', result)
  }

  return {
    request(requestJson) {
      return dispatch(requestJson)
    },
  }
}