/**
 * Validates the bundled skills against the provider contract, without a Host.
 * Run: node novel-preset/test/check-skills.mjs
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, parseFrontmatter } from '../lib/skill-provider.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILLS = resolve(HERE, '..', 'skills')

let factory
const warnings = []
const ctx = {
  skills: {
    registerProvider(create) {
      factory = create
    },
  },
  logger: { warn: (message) => warnings.push(message) },
}

apply(ctx, {})
assert.equal(typeof factory, 'function', 'apply() must register a provider factory')

const provider = factory()
assert.equal(provider.name, 'novel')
assert.equal(typeof provider.list, 'function')
assert.equal(typeof provider.get, 'function')

const catalog = await provider.list()
assert.equal(catalog.complete, true, 'list() must report a complete catalog')
assert.ok(catalog.candidates.length >= 10, `expected >= 10 skills, got ${catalog.candidates.length}`)
assert.deepEqual(warnings, [], `provider warned: ${warnings.join(' | ')}`)

const directories = (await readdir(SKILLS, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => entry.name)
  .sort()
const names = catalog.candidates.map((candidate) => candidate.name).sort()
assert.deepEqual(names, directories, 'every skill directory must be listed exactly once')

const failures = []
for (const candidate of catalog.candidates) {
  const label = `skills/${candidate.name}/SKILL.md`
  try {
    assert.match(candidate.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'invalid kebab-case name')
    assert.equal(candidate.provider, 'novel')
    assert.ok(candidate.description.length >= 20, 'description is too short')
    assert.ok(candidate.whenToUse?.length >= 10, 'whenToUse is missing or too short')
    assert.equal(candidate.invocation.modelInvocable, true)
    assert.equal(candidate.resourceBase.kind, 'directory')
    assert.equal(candidate.resourceBase.path, candidate.locator.directory)

    const full = await provider.get(candidate)
    assert.ok(full, 'get() returned undefined for a listed candidate')
    assert.equal(full.name, candidate.name)
    assert.ok(full.content.length >= 1200, `body is too short (${full.content.length} chars)`)
    const prose = full.content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
    assert.ok(!prose.includes('{{'), 'skill body must not contain unfilled {{placeholders}}')
    assert.match(full.content, /^# /, 'skill body should start with an H1')

    const raw = await readFile(join(SKILLS, candidate.name, 'SKILL.md'), 'utf8')
    const parsed = parseFrontmatter(raw)
    assert.equal(parsed.data.name, candidate.name, 'frontmatter name must match directory')
    console.log(`ok ${label} (${raw.split('\n').length} lines, ${full.content.length} chars)`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}

console.log(`\nall ${catalog.candidates.length} skills valid; provider contract ok`)
