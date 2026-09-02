// SPIKE — fake-only fixture. Not production code.
//
// fake-identity.mjs — injected identity source. The host must combine the
// per-shell nonce with monotonic counters internally and never expose either
// raw value as lifecycle authority.
//
// Frozen port surface for task 3.a:
//   nonce()       -> process-local opaque nonce string
//   nextCounter() -> strictly increasing positive integer
//
// A *different* nonce simulates a different shell instance (restart seam).

export function createIdentityPort({ nonce = 'fake-shell-nonce-alpha' } = {}) {
  let counter = 0
  return {
    nonceValue: nonce,
    nonce() { return nonce },
    nextCounter() { counter += 1; return counter },
  }
}