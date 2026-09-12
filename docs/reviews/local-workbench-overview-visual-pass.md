# Overview visual pass — first iteration

Operator feedback: overview is much cleaner; resting action affordances need more contrast. The subsequent [all-pages visual pass](local-workbench-all-pages-visual-pass.md) extends this treatment. Scope and limitations below describe the first iteration.

Scope: user-authorized first-screen visual iteration after rejection of the task-first preview's blocky default Qt buttons. This is not approval of the finished UX and does not advance runtime implementation.

## Changes

- Overview Goal rows and Project tools use flat, wrapping actions; New Team Goal is a compact accent action beside its heading.
- Shared agent rows no longer have nested card borders. Agent maintenance is disclosed through an inline `···` action. Disabled reasons remain visible inside that disclosure, separately from action labels. Escape closes it and restores trigger focus.
- The shared Project picker also uses the flat treatment. Forms, review dialogs and other destinations are not comprehensively restyled. The shared agent component's presentation changes also appear wherever that component is reused.
- `WorkbenchAction.qml` retains Qt Button activation, disabled semantics, accessibility and wrapping, but replaces platform background paint with Omarchy `qs.Ui.CursorSurface`. Native `qs.Ui.Button` does not wrap its text, so it is not a drop-in replacement for bounded long projection labels.
- Existing targets, payload mapping, availability checks and confirmation routing remain unchanged. Active candidate packaging includes the new component; retained 0.6.0 is untouched.

## Sources and evidence

Read-only references under `/usr/share/omarchy/shell/`: `Ui/{Button,CursorSurface,PanelActionButton,Dropdown}.qml`, `Commons/Style.qml`, `plugins/dev-gallery/GalleryPanel.qml`, and the audio panel's cursor composition.

`just --no-dotenv local-workbench-v1-check` passes. The actual QML journey exercises disclosure, disabled actions, Escape/focus restoration and compact primary sizing in addition to existing payload, draft and geometry checks. The new component is included in static native-import lint.

An optional `WORKBENCH_VISUAL_EVIDENCE=/absolute/path.png` when running `test/rendered-layout.test.ts` directly saves a fixture-only offscreen overview image. The normal isolated gate does not forward that environment variable. Reviewed output: `/tmp/workbench-overview-review.png`; logs: `/tmp/workbench-overview-{render,check}.log`.

The offscreen test substitutes theme/decoration and layer-shell ports. Its screenshot establishes composition, not exact installed-theme paint or native dock usability. No installed plugin, shell configuration, live Pi or runtime state was modified. Native installation and operator visual acceptance remain separate. A panel-wide unified mouse/keyboard cursor is not established by this pass.
