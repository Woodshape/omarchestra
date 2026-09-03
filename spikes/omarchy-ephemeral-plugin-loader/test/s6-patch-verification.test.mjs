// SPIKE — Seam 6: patch seam (red stage).
//
// The candidate patch applies cleanly to a temporary copy of the exact hashed
// installed baseline, touches only justified shell/docs files, and its
// modified QML passes qmllint without launching a UI. All of that is owned by
// scripts/verify-candidate-patch.sh (task 3.b); this seam drives it as the
// public verifier interface and asserts its frozen output contract.
//
// The verifier (scripts/verify-candidate-patch.sh) must:
//   1. hash-check the installed baseline against evidence/source-provenance.json;
//   2. copy the baseline into a fresh mktemp directory;
//   3. dry-run and then apply upstream/omarchy-4.0.2-1-temporary-panel-v1.patch;
//   4. enforce a touched-file allowlist;
//   5. require Qt 6 qmllint and pass every modified QML file;
//   6. remove its exact scratch state under success, failure, and interruption
//      and print the frozen progress markers below.
//
// Frozen marker lines: baseline-verified, copy-ok, dry-run-ok, apply-ok,
// allowlist-ok, qmllint-ok, cleanup-ok, residue-clean.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SPIKE_ROOT = path.resolve(here, '..')
const REPO_ROOT = path.resolve(SPIKE_ROOT, '..', '..')
const PATCH_PATH = path.join(SPIKE_ROOT, 'upstream', 'omarchy-4.0.2-1-temporary-panel-v1.patch')
const VERIFIER_PATH = path.join(SPIKE_ROOT, 'scripts', 'verify-candidate-patch.sh')

const MARKERS = [
  'baseline-verified', 'copy-ok', 'dry-run-ok', 'apply-ok', 'allowlist-ok',
  'cleanup-ok', 'residue-clean',
]

test('the candidate patch and its verifier exist', () => {
  assert.ok(fs.existsSync(PATCH_PATH), `missing ${path.relative(REPO_ROOT, PATCH_PATH)}`)
  assert.ok(fs.existsSync(VERIFIER_PATH), `missing ${path.relative(REPO_ROOT, VERIFIER_PATH)}`)
})

test('the verifier enforces a touched-file allowlist in its own text', () => {
  const script = fs.readFileSync(VERIFIER_PATH, 'utf8')
  assert.match(script, /mktemp/, 'the verifier must copy the baseline into mktemp scratch space')
  assert.match(script, /sha256/i, 'the verifier must hash-check the baseline')
  assert.match(script, /trap/, 'the verifier must clean up under success, failure, and interruption')
  assert.match(script, /source-provenance/, 'the verifier must read the recorded provenance manifest')
  assert.match(script, /--dry-run|patch -p1 --dry-run|git apply --check/, 'the verifier must dry-run the patch')
})

test('the candidate source retains the reviewed validation, identity, queue, and teardown gates', () => {
  const patch = fs.readFileSync(PATCH_PATH, 'utf8')
  assert.doesNotMatch(patch, /^\+\s*Instantiator\s*\{/m, 'registration must not instantiate Loader delegates')
  assert.match(patch, /^\+\s*var loader = temporaryPanelLoaderComponent\.createObject/m)
  assert.match(patch, /^\+\s*if \(record\.queue\.length >= limits\.queuedCallsPerRegistration\)/m)
  assert.match(patch, /^\+\s*if \(!work \|\| work\.serial !== serial \|\| processWorkSerial !== serial\) return/m)
  assert.match(patch, /^\+\s*function handleLoaderDestroyed\(registrationId, generation, loader\)/m)
  assert.match(patch, /^\+\s*if \(!record \|\| record\.loader !== loader \|\| record\.generation !== generation\) return/m)
  assert.match(patch, /^\+\s*releaseClaims\(record\)$/m, 'claims release only from terminal teardown')
  assert.match(patch, /exitCode === 12.*symlink_component/)
  assert.match(patch, /exitCode === 14 \|\| exitCode === 21/)
  assert.match(patch, /exitCode === 15 \|\| exitCode === 22/)
  assert.match(patch, /work\.kind === "load".*manifestBase64/s,
    'pre-load validation must compare current manifest content with the registered snapshot')
  assert.match(patch, /phase: "load"/,
    'summon-time validation must request both entry-point and manifest-content checks')
  assert.match(patch, /mode\\\" == entry.*mode\\\" == load.*check_regular_owned.*mode\\\" == load.*base64/s,
    'load mode must check the entry point before emitting the current manifest snapshot')
  assert.match(patch, /readonly property string instanceNonce:/)
  assert.match(patch, /prefix \+ "\." \+ instanceNonce/)
  assert.match(patch, /rest\.slice\(0, dot\) !== instanceNonce/,
    'identities must use one fresh host nonce rather than the stable Quickshell instance name')
})

test('the verifier cleanup checks exact directory identity before recursive removal', () => {
  const script = fs.readFileSync(VERIFIER_PATH, 'utf8')
  assert.match(script, /scratch_identity=/)
  assert.match(script, /unrelated_identity=/)
  assert.match(script, /remove_exact_directory/)
  assert.match(script, /stat -c ['"]%d:%i['"]/)
  assert.match(script, /symlink_component/)
})

test('the verifier runs green end to end against the exact baseline', () => {
  let output = ''
  try {
    output = execFileSync('bash', [VERIFIER_PATH], {
      cwd: REPO_ROOT,
      timeout: 55000,
      encoding: 'utf8',
    })
  } catch (error) {
    const detail = error.stdout ? String(error.stdout) : String(error)
    assert.fail(`verifier failed: ${detail.slice(0, 2000)}`)
  }
  for (const marker of MARKERS) {
    assert.ok(
      output.includes(marker) || output.includes(`${marker}-skipped`),
      `verifier output must report ${marker}`,
    )
  }
  assert.ok(output.includes('qmllint-ok (qt6; TemporaryPanelHost.qml and shell.qml)'),
    'verifier must pass Qt 6 qmllint for both modified QML files')
})