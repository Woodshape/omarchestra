## 1. Proposed end state

`spikes/boomux-runtime-adapter/` contains a dependency-free Node spike implementing:

```text
capabilities()
create(sessionSpec) -> opaque reference
present(reference)
inspect(reference) -> lifecycle state
close(reference)
subscribe(references, cursor) -> ordered lifecycle events
```

The adapter:

- supports only observed Boomux `1.8.0`, protocol `49`, and `boomux.cli/v1`;
- invokes Boomux with argv arrays and no shell interpolation;
- exposes opaque Omarchestra references while privately recording exact Workspace, owner Workspace, Shell, and Shell Run IDs;
- uses supported JSON commands for capabilities, snapshots, inspection, and events;
- labels Workspace/Shell creation, presentation, and closure as weaker non-JSON dependencies;
- requires a running daemon rather than silently starting or stopping it;
- records a private append-only ownership receipt before allowing cleanup;
- never reads Boomux state files, imports Rust modules, installs integrations, or performs global cleanup;
- uses an injected fake executor in automated tests, so tests cannot open terminals.

Expected files:

```text
spikes/boomux-runtime-adapter/
├── README.md
├── .gitignore
├── manual.mjs
├── probe-process.mjs
├── lib/
│   ├── adapter.mjs
│   ├── commands.mjs
│   ├── envelopes.mjs
│   ├── errors.mjs
│   ├── executor.mjs
│   └── receipt.mjs
├── test/
│   ├── adapter.test.mjs
│   ├── commands.test.mjs
│   ├── envelopes.test.mjs
│   ├── events.test.mjs
│   ├── safety.test.mjs
│   └── fixtures/
└── evidence/
    ├── cli-source-truth.txt
    ├── automated.txt
    └── manual-observations.md
```

The provisional conclusion should be **supported with constraints, pending the human gate**. Two constraints must remain explicit:

1. Mutating and presentation commands do not provide `boomux.cli/v1` output.
2. Public `boomux open` does not expose an expected-Run guard. The adapter can inspect before and after presentation and report `RunChanged`, but cannot prevent a race where an exited Run is restarted.

## 2. Implementation tasks

### A1. Capture the public contract

Before mutation, record:

- `boomux --version`
- `boomux --json capabilities`
- `boomux --help`
- relevant Workspace, Shell, open, events, daemon-status, node-snapshot, and integration-status help
- JSON snapshots of existing user resources and integrations

Define required schema, protocol, commands, features, and stable error codes from the observed output.

**Blocks:** A2, A3, A5.

### A2. Implement pure contract and command construction

Implement:

- strict `boomux.cli/v1` envelope parsing;
- typed failures for missing executable, unsupported version/schema/protocol/capability, daemon unavailable, malformed output, stable Boomux errors, cursor expiry, Run changes, and weak mutation failures;
- exact argv builders;
- injected executor using direct spawn with `shell: false`.

**Depends on:** A1.

### A3. Implement references, lifecycle, and ownership

Implement:

- opaque runtime tokens;
- private mapping to global Workspace ID, owner Workspace ID, Shell ID, and Run ID;
- pending/running/exited/closed normalization;
- unique names such as `omarchestra-boomux-spike-<token>-coordinator`;
- idempotency within one recorded receipt;
- fail-closed behavior after ambiguous non-JSON mutation outcomes;
- cleanup limited to exact recorded IDs.

**Depends on:** A1.  
**Can run parallel with:** A2 after the interface is fixed.

### A4. Implement event subscription

Use:

```text
boomux events --json
boomux events --after CURSOR --wait-ms N --json
```

Return a baseline on a null cursor, filter lifecycle events to referenced Shells, preserve Boomux event order, and advance the cursor across ignored events. Return typed `CursorExpired` rather than silently fabricating continuity.

**Depends on:** A2 and reference mapping from A3.

### A5. Build the manual driver and probe process

