/** Checked presentation, never process authority. No I/O at import or construction. */
export type NavigationResult = 'shown' | 'unavailable' | 'unknown'
export interface PaneProof {
  identity: string // local-only fingerprint of endpoints, process chain, pane and window
  paneId: string
  windowAddress: string
  paneFocused: boolean
}
export interface PaneNavigationPort {
  inspect(signal: AbortSignal): Promise<PaneProof>
  focusPane(paneId: string, signal: AbortSignal): Promise<void>
  focusWindow(address: string, signal: AbortSignal): Promise<void>
  activeWindow(signal: AbortSignal): Promise<string>
}

/** No automatic retry or rollback of a presentation change. Recheck the entire
 * proof before EACH mutation and after both. The unguarded interval remains an
 * explicitly accepted usability risk, not an atomic exact-agent guarantee.
 */
export async function showTerminalPane(port: PaneNavigationPort, isCurrent: () => boolean, timeoutMs = 4000): Promise<NavigationResult> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  let changed = false
  const live = () => { if (abort.signal.aborted || !isCurrent()) throw Error('navigation_obsolete') }
  try {
    live()
    const original = await port.inspect(abort.signal)
    const verify = async () => {
      live()
      const current = await port.inspect(abort.signal)
      live()
      if (current.identity !== original.identity || current.paneId !== original.paneId || current.windowAddress !== original.windowAddress) throw Error('navigation_changed')
      return current
    }
    await verify(); live()
    changed = true // failure/timeout after dispatch is uncertain, never “nothing happened”
    await port.focusPane(original.paneId, abort.signal)
    await verify(); live()
    await port.focusWindow(original.windowAddress, abort.signal)
    const after = await verify()
    const active = await port.activeWindow(abort.signal)
    live()
    if (!after.paneFocused || active !== original.windowAddress) throw Error('navigation_not_shown')
    return 'shown'
  } catch { return changed ? 'unknown' : 'unavailable' }
  finally { clearTimeout(timer); abort.abort() }
}
