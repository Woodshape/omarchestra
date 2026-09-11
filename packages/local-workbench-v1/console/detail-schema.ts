/** Explicit managed detail projections, not lifecycle authority or conversation collection. */
export interface AdoptionDetail {
  kind: 'adoption'; proposalId: string; observedSessionId: string; projectId: string;
  goalId: string; executionNodeId: string; role: string; predecessorAgentRunId: string | null;
  vacancyGeneration: number; stage: 'proposed' | 'authorized' | 'awaiting_ack' | 'committed' | 'ready' | 'failed' | 'expired';
}
export interface GateDefinitionView {
  gateId: string; version: number; digest: string; executable: string; executableDigest: string;
  argv: string[]; cwd: string; environment: { name: string; value: string }[];
  resources: { path: string; digest: string }[]; timeoutMs: number; outputBytes: number;
  semanticClaim: string;
}
export interface StartDetail {
  kind: 'start'; confirmationId: string; projectId: string; goalId: string; agentRunId: string;
  goalText: string; executionNodeId: string; gitCommonDir: string; headOid: string;
  baselineDigest: string; dirty: boolean; maxCorrections: number; elapsedMs: number;
  gate: GateDefinitionView;
}
export interface HandoffDetail {
  kind: 'handoff'; handoffId: string; assignmentId: string; attemptId: string; agentRunId: string;
  controlEpoch: number; claimedState: 'candidate' | 'partial' | 'blocked';
  outstandingEffects: 'none_reported' | 'may_be_active' | 'unknown'; summary: string; artifactRefs: string[];
}
export interface StopDetail {
  kind: 'stop'; stopId: string; assignmentId: string; dispatchRevoked: boolean;
  trigger: 'operator' | 'elapsed_limit' | 'attempt_limit' | 'protocol_uncertainty' | 'gate_failure_attention';
  cancellationStatus: 'not_requested' | 'requested' | 'acknowledged' | 'unsupported' | 'timeout' | 'unknown';
}
export interface DiagnosticNotice {
  kind: 'diagnostics'; assignmentId: string; attemptId: string;
  state: 'withheld' | 'requested' | 'unavailable'; reason: string;
}
export interface CheckDraft {
  executable: string; argv: string[]; cwd: string;
  environment: { name: string; value: string }[]; resourcePaths: string[];
  timeoutMs: number; outputBytes: number; maxCorrections: number; elapsedMs: number;
}
export interface CheckConfigurationDetail {
  kind: 'check_configuration'; projectId: string; checkId: string; checkVersion: number; definitionDraft: CheckDraft;
}
export type WorkbenchDetail = AdoptionDetail | StartDetail | HandoffDetail | StopDetail | DiagnosticNotice | CheckConfigurationDetail

