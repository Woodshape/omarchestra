# Proposed observer/Adoption live validation

Status: **BLOCKED by R1 — proposal only; not run**

**PROTOTYPE — NOT PRODUCTION.** This is a human-only validation procedure
proposal for the bounded observer/Adoption contract. It is intentionally not an
automated recipe and does not authorize installation or live execution.

## Blocking precondition

Do not run this procedure until the Pi public extension surface provides a
content-free start/end lifecycle for slash-command and `user_bash` execution,
or the reconciliation rule is explicitly revised in the authoritative design
and its decision log. Pi 0.84.4 does not currently provide that proof:
extension commands bypass the input event, `user_bash` is content-bearing and has
no matching completion event, and `ctx.isIdle()` is not a complete classifier
for arbitrary command activity. This is R1 from
[`observer-adoption-v1.md`](observer-adoption-v1.md).

A passing fake gate cannot satisfy this precondition. No live observer
installation, ordinary Pi launch, Companion mutation, provider request, or
Adoption attempt is valid evidence while R1 remains open.

## Required human setup

After R1 is closed, an owner-authorized operator may prepare a disposable local
validation run with:

- the pinned compatible Pi, Omarchy, and Companion versions recorded in the
  resulting private evidence;
- the explicit observer installation plan and authorization, separate from any
  Team Goal or Projection Session;
- a local owner-only Agent Registry and Team Runner with fresh run state;
- one local Team Goal with a vacant Role on the same Execution Node;
- one ordinary visible Pi started through the normal terminal workflow, not by
  the Team Runner; and
- private owner-only evidence storage outside Git.

The operator must record the exact observer, Pi session, extension, connection,
and registry identities in private evidence without recording prompts,
responses, input text or length, tool data, terminal output, repository content,
credentials, environment values, cwd, title, focus, or recency.

## Validation sequence

1. Verify the Companion is already installed and enabled. Record its immutable
   installation fingerprint before the run. Do not install, update, unload, or
   rewrite it as part of the observer test.
2. Start the ordinary visible Pi. Confirm it remains interactive while the
   registry is absent or unavailable, and that no hidden agent, process action,
   prompt delivery, input injection, PTY operation, or terminal supervision is
   introduced.
3. Enable the observer connection through the separately authorized setup.
   Confirm exactly one current registry record with `Unassigned · observed`,
   fresh connection values, and no Team Goal, Role, Assignment, control mode,
   writer lease, Runtime Binding, or PTY authority.
4. Exercise disconnect, reconnect, expiry, stale identity, reused-PID,
   node-mismatch, remote-goal, occupied-role, busy, unknown, exited,
   already-managed, duplicate, timeout, refusal, and identity-drift cases.
   Confirm each leaves the ordinary Pi observed/unassigned when still current,
   and that no Team Runner dispatch occurs.
5. Exercise the R1-sensitive command/activity cases only after the blocking
   precondition is satisfied. Use lifecycle facts rather than content capture;
   prove that an active slash command or `user_bash` action is `busy` and that
   an unclassifiable condition is `unknown`. Do not add an input hook or shell
   wrapper to obtain this evidence.
6. From Unassigned Agents, select the exact current observed session, choose the
   same-Node local Team Goal and vacant Role, and display the immutable proposal.
   Record that explicit human confirmation is required and that QML supplied
   only the opaque choice identity.
7. Confirm the same-process acknowledgement arrives on the exact current
   connection. Reconcile again immediately before commit, then verify one
   atomic transition to the selected Agent Run and exactly one committed
   `<Role> · <state>` presentation. Confirm no assignment, prompt, or managed
   work was sent before the durable commit.
8. Reconnect the Companion and observer projections from authoritative state.
   Confirm the same process/session/extension identity is represented as the one
   committed Agent Run, no duplicate Adoption exists, and the old observed
   record is not recreated.
9. Close the ordinary terminal and complete the documented managed/observer
   recovery checks. Distinguish unavailable observation from managed Runtime
   Binding state; do not infer PTY persistence from correlation or title data.
10. Clear the Projection Session and clean only the exact disposable runtime
    resources. Compare the Companion installation fingerprint and configuration
    bytes with the pre-run record; they must be unchanged.

## Evidence and disposition

The operator should retain private evidence for protocol decisions, identity
matching, ordered Adoption phases, pre-commit authority counters, post-commit
state, duplicate prevention, and exact cleanup. It must contain no forbidden
telemetry classes and must not enter Git.

A successful run would establish only the bounded live behavior covered by the
resolved contract. It would not establish production packaging, remote
execution, reboot recovery, PTY guarantees for an adopted ordinary session,
or broader Pi compatibility. If any public API fails to provide the R1 proof,
stop and record the blocker rather than scraping the terminal, inspecting
conversation state, wrapping shell execution, or weakening the contract.
