// SPIKE — fake-only fixture. Not production code.
//
// fake-config.mjs — the injected persistence-isolation port. The host must
// NEVER call any of these functions (contract: persistence isolation). Every
// call is recorded so the seam tests can assert zero calls and prove that
// installed state stays byte-identical.
//
// Frozen port surface for task 3.a:
//   shellConfigMutator(fn)  -> records call, then (would) mutate a clone
//   persistShellConfig(config) -> records call
//   fileViewSetText(path, text) -> records call
//   calls        -> array of { method, args }

export function createConfigPort() {
  const calls = []
  return {
    calls,
    shellConfigMutator(fn) {
      calls.push({ method: 'shellConfigMutator', args: [] })
      // A real mutator would receive a deep-cloned config and persist it.
      return fn({ version: 1, plugins: [], mutated: true })
    },
    persistShellConfig(config) {
      calls.push({ method: 'persistShellConfig', args: [config] })
    },
    fileViewSetText(path, text) {
      calls.push({ method: 'fileViewSetText', args: [path, text] })
    },
  }
}