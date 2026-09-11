# Task-first workbench — independent finding corrections

Status: **Engineering corrections delivered; native UX acceptance pending.**

Closes the actionable findings in
[the independent validation](local-workbench-ux-redesign-validation.md), retaining
that report as historical red evidence. These changes do not repair the original
Fusion DAG's failure or turn its in-session reviews into independent delegation.

## Corrections

- **F1 — Create:** availability follows the current projected action, valid
  selected Project and an 8192 UTF-8 byte/control-character bound. Target is the
  advertised null create target, with Project in the closed payload. Actual Qt
  button requests now pass through WorkbenchAdapter into an injected receiver.
  Create emits once without a redundant confirmation; fixture mode explicitly
  rejects durable work. The adapter also checks Project context.
- **F2 — Review invalidation:** any changed full snapshot conservatively clears
  captured start review, including same-revision digest/availability/detail
  changes. Target-keyed drafts remain. Resolved start detail must match Project,
  Goal, agent, check version/digest and captured task. Unmatched draft text cannot
  borrow a fixture's unrelated resolved start proposal.
- **F3 — Project navigation:** selections use the native polled intent path and
  the fixture controller handles validated Project selection. The opt-in
  `projects` scenario proves two Projects with isolated Goal drafts and scoped
  data. New Goal's Change Project opens the picker without leaving the form;
  its duplicate header Change button is hidden there. Picker focus returns to
  the invoking control. Goal selection opens the contextual Goal page only once
  the selected identity is reflected by the authoritative projection (or was
  already selected).
- **F4 — Review clarity:** task/agent/check/command/location and material limits
  and dirty-work consequences come first. Exact IDs, hashes, argv/environment and
  resource facts live behind Technical details, collapsed by default. Intervention
  dialogs use action-specific language, with inspectable exact target. Fixture
  rejection feedback is plain language rather than raw intent IDs.
- **Advanced configuration gap:** Checks now has a separate collapsed Advanced
  definition editor for executable, argument array, cwd, nonsecret environment,
  resource paths and timeout/output/correction/work-time limits. It retains
  invalid drafts, explains local errors and narrows Save availability. The closed
  `definitionDraft` payload is strictly validated outside QML; operator-supplied
  hashes or authority fields reject. Saving is not execution; future runner
  resolution/versioning/freezing remains required. No durable catalogue added.
- **Hidden results:** all schema-bounded Assignment rows remain reachable by
  scrolling; no first-eight truncation or false promise of details in Activity.

The active candidate remains additive 0.7.0 (not yet native-accepted), with loaded
presentation contract `task-first-v2`. This rejects a previously loaded v1
presentation; it is contract negotiation, not cryptographic content attestation.
Historical retained 0.6.0 and prototype/spike artifacts are unchanged.

## Evidence

`just --no-dotenv local-workbench-v1-check`: 115 Node tests pass, five explicitly
deferred runtime TODOs; 16 offscreen Qt rows pass; static QML lint passes with
installed-metadata warnings. The former three independent failing cases are now
in the actual component suite and pass. Additional coverage exercises advanced
editing/invalid input/Tab behavior, collapsed technical details, UTF-8 bounds,
actual Qt Create/Save payloads through the real adapter, and two-Project fixture
selection with draft restoration. Invalid advanced definitions reject unknown
fields, relative/traversing paths, wrong argv types, oversized collections,
duplicate environment names and invalid numeric limits.

The documented affected prototype regressions pass 163/163. Manual `--check`,
shell syntax and whitespace checks pass. Logs:
`/tmp/workbench-corrections.log`, `/tmp/workbench-corrections-regression.log`.
No installation, installed-shell access, shell restart, live Pi, real dispatch,
commit or push was performed by this correction slice.

## Operator checkpoint

Quit any existing preview before changing its installation. Separately approve:

```sh
node --experimental-strip-types manual/local-workbench-preview.ts --setup
omarchy restart shell
node --experimental-strip-types manual/local-workbench-preview.ts --preview
```

Use the normal journey first. For its staged exact start review, the provided
proposal is for task **Ship the parser fix**. Other draft text remains editable
but displays no matching resolved proposal, rather than pretending the fixture
confirmed it. Type `projects` in the preview terminal to exercise Project-change
and draft retention; `gate_pass`/`gate_fail` provide staged results. No fixture
button creates durable work or executes a gate. Native usability, compositor
behavior and real theme remain the operator's checkpoint, not an automated claim.
