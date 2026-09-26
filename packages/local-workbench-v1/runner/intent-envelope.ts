import { types } from 'node:util'
import {
  MAX_DEPTH,
  MAX_KEYS,
  MAX_COLLECTION,
  MAX_ENVELOPE_BYTES,
  SchemaError,
  validateIntent,
  type WorkbenchIntent,
} from '../console/schema.ts'

type JsonPrimitive = null | boolean | string | number
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
interface JsonObject { [key: string]: JsonValue }

const MAX_STRING_BYTES = 8192
const MAX_PROPERTY_KEY_BYTES = 512
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/

/** Validate a private copy, then check that the command names one target. */
export function validateAuthorityIntent(input: unknown): WorkbenchIntent {
  const privateCopy = copyJsonData(input, 0, new JsonByteBudget())
  const intent = validateIntent(privateCopy)
  validateTargetAssociation(intent)
  return intent
}

/** Count encoded JSON incrementally, before constructing an oversized copy.
 * Only primitives are serialized here: serializing caller-owned objects could
 * invoke getters or toJSON before we have checked them.
 */
class JsonByteBudget {
  private bytes = 0

  addPrimitive(value: JsonPrimitive): void {
    // Includes string quotes/escapes and the literal spelling of null/booleans.
    this.addEncodedText(JSON.stringify(value))
  }

  addSyntax(syntax: '{}' | '[]' | ',' | ':'): void {
    this.addEncodedText(syntax)
  }

  private addEncodedText(text: string): void {
    this.bytes += Buffer.byteLength(text)
    if (this.bytes > MAX_ENVELOPE_BYTES) {
      throw new SchemaError('intent exceeds envelope byte bound')
    }
  }
}

/** Copy only bounded JSON data; never evaluate accessors or coercion hooks. */
function copyJsonData(value: unknown, depth: number, budget: JsonByteBudget): JsonValue {
  if (depth > MAX_DEPTH) {
    throw new SchemaError('intent exceeds depth bound')
  }
  if (value === null || typeof value === 'boolean') {
    budget.addPrimitive(value)
    return value
  }
  if (typeof value === 'string') {
    if (!value.isWellFormed() || Buffer.byteLength(value) > MAX_STRING_BYTES) {
      throw new SchemaError('intent string must be bounded well-formed Unicode')
    }
    budget.addPrimitive(value)
    return value
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    budget.addPrimitive(value)
    return value
  }
  if (!value || typeof value !== 'object' || types.isProxy(value)) {
    throw new SchemaError('intent must contain only JSON data')
  }
  return copyJsonContainer(value, depth, budget)
}

function copyJsonContainer(value: object, depth: number, budget: JsonByteBudget): JsonObject | JsonValue[] {
  const isArray = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  const expectedPrototype = isArray ? Array.prototype : Object.prototype
  const isNullPrototypeObject = !isArray && prototype === null
  if (prototype !== expectedPrototype && !isNullPrototypeObject) {
    throw new SchemaError('intent contains non-plain data')
  }

  // Reflect includes symbols, non-enumerable properties, and array length.
  // Those must be checked rather than silently dropped by Object.keys/JSON.
  const keys = Reflect.ownKeys(value)
  const maximumKeys = isArray ? MAX_COLLECTION + 1 : MAX_KEYS // +1 for length
  if (keys.length > maximumKeys) {
    throw new SchemaError('intent collection bound exceeded')
  }
  if (isArray && value.length > MAX_COLLECTION) {
    throw new SchemaError('intent array bound exceeded')
  }

  // A null prototype makes copying a literal "__proto__" key ordinary data.
  const result: JsonObject | JsonValue[] = isArray ? [] : Object.create(null)
  budget.addSyntax(isArray ? '[]' : '{}')
  let copiedProperties = 0

  for (const key of keys) {
    if (isArray && key === 'length') continue
    if (typeof key !== 'string' || Buffer.byteLength(key) > MAX_PROPERTY_KEY_BYTES) {
      throw new SchemaError('intent has invalid property key')
    }
    if (isArray && (!ARRAY_INDEX.test(key) || Number(key) >= value.length)) {
      throw new SchemaError('intent array has extra properties')
    }
    const propertyValue = readDataProperty(value, key)

    if (copiedProperties > 0) budget.addSyntax(',')
    copiedProperties++
    if (!isArray) {
      budget.addPrimitive(key)
      budget.addSyntax(':')
    }

    const copiedValue = copyJsonData(propertyValue, depth + 1, budget)
    if (Array.isArray(result)) {
      result[Number(key)] = copiedValue
    } else {
      result[key] = copiedValue
    }
  }
  if (isArray && copiedProperties !== value.length) {
    throw new SchemaError('intent array must not be sparse')
  }
  return result
}

function readDataProperty(object: object, key: string): unknown {
  // Reading the descriptor avoids invoking a getter via object[key]. Proxies
  // were refused before reflection, so this cannot run a caller's proxy trap.
  const descriptor = Object.getOwnPropertyDescriptor(object, key)!
  if (!descriptor.enumerable || !('value' in descriptor)) {
    throw new SchemaError('intent contains non-data properties')
  }
  return descriptor.value
}

const TARGET_PAYLOAD_FIELDS: Readonly<Record<string, string>> = {
  select_project: 'projectId',
  select_goal: 'goalId',
  confirm_register_project: 'registrationId',
  configure_checks: 'checkId',
  request_adoption: 'choiceId',
  authorize_adoption: 'proposalId',
  start_assignment: 'agentRunId',
  return_to_team: 'assignmentId',
  accept: 'assignmentId',
  resume: 'assignmentId',
  retry: 'assignmentId',
  reconcile_writer: 'assignmentId',
  stop: 'assignmentId',
  take_control: 'agentRunId',
  retire: 'agentRunId',
  purge: 'agentRunId',
}
const NULL_TARGET_KINDS = ['inspect_project', 'create_goal', 'create_check', 'navigate_page']
// Confirmation and recovery intents name the exact current record.
const EXACT_TARGET_KINDS = [
  'present', 'recover', 'prepare_start_review', 'start_assignment',
  'return_to_team', 'accept', 'resume', 'retry', 'reconcile_writer', 'stop',
]

function validateTargetAssociation(intent: WorkbenchIntent): void {
  const field = TARGET_PAYLOAD_FIELDS[intent.kind]
  if (field && intent.target !== intent.payload[field]) {
    throw new SchemaError('intent target does not match payload')
  }
  if (NULL_TARGET_KINDS.includes(intent.kind) && intent.target !== null) {
    throw new SchemaError('intent requires a null target')
  }
  if (EXACT_TARGET_KINDS.includes(intent.kind) && intent.target === null) {
    throw new SchemaError('intent requires an exact target')
  }
}