const id = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) throw new Error('invalid detail identity')
  return v
}
const text = (v: unknown, max = 8192): string => {
  if (typeof v !== 'string' || Buffer.byteLength(v) > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) throw new Error('invalid detail text')
  return v
}
const number = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) throw new Error('invalid detail number')
  return Number(v)
}
const bool = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new Error('invalid detail boolean')
  return v
}
const choice = <T extends string>(v: unknown, values: T[]): T => {
  if (!values.includes(v as T)) throw new Error('invalid detail enum')
  return v as T
}
const object = (v: unknown, keys: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid detail object')
  const allowed = keys.split(' ')
  if (Object.keys(v).length !== allowed.length || Object.keys(v).some(k => !allowed.includes(k))) throw new Error('unknown or missing detail field')
  return v as Record<string, unknown>
}
const list = <T>(v: unknown, max: number, parse: (v: unknown) => T): T[] => {
  if (!Array.isArray(v) || v.length > max) throw new Error('invalid detail collection')
  return v.map(parse)
}
const digest = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) throw new Error('invalid detail digest')
  return v
}
const absolute = (v: unknown): string => {
  const value = text(v, 4096)
  if (!value.startsWith('/') || value.split('/').includes('..')) throw new Error('invalid absolute detail path')
  return value
}
const relative = (v: unknown): string => {
  const value = text(v, 4096)
  if (!value || value.startsWith('/') || value.split('/').some(s => s === '..' || s === '') || value.includes('://')) throw new Error('invalid artifact reference')
  return value
}
function gate(v: unknown): GateDefinitionView {
  const o = object(v, 'gateId version digest executable executableDigest argv cwd environment resources timeoutMs outputBytes semanticClaim')
  const argv = list(o.argv, 64, v => text(v, 4096))
  if (argv.reduce((n, arg) => n + Buffer.byteLength(arg), 0) > 32768) throw new Error('argument byte bound')
  const environment = list(o.environment, 32, v => {
    const e = object(v, 'name value'); const name = text(e.name, 128)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('invalid environment name')
    return { name, value: text(e.value, 4096) }
  })
  if (new Set(environment.map(e => e.name)).size !== environment.length) throw new Error('duplicate environment key')
  return {
    gateId: id(o.gateId), version: number(o.version, 1), digest: digest(o.digest),
    executable: absolute(o.executable), executableDigest: digest(o.executableDigest),
    argv, cwd: absolute(o.cwd), environment,
    resources: list(o.resources, 64, v => { const r = object(v, 'path digest'); return { path: absolute(r.path), digest: digest(r.digest) } }),
    timeoutMs: number(o.timeoutMs, 100, 300000), outputBytes: number(o.outputBytes, 1, 65536),
    semanticClaim: text(o.semanticClaim, 512),
  }
}
export function validateCheckDraft(v: unknown): CheckDraft {
  const o = object(v, 'executable argv cwd environment resourcePaths timeoutMs outputBytes maxCorrections elapsedMs')
  const argv = list(o.argv, 64, v => text(v, 4096))
  if (argv.reduce((n, s) => n + Buffer.byteLength(s), 0) > 32768) throw new Error('argument byte bound')
  const environment = list(o.environment, 32, v => {
    const e = object(v, 'name value'); const name = text(e.name, 128)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('invalid environment name')
    return { name, value: text(e.value, 4096) }
  })
  if (new Set(environment.map(e => e.name)).size !== environment.length) throw new Error('duplicate environment key')
  return { executable: absolute(o.executable), argv, cwd: absolute(o.cwd), environment,
    resourcePaths: list(o.resourcePaths, 64, absolute), timeoutMs: number(o.timeoutMs, 100, 300000),
    outputBytes: number(o.outputBytes, 1, 65536), maxCorrections: number(o.maxCorrections, 0, 3),
    elapsedMs: number(o.elapsedMs, 1000, 3600000) }
}
export function validateDetail(v: unknown): WorkbenchDetail {
  const kind = (v as any)?.kind
  if (kind === 'check_configuration') {
    const o = object(v, 'kind projectId checkId checkVersion definitionDraft')
    return { kind, projectId: id(o.projectId), checkId: id(o.checkId), checkVersion: number(o.checkVersion, 1), definitionDraft: validateCheckDraft(o.definitionDraft) }
  }
  if (kind === 'adoption') {
    const o = object(v, 'kind proposalId observedSessionId projectId goalId executionNodeId role predecessorAgentRunId vacancyGeneration stage')
    return { kind, proposalId: id(o.proposalId), observedSessionId: id(o.observedSessionId), projectId: id(o.projectId), goalId: id(o.goalId), executionNodeId: id(o.executionNodeId), role: text(o.role, 512), predecessorAgentRunId: o.predecessorAgentRunId === null ? null : id(o.predecessorAgentRunId), vacancyGeneration: number(o.vacancyGeneration), stage: choice(o.stage, ['proposed', 'authorized', 'awaiting_ack', 'committed', 'ready', 'failed', 'expired']) }
  }
  if (kind === 'start') {
    const o = object(v, 'kind confirmationId projectId goalId agentRunId goalText executionNodeId gitCommonDir headOid baselineDigest dirty maxCorrections elapsedMs gate')
    return { kind, confirmationId: id(o.confirmationId), projectId: id(o.projectId), goalId: id(o.goalId), agentRunId: id(o.agentRunId), goalText: text(o.goalText), executionNodeId: id(o.executionNodeId), gitCommonDir: absolute(o.gitCommonDir), headOid: id(o.headOid), baselineDigest: digest(o.baselineDigest), dirty: bool(o.dirty), maxCorrections: number(o.maxCorrections, 0, 3), elapsedMs: number(o.elapsedMs, 1000, 3600000), gate: gate(o.gate) }
  }
  if (kind === 'handoff') {
    const o = object(v, 'kind handoffId assignmentId attemptId agentRunId controlEpoch claimedState outstandingEffects summary artifactRefs')
    return { kind, handoffId: id(o.handoffId), assignmentId: id(o.assignmentId), attemptId: id(o.attemptId), agentRunId: id(o.agentRunId), controlEpoch: number(o.controlEpoch), claimedState: choice(o.claimedState, ['candidate', 'partial', 'blocked']), outstandingEffects: choice(o.outstandingEffects, ['none_reported', 'may_be_active', 'unknown']), summary: text(o.summary), artifactRefs: list(o.artifactRefs, 16, relative) }
  }
  if (kind === 'stop') {
    const o = object(v, 'kind stopId assignmentId dispatchRevoked trigger cancellationStatus')
    return { kind, stopId: id(o.stopId), assignmentId: id(o.assignmentId), dispatchRevoked: bool(o.dispatchRevoked), trigger: choice(o.trigger, ['operator', 'elapsed_limit', 'attempt_limit', 'protocol_uncertainty', 'gate_failure_attention']), cancellationStatus: choice(o.cancellationStatus, ['not_requested', 'requested', 'acknowledged', 'unsupported', 'timeout', 'unknown']) }
  }
  if (kind === 'diagnostics') {
    const o = object(v, 'kind assignmentId attemptId state reason')
    return { kind, assignmentId: id(o.assignmentId), attemptId: id(o.attemptId), state: choice(o.state, ['withheld', 'requested', 'unavailable']), reason: text(o.reason, 512) }
  }
  throw new Error('unsupported detail kind')
}