Provide explicit commands to:

1. preflight and privately snapshot user data;
2. create the uniquely named Workspace and three role Shells;
3. present all three;
4. record each probe PID and `BOOMUX_RUN_ID`;
5. inspect and re-present one detached Shell;
6. observe events;
7. clean up exact receipt-owned IDs.

GUI-opening actions require an explicit manual flag. No automated test invokes them.

**Depends on:** A2 and A3.

### A6. Deterministic tests and source audit

Cover:

- valid and invalid capability negotiation;
- unavailable executable and daemon;
- all envelope and typed-error paths;
- hostile argv values remaining single arguments;
- pending/running/exited and Run-change handling;
- cursor baseline, ordering, filtering, pagination, and expiry;
- duplicate create/close behavior;
- partial-failure cleanup;
- refusal to close unrecorded resources;
- source scan rejecting private Boomux paths, Rust coupling, hidden commands such as `__attach`, shell execution, and state-file access.

**Can begin parallel with:** A2 and A3 using agreed fixtures.

### A7. Documentation and evidence

`README.md` records the question, assumptions, exact versions, command table, envelope shapes, failures, limitations, design implications, and disposition of every file.

`manual-observations.md` remains explicitly pending. Do not update `docs/design/mvp.md` or claim GUI feasibility until a human completes the gate.

**Depends on:** A1–A6.

## 3. Best ownership for SOL

SOL should own the contract and safety review:

- finalize required capabilities and normalized lifecycle semantics;
- audit the public versus non-JSON dependency boundary;
- verify exact-Run and cleanup claims are not overstated;
- review the source-coupling guard;
- synthesize the README conclusion after automated evidence.

TERRA should own the main adapter and manual driver. LUNA can own fixtures, deterministic tests, and the source audit. This avoids shared implementation files.

## 4. Collision and safety concerns

- **R1: Existing user data.** No mutation occurs before a public-CLI baseline snapshot. Every mutation uses a unique prefix and every destructive command uses an exact receipt-owned ID.
- **R2: Ambiguous non-JSON mutations.** Never parse human stdout for identity. Reconcile through JSON snapshots. If the mutation outcome cannot be proven and recorded, stop and leave the possible orphan for explicit inspection.
- **R3: Workspace cleanup.** Refuse Workspace closure if its placement contains any unrecorded Shell, Launcher, or Agent. Close recorded Shell IDs first, then the exact global Workspace ID.
- **R4: Exact Run presentation.** Pre-inspect and post-inspect the Run. Report `RunChanged` if it differs. Document that public `open` cannot atomically guard the expected Run.
- **R5: GUI tests.** Fake executors are mandatory in automated tests. Real `open` commands require an explicit manual mode.
- **R6: Configuration.** Do not enable the Hyprland Workspace layer or alter integrations. If the existing environment cannot tile the terminals as required, record the manual gate as unsupported in that environment.
- **R7: Shared files.** Only one owner edits `README.md`, `manual.mjs`, and `lib/adapter.mjs`. Test work stays under `test/`.

## 5. Objective validation

Automated completion requires:

```text
node --check for every .mjs file
node --test spikes/boomux-runtime-adapter/test/*.test.mjs
source-coupling audit passes
all executor assertions prove shell:false
no real Boomux mutation or GUI command occurs in tests
git diff --check
```

The human gate then verifies:

1. three role-labelled native terminals appear tiled;
2. each terminal shows its expected Shell ID, Run ID, role, and PID;
3. closing one window leaves that PID and Run alive;
4. re-presenting reconnects to the same Run ID and PID;
5. the other two Runs remain unchanged;
6. event cursors report the relevant lifecycle transitions in order;
7. cleanup targets only receipt-owned IDs;
8. the post-cleanup snapshot retains all pre-existing resource IDs.

Until those observations are recorded, the spike must end at **automated contract proven, GUI/detach/reconnect conclusion pending**.