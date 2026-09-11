#!/usr/bin/env node
/** Explicit human preview only. Prototype setup reuse is confined to this manual harness. */
import { pathToFileURL } from 'node:url'
import { WORKBENCH_PREVIEW_RELEASE } from './workbench-preview-release.ts'
import { createPreviewController, PREVIEW_STATES } from './workbench-preview-controller.ts'
import {
  WORKBENCH_PLUGIN_ID,
  WORKBENCH_PLUGIN_VERSION,
  WORKBENCH_PRESENTATION_CONTRACT,
  WORKBENCH_PRESENTATION_DESTINATIONS,
  WORKBENCH_PROTOCOL_ID,
} from '../packages/local-workbench-v1/companion/contracts.ts'

/**
 * A loaded QML component is not the file on disk. Quickshell keeps the panel
 * instance alive (`keepLoaded`), so reinstalling assets never reloads the
 * running shell: the operator would validate stale code and report a false
 * finding. `pluginGeneration` is the instantiation time of the loaded panel in
 * milliseconds, so the loaded component must be at least as new as the receipt
 * that installed the assets. Pure and injected so it is testable without a desktop.
 */
export function assertLoadedComponentIsCurrent(pluginGeneration: number, installedAt: string): void {
  const incarnation = Math.floor(pluginGeneration / 1000)
  const installed = Date.parse(installedAt)
  if (!Number.isSafeInteger(pluginGeneration) || pluginGeneration <= 0) throw new Error('Loaded Companion reported no usable plugin generation.')
  if (!Number.isFinite(installed)) throw new Error('Installation receipt has no usable installation time; refusing to guess.')
  if (incarnation < installed) {
    throw new Error(
      'The running shell is older than the installed assets, so it still holds the previous panel in memory. '
      + 'Run `omarchy restart shell`, then run --preview again. No preview was opened and nothing was changed.',
    )
  }
}

export function assertLoadedPresentationContract(encoded: string): void {
  const stale = 'The loaded shell still holds an older panel that does not answer this presentation contract. '
    + 'Run `omarchy restart shell`, then run --preview again. No preview was opened and nothing was changed.'
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch {
    throw new Error(stale)
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error(stale)
  const value = parsed as Record<string, unknown>
  if (value.protocol !== WORKBENCH_PROTOCOL_ID
      || value.pluginId !== WORKBENCH_PLUGIN_ID
      || value.version !== WORKBENCH_PLUGIN_VERSION
      || value.presentation !== WORKBENCH_PRESENTATION_CONTRACT) throw new Error(stale)
  const destinations = value.destinations
  if (!Array.isArray(destinations)
      || WORKBENCH_PRESENTATION_DESTINATIONS.some((name) => !destinations.includes(name))) {
    throw new Error(`The loaded panel does not expose the full task-first destination set. ${stale}`)
  }
}

export async function main(args: string[]): Promise<void> {
  if (args.length !== 1 || !['--check', '--setup', '--preview', '--restore'].includes(args[0])) throw new Error('Usage: node --experimental-strip-types manual/local-workbench-preview.ts --check|--setup|--preview|--restore')
  if (args[0] === '--check') {
    assertLoadedPresentationContract(JSON.stringify({
      protocol: WORKBENCH_PROTOCOL_ID, pluginId: WORKBENCH_PLUGIN_ID, version: WORKBENCH_PLUGIN_VERSION,
      pluginGeneration: 1, presentation: WORKBENCH_PRESENTATION_CONTRACT,
      destinations: [...WORKBENCH_PRESENTATION_DESTINATIONS],
    }))
    const controller = createPreviewController(() => 'true', 'check-only', 1)
    controller.open(); controller.hide()
    console.log('CHECK: fixture protocol imports only; no desktop, installation or user state accessed.')
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Human setup/preview requires an interactive terminal; no live resources opened.')
  const live = await import('../prototypes/first-vertical-slice/manual/live-companion-omarchy.ts')
  const { freezeCompanionRelease } = await import('../prototypes/first-vertical-slice/companion/contracts.ts')
  const { CompanionInstallation } = await import('../prototypes/first-vertical-slice/companion/installation.ts')
  const release = freezeCompanionRelease(WORKBENCH_PREVIEW_RELEASE)
  if (args[0] === '--setup') {
    console.log(`This replaces the installed Agent Console with the ${release.version} task-first workbench. Stop old observer/Adoption gateways first. No Pi process is stopped. The previous receipt-backed release can be restored separately.`)
    const existingPorts = live.createLiveCompanionPorts({ release })
    const existing = existingPorts.receipts.inspectNoFollow(release.pluginId)
    if (existing && existingPorts.digest.stableDigest(JSON.parse(existing.bytes).release) === existingPorts.digest.stableDigest(release)) {
      await new CompanionInstallation(existingPorts).inspect({ operation: 'update', release })
      console.log('This exact candidate is already installed; no update performed and previous-release history preserved. Run --preview.')
      return
    }
    await live.runLiveSetup({ release })
    console.log('\nInstalled. The running shell still holds the previous panel in memory; restart it before previewing:\n  omarchy restart shell\nThen run --preview.')
    return
  }
  const ports = live.createLiveCompanionPorts({ release })
  // Inspect validates existing ownership/receipt/assets without executing a plan.
  await new CompanionInstallation(ports).inspect({ operation: 'update', release })
  const receiptFile = ports.receipts.inspectNoFollow(release.pluginId)
  if (!receiptFile) throw new Error('No owned Companion installation. Run --setup first.')
  const receipt = JSON.parse(receiptFile.bytes)
  if (ports.digest.stableDigest(receipt.release) !== ports.digest.stableDigest(release)) throw new Error(`Installed release differs from this ${release.version} candidate. Run explicit --setup; preview never updates installation.`)
  if (args[0] === '--restore') {
    if (!receipt.previousRelease) throw new Error('No receipt-backed previous release; nothing restored.')
    const previous = freezeCompanionRelease(receipt.previousRelease)
    console.log(`Restore receipt-backed Companion ${previous.version}; no external work or Pi files are removed.`)
    await live.runLiveSetup({ release: previous })
    return
  }
  const { createInterface } = await import('node:readline/promises')
  const { randomUUID } = await import('node:crypto')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  let controller: ReturnType<typeof createPreviewController> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let failure: Error | null = null
  let before: string | undefined
  let evidence: string | undefined
  let confirmed = false
  try {
    const answer = await prompt.question('Open the native fixture-only layout preview? Type PREVIEW: ')
    if (answer !== 'PREVIEW') throw new Error('Preview declined; no panel opened.')
    // The host loads a panel only when it is summoned, and an already-loaded
    // panel is never reloaded. Summon a rejected probe payload first so the
    // addressed component exists, then read its real generation.
    ports.shell.summon(release.pluginId, '{"probe":true}')
    const capabilities = ports.shell.capabilities(release.pluginId)
    assertLoadedComponentIsCurrent(capabilities.pluginGeneration, receipt.installedAt)
    // Identity and version are not the presentation contract: a long-lived
    // shell instance can answer an old capabilities envelope while still
    // holding the previous panel. Ask the loaded component what it presents.
    const command = new live.DirectLiveCommandPort(5000)
    const probe = command.run(['omarchy-shell', 'shell', 'call', release.pluginId, 'presentationContract', '{}'])
    const probeText = probe.stdout.trim()
    if (probe.status !== 0 || probeText === '' || probeText === 'unknown') {
      throw new Error('The loaded Companion does not answer the presentation contract. Run --setup and `omarchy restart shell`, then run --preview again.')
    }
    assertLoadedPresentationContract(probeText)
    before = live.captureLiveInstallationFingerprint(ports)
    evidence = live.createPrivateEvidenceDirectory('workbench-layout')
    const call = (method: string, value: unknown) => {
      const payload = JSON.stringify(value)
      if (Buffer.byteLength(payload) > 60000) throw new Error('Preview payload exceeds bounded argv size')
      const result = command.run(['omarchy-shell', 'shell', 'call', release.pluginId, method, payload])
      if (result.status !== 0) throw new Error(`Shell call ${method} failed; preview stopped`)
      return result.stdout.trim()
    }
    controller = createPreviewController(call, `preview-${randomUUID()}`, capabilities.pluginGeneration)
    controller.open()
    timer = setInterval(() => {
      try { controller!.tick() } catch (error) { failure = error as Error; if (timer) clearInterval(timer); prompt.close() }
    }, 1000)
    console.log(`\nFixtures: ${PREVIEW_STATES.join(', ')} (default: journey)\nCommands: stale, live, hide, open, done, quit.\nWalk the task-first journey: Project → New Team Goal → Add agent → Prepare assignment → Start review → Work and result.\nBoard and runtime actions are unavailable; selection is never execution authority.\nCheck theme, wrapping/scrolling, keyboard/focus, Escape handling, menu focus restoration, confirmation cancellation, draft restoration and stale disabling.\nEvidence: ${evidence}`)
    while (!failure) {
      const input = (await prompt.question('preview> ')).trim()
      if (input === 'quit') break
      if (input === 'done') {
        confirmed = await prompt.question('Did the complete native layout checklist pass? Type LAYOUT PASS (anything else records NOT PASSED): ') === 'LAYOUT PASS'
        break
      }
      if (input === 'stale') controller.stale()
      else if (input === 'live') controller.live()
      else if (input === 'hide') controller.hide()
      else if (input === 'open') controller.open()
      else if ((PREVIEW_STATES as readonly string[]).includes(input)) controller.select(input)
      else console.log('Unknown command; no action taken.')
    }
    if (failure) throw failure
  } finally {
    if (timer) clearInterval(timer)
    prompt.close()
    let cleanupError: unknown
    try { controller?.hide() } catch (error) { cleanupError = error }
    const unchanged = before !== undefined && before === live.captureLiveInstallationFingerprint(ports)
    if (evidence) {
      const pass = confirmed && !failure && !cleanupError && unchanged
      const result = { verdict: pass ? 'PASS — operator-attested native fixture layout only' : 'NOT PASSED', operatorConfirmed: confirmed, exactSessionCleared: !!controller && !cleanupError, installationUnchanged: unchanged, liveDispatch: false }
      writeFileSync(join(evidence, 'verdict.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
      console.log(`${result.verdict}\nEvidence: ${evidence}`)
    }
    if (cleanupError) throw cleanupError
    if (before !== undefined && !unchanged) throw new Error('Installation changed during preview; not PASS. No automatic repair attempted.')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
