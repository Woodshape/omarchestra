// Human-only fixture presentation transport. No registry, runner or execution authority.
//
// The default fixture is the one realistic task-first journey. Developer
// scenarios are opt-in one at a time by name; they are never rendered together
// as an all-states gallery.
import { validateSnapshot, type WorkbenchSnapshot } from '../packages/local-workbench-v1/console/schema.ts'
import { journeyFixture } from '../packages/local-workbench-v1/fixtures/journey.ts'
import { DEVELOPER_SCENARIOS, DEVELOPER_SCENARIO_NAMES } from '../packages/local-workbench-v1/fixtures/scenarios.ts'

export type PreviewCall = (method: string, payload: unknown) => string

export const DEFAULT_PREVIEW_FIXTURE = 'journey'
export const PREVIEW_STATES = [DEFAULT_PREVIEW_FIXTURE, 'projects', ...DEVELOPER_SCENARIO_NAMES] as const

const variants: Record<string, WorkbenchSnapshot> = {
  [DEFAULT_PREVIEW_FIXTURE]: journeyFixture,
  projects: {
    ...journeyFixture,
    projects: [...journeyFixture.projects, { ...journeyFixture.projects[0], projectId: 'project-example-2', canonicalPath: '/fixture/second-project', gitCommonDir: '/fixture/second-project/.git' }],
    goals: [...journeyFixture.goals, { ...journeyFixture.goals[0], projectId: 'project-example-2', goalId: 'goal-example-2', goalText: 'Second project goal', actions: [] }],
  },
  ...DEVELOPER_SCENARIOS,
}

export function createPreviewController(call: PreviewCall, sessionId: string, pluginGeneration: number) {
  const session = { sessionId, pluginGeneration }
  let name: string = DEFAULT_PREVIEW_FIXTURE
  let revision = 1
  let paused = false
  let visible = false
  let goalId: string | null = journeyFixture.selectedGoalId
  let projectId: string | null = journeyFixture.selectedProjectId
  let feedbackId = 0

  function projection(): WorkbenchSnapshot {
    const snapshot = variants[name]
    if (!snapshot) throw new Error(`Unknown fixture: ${name}`)
    const selectedProjectId = snapshot.projects.some(p => p.projectId === projectId) ? projectId : snapshot.selectedProjectId
    const goals = snapshot.goals.filter(g => g.projectId === selectedProjectId)
    const otherProject = selectedProjectId !== snapshot.selectedProjectId
    return validateSnapshot({
      ...snapshot,
      selectedProjectId, goals,
      ...(otherProject ? { managedAgents: [], observedSessions: [], retiredRuns: [], assignments: [], activity: [], checks: [], details: [], actions: snapshot.actions.filter(a => a.kind === 'create_goal') } : {}),
      sessionId,
      pluginGeneration,
      revision,
      selectedGoalId: goals.some(goal => goal.goalId === goalId) ? goalId : goals[0]?.goalId ?? null,
      fixture: { active: true, label: `${name} — HUMAN LAYOUT PREVIEW; no real work` },
    })
  }

  function checked(method: string, payload: unknown) {
    const result = call(method, payload).trim()
    if (result !== 'true') throw new Error(`Preview ${method} was rejected (${result.slice(0, 80)}); no retry or reinstallation performed`)
  }

  return {
    get state() { return name },
    open() { checked('openPreview', { session, projection: projection() }); visible = true },
    tick() {
      if (!visible || paused) return
      const current = projection()
      checked('updatePreview', { session, projection: current })
      const raw = call('takeIntent', session).trim()
      if (!raw) return
      if (raw.length > 262144) throw new Error('preview intent too large')
      const intent = JSON.parse(raw)
      if (intent.kind === 'select_goal' && current.goals.some(goal => goal.goalId === intent.target)) {
        goalId = intent.target
        revision++
      } else if (intent.kind === 'select_project' && current.projects.some(project => project.projectId === intent.target)) {
        projectId = intent.target
        goalId = null
        revision++
      } else {
        // Fixture transport has no management authority. Every other intent is
        // answered with an explicit rejection rather than a fabricated commit.
        checked('intentResult', {
          ...session,
          intentId: `preview-${++feedbackId}`,
          status: 'rejected',
          reasonCode: 'fixture_only_no_management',
          target: intent.target ?? null,
        })
      }
    },
    select(next: string) {
      if (!(PREVIEW_STATES as readonly string[]).includes(next)) {
        throw new Error(`Unknown fixture: ${next}`)
      }
      name = next
      revision++
      paused = false
    },
    stale() { paused = true },
    live() { paused = false; revision++ },
    hide() { if (visible) checked('clear', session); visible = false },
  }
}
