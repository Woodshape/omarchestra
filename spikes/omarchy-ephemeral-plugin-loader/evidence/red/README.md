# Intended red evidence — public-interface tests before implementation

Captured: 2026-09-02, task 2.b (flash).

## Exact command

```bash
cd /home/woodshape/claude/omarchestra/spikes/omarchy-ephemeral-plugin-loader
node --test test/ > evidence/red/all-seams-red.txt 2>&1   # intended: exit 1
```

## Result

- `tests 61 · pass 4 · fail 57` (exit 1 — the intended red state)
- 0 file-level load errors; every test fails individually.

## Intended-failure classification

| Class | Count | Cause |
| --- | --- | --- |
| `ERR_MODULE_NOT_FOUND: .../lib/index.mjs` | 52 | The fake model does not exist yet (task 3.a). Every seam test fails through the frozen public surface `createTemporaryPanelHost` / `createScratchRegistry`. |
| Missing `upstream/omarchy-4.0.2-1-temporary-panel-v1.patch` or `scripts/verify-candidate-patch.sh` | 3 | Patch lane artifacts do not exist yet (task 3.b). |
| Missing justfile recipe `spike-omarchy-ephemeral-plugin-loader` | 2 | Integration recipe is owned by task 4.b. |

The 4 passing tests are the trivially-true negative audits of seam 8 (absence of
forbidden tokens in files that do not exist yet); each seam's substantive
existence/behavior tests fail, so the seam is red.

## Green conditions (task 3.a / 3.b / 4.b)

1. `lib/index.mjs` exports `createTemporaryPanelHost({fs, loader, config, scan, identity, clock})`
   and `createScratchRegistry({fs, now})`; all module-level reds flip.
2. `scripts/verify-candidate-patch.sh` + `upstream/*.patch` flip seam 6.
3. The `just spike-omarchy-ephemeral-plugin-loader` recipe flips seam 8.
4. Final green evidence is captured under `evidence/green/` by the implementing tasks.

## Second-review regression red

A later read-only review found six behavioral/evidence gaps after the first green pass.
Before correcting them, the four affected seam files were run together and captured at
[`review-findings-red.txt`](review-findings-red.txt): 35 tests, 26 pass, 9 fail, exit 1.
Those failures cover repeated-summon queue capacity, tombstone summon behavior, stale
hide callbacks, retained failure claims, manifest-snapshot candidate guards, and exact
scratch cleanup. The final 69/69 run is recorded outside this frozen red directory.