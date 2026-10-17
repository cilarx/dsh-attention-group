/**
 * A minimal JSON-Schema checker for the dialect DSH's `defineTool` uses.
 *
 * WHY THIS EXISTS. On 2026-10-16 the runtime's own validator turned two
 * perfectly well-behaved refusals into internal errors:
 *
 *   attention_probe_session({sessionId: ''})
 *     → ToolOutputError: "value.error" is not a declared property
 *   attention_conclude({groupId: 'ghost', text: 'x'})
 *     → ToolOutputError: missing required property "value.relayed"
 *
 * In both cases the plugin wrote a good sentence for the model and the model
 * never saw it. A failure branch is still a return value, and it has to satisfy
 * the contract the plugin declared for itself — otherwise the plugin's own
 * `output.schema` is what silences its own error messages.
 *
 * The real check happens in `createSuccessResult`:
 *
 *     const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
 *     if (violations.length > 0) throw new ToolOutputError(tool.name, violations)
 *
 * This file re-implements only the parts of that validator this plugin's schemas
 * use, so the assertion runs on a bare clone with no DSH installed. It is
 * deliberately narrower than the real thing: it can prove a schema violation,
 * not the absence of one. `tools/smoke-real-data.mjs` and the live run are what
 * cover the rest.
 *
 * The dialect: `required: true` sits INSIDE a property schema (DSH style), and
 * `additionalProperties: false` is honoured. Standard `required: [...]` arrays
 * are supported too, so a schema written either way is checked.
 *
 * @module dsh-attention-group/test/support/schema-check
 */

/**
 * Check one value against one schema.
 *
 * @param {object} schema - the declared schema.
 * @param {unknown} value - the value to check.
 * @param {string} [path] - dotted path used in messages.
 * @returns {string[]} violations; empty means it conforms.
 */
export function schemaViolations(schema, value, path = 'value') {
  if (schema === null || typeof schema !== 'object') return []
  const problems = []

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(' / ')}`)
    return problems
  }

  const type = schema.type
  if (typeof type === 'string') {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const expected = type === 'integer' ? 'number' : type
    const ok =
      actual === expected &&
      (type !== 'number' || Number.isFinite(value)) &&
      (type !== 'integer' || Number.isInteger(value))
    if (!ok) {
      problems.push(`${path} must be ${type}, got ${actual}`)
      return problems
    }
  }

  if (type === 'object' || schema.properties !== undefined) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const declared = schema.properties !== undefined && typeof schema.properties === 'object' ? schema.properties : {}
      const names = Object.keys(declared)
      const listed = Array.isArray(schema.required) ? schema.required : []

      for (const name of names) {
        const child = declared[name]
        // DSH dialect: `required: true` inside the property, not a name list.
        const wanted = child?.required === true || listed.includes(name)
        if (value[name] === undefined) {
          if (wanted) problems.push(`missing required property "${path}.${name}"`)
          continue
        }
        problems.push(...schemaViolations(child, value[name], `${path}.${name}`))
      }
      for (const name of listed) {
        if (value[name] === undefined && declared[name] === undefined) problems.push(`missing required property "${path}.${name}"`)
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(declared, key)) problems.push(`"${path}.${key}" is not a declared property`)
        }
      }
    }
    return problems
  }

  if (type === 'array' && schema.items !== undefined && Array.isArray(value)) {
    for (const [index, item] of value.entries()) problems.push(...schemaViolations(schema.items, item, `${path}[${index}]`))
  }

  return problems
}

/**
 * Assert one tool result against its own declared schema.
 *
 * @param {object} tool - a tool definition carrying `output.schema`.
 * @param {unknown} value - the value `execute` returned.
 * @returns {string[]} violations.
 */
export function toolOutputViolations(tool, value) {
  const schema = tool?.output?.schema
  if (schema === undefined) return []
  return schemaViolations(schema, value)
}
