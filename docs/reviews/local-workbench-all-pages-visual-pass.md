# Shared visual treatment across the workbench

Status: implemented, automated presentation gate passing, and operator reported “ok working now” after updating the native preview; commit authorized. This accepts the visual iteration, not a complete runtime or formal layout-checklist PASS.

The operator accepted the overview as substantially cleaner, but requested visible resting affordances and the same treatment on every page. This extends the [first overview pass](local-workbench-overview-visual-pass.md); its statement that other pages remain unstyled is historical.

## Presentation changes

- Every destination uses `WorkbenchAction`: flat low-contrast resting fill and edge, shared Omarchy cursor overlay, accent selection/focus marker, consistent wrapping typography, muted disabled state and optional supporting text. Primary Create, Save and review actions use accent text.
- New Goal, Add agent, Adoption review, Assignment, Checks, Start review, Work/result, Board placeholder, Activity navigation and the shared header no longer instantiate default-painted Qt buttons.
- Multiline editors and single-line fields use shared theme-coloured backgrounds, restrained outlines and accent focus borders. Plain-text handling and Qt editing semantics remain intact.
- The check-mode selector exposes its existing two allowed values as adjacent selectable actions instead of a platform-painted ComboBox. It writes the same mode draft, not new authority.
- Secondary Goal and Work action reasons are supporting text rather than part of the action label. Work result surfaces are flat rather than nested bordered cards. No facts or confirmation consequences were removed.
- The exact-action dialog has an explicit theme background/header and shared button delegates. Cancel emits no intent; OK emits exactly one existing request through the unchanged confirmation handler.
- Active 0.7.0 packaging and lint include both shared editor components. Retained 0.6.0 and prototype assets are unchanged. No runtime, schema, scheduling, installation or authority change.

## Validation

`just --no-dotenv local-workbench-v1-check` covers the rendered journey, stale/disabled handling, drafts, text editing, exact adapter payloads, Escape/focus behaviour and fixed dock width. Added actual Qt checks cover resting enabled/disabled affordances and dialog Cancel/OK dispatch. Source checks reject default Button/TextField/TextArea/ComboBox instances in destination files and check literal text in shared controls.

Optional fixture screenshots were generated with:

```sh
WORKBENCH_VISUAL_EVIDENCE=/tmp/workbench-pages.png \
  node --experimental-strip-types --test packages/local-workbench-v1/test/rendered-layout.test.ts
```

Reviewed offscreen captures include overview, Assignment preparation, Checks, New Goal and unavailable Start review. Screenshot files are `/tmp/workbench-pages-<destination>.png`; logs are `/tmp/workbench-pages-render.log` and `/tmp/workbench-all-pages.log`. These are rendered fixtures with injected theme/decoration/host ports, not installed-shell screenshots. In particular, an unavailable/expired Start review capture does not establish real start feasibility. Existing exact-review interaction tests remain passing.

The coding agent performed no installation or shell restart. After receiving the manual setup/restart/preview instructions, the operator reported “ok working now” and requested a commit. No formal checklist verdict was inspected; do not infer exhaustive coverage of long text, editor selection, scrolling or confirmations from that report. Automated checks are not aesthetic acceptance. Panel-wide single-cursor coordination remains separate from this shared-control pass.
