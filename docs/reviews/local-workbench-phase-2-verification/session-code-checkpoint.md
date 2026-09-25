# Session usability slice 2 — shared visual identity

Status: implemented in development Companion 0.12.0; disposable acceptance only.
No installed files were changed and no Pi was reloaded or adopted. Host
continuation, not independent review or physical footer acceptance.

## Contract

- The owner allocates an independent random display code, e.g. `A1B2-C3D4`, for
  the exact Node/process/Pi-session/extension incarnation. It never truncates or
  exposes an identity capability, challenge, conversation identifier or secret.
- Codes are checked against all codes allocated during the owner lifetime.
  Successful codes are stable across reconnect and registry expiry, and are not
  recycled when an observation disappears. Sixteen allocation attempts and a
  4096-entry owner-lifetime codebook bound work and memory. Collision/capacity
  exhaustion yields `null` (unavailable), not a duplicate or management authority.
- Owner restart creates a new codebook. Codes are **not durable names** and must
  be read again after reconnection. A surviving Pi receives the current code in
  its new registration response. No schema migration or stored Pi history is
  required. Session replacement/extension replacement gets a distinct code within
  that owner lifetime, even if a saved conversation is resumed.
- Only the currently connected exact bridge's code is projected. Disconnected
  managed rows and disconnected retained observations have `sessionCode: null`;
  Pi clears this extension's named status on disconnect/shutdown. No historical
  code is presented as a currently matching terminal.
- Pi displays `Pi A1B2-C3D4 · Unassigned · observed`, or the same prefix plus the
  committed Role/state after Adoption. Pending acknowledgement remains visibly
  unassigned. No other extension status, terminal title, editor, widget, prompt
  or notification is changed.
- Overview, Add agent and Assignment target rows show the same literal code.
  Unavailable codes are explicitly labelled. A changed code disarms an existing
  same-button confirmation, including on a same-revision projection replacement.
  Intents still use full runner-issued target/choice IDs, never display codes.

## Compatibility and privacy

`omarchestra.bridge/v1` gains optional `presentation.session-code` negotiation.
The existing three required capabilities and every authority envelope remain
unchanged. New extensions append the optional capability; the owner then sends
`sessionCode` (strict uppercase four-hex/hyphen/four-hex, or null) in `registered`.
A client cannot nominate a code in `register` or add it to authority messages.

An old extension connecting to the new owner receives the unchanged registration
shape and projects code unavailable. A new extension against an old strict owner
may be refused as incompatible; it remains fail-open for ordinary Pi and must
not silently claim connection/code support. Updating/reloading live observers is
separately authorized and changes extension incarnation; do not use reload as
same-process managed recovery. A new client receiving a registration without a
code explicitly renders `Session code unavailable`.

Display metadata is not correlation proof, a credential, a Role, or a Runtime
Binding. Submitting a displayed code as an Adoption choice is rejected. This
slice does not implement window discovery, compositor actions or click-to-focus.
Those belong to slice 3 and its exact stale/ambiguous-correlation contract.

## Executable evidence

Run:

```sh
bash packages/local-workbench-v1/scripts/phase-2-gate.sh
```

Tests include:

- `session-code.test.ts`: forced collision/retry, stable lookup, bounded capacity,
  invalid code rejection, additive strict wire schema and projection validation.
- `phase-2-framed-adoption.test.ts`: two real extension adapters over paired fake
  streams, exact row/footer equality, code-only forged Adoption refusal, managed
  and takeover equality, disconnect/reconnect/expiry/session replacement, and
  unrelated status-slot preservation.
- `phase-2-native-owner.test.ts`: real disposable owner socket/store and surviving
  fake Pi reconnect across owner restart; the new projection and Pi footer agree.
- `phase-2-real-bridge.test.ts`: legacy peers get no invented code, and the real
  disposable Unix-socket bridge carries a code to the fake host's named status.
- `phase-2-composed.test.ts`: actual offscreen Add agent selection uses the code
  displayed by the real bridge/fake Pi; original choice IDs still authorize.
- `rendered-layout.test.ts`: two distinct observed labels, managed label, Add
  agent and Assignment target visibility, null-code fallback and same-revision
  code-change disarming with zero unintended intents.

The initial new module test failed before implementation (missing module).
Final full gate result is recorded in the slice plan. Automated evidence is
provider-free and disposable; it is not a physical observation of real terminal
footer rendering, narrow-column legibility or human matching.

Pi references read: installed 0.87.1 `docs/extensions.md`, `docs/tui.md`,
`docs/configuration.md`, `docs/settings.md`, `docs/packages.md`, `docs/themes.md`,
and `examples/extensions/status-line.ts`. Only `ctx.ui.setStatus` in the existing
named slot is used; no custom footer replaces other Pi UI.
