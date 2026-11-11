/**
 * Novel workflow skill provider.
 *
 * Registers the Markdown skills shipped inside this bundle with the Host skill
 * registry. It deliberately imports Node built-ins only: the bundle is installed
 * into a profile whose node_modules does not contain the Harness packages, so a
 * DSH import here would fail at load time.
 *
 * Skill layout: <bundle>/skills/<dir>/SKILL.md, one directory per skill.
 * The skill body is re-read on every load, so editing a SKILL.md takes effect
 * without reinstalling the bundle.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'novel-skill-provider'
export const inject = ['skills']

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SKILLS_DIR = resolve(HERE, '..', 'skills')
const PROVIDER_NAME = 'novel'
const SOURCE = 'novel-preset'
const RANK = 100

export function apply(ctx, config = {}) {
  const root = config.skillsDir ? resolve(String(config.skillsDir)) : DEFAULT_SKILLS_DIR
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`novel-skills: ${message}`)
    } catch {
      /* logging must never break discovery */
    }
  }
  ctx.skills.registerProvider(() => createProvider(root, warn))
}

function createProvider(root, warn) {
  return {
    name: PROVIDER_NAME,
    async list() {
      let entries
      try {
        entries = await readdir(root, { withFileTypes: true })
      } catch (error) {
        warn(`cannot read skill directory ${root}: ${errorMessage(error)}`)
        return { candidates: [], complete: false }
      }
      const candidates = []
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue
        const directory = join(root, entry.name)
        const file = join(directory, 'SKILL.md')
        const parsed = await readSkill(file, warn)
        if (parsed === undefined) continue
        candidates.push(candidateOf(directory, file, parsed))
      }
      candidates.sort((left, right) => left.name.localeCompare(right.name))
      return { candidates, complete: true }
    },
    async get(candidate) {
      if (candidate?.provider !== PROVIDER_NAME) return undefined
      const file = candidate.locator?.path ?? join(candidate.locator?.directory ?? root, 'SKILL.md')
      const parsed = await readSkill(file, warn)
      if (parsed === undefined || parsed.name !== candidate.name) return undefined
      return {
        ...candidate,
        ...parsed,
        path: file,
        resourceBase: { kind: 'directory', path: candidate.locator?.directory ?? dirname(file) },
      }
    },
  }
}

function candidateOf(directory, file, parsed) {
  return {
    name: parsed.name,
    ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
    description: parsed.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: SOURCE,
    rank: RANK,
    locator: { path: file, directory },
    resourceBase: { kind: 'directory', path: directory },
  }
}

async function readSkill(file, warn) {
  try {
    const info = await stat(file)
    if (!info.isFile()) return undefined
    const raw = await readFile(file, 'utf8')
    const parsed = parseFrontmatter(raw)
    if (parsed === undefined) {
      warn(`${file} ignored: missing or invalid YAML frontmatter`)
      return undefined
    }
    const skillName = stringField(parsed.data, 'name')
    const description = stringField(parsed.data, 'description')
    if (skillName === undefined || description === undefined) {
      warn(`${file} ignored: frontmatter requires name and description`)
      return undefined
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
      warn(`${file} ignored: invalid skill name "${skillName}"`)
      return undefined
    }
    return {
      name: skillName,
      description,
      ...(stringField(parsed.data, 'whenToUse') === undefined
        ? {}
        : { whenToUse: stringField(parsed.data, 'whenToUse') }),
      content: parsed.body.trim(),
    }
  } catch (error) {
    warn(`cannot read ${file}: ${errorMessage(error)}`)
    return undefined
  }
}

/** Parse the small YAML subset used by the shipped SKILL.md files. */
export function parseFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return undefined
  const closing = text.indexOf('\n---', 4)
  if (closing < 0) return undefined
  const header = text.slice(4, closing + 1)
  const body = text.slice(closing + 4).replace(/^\n/, '')
  const data = {}
  const lines = header.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    const rest = match[2].trim()
    if (rest.startsWith('|') || rest.startsWith('>')) {
      const folded = rest.startsWith('>')
      const chomp = rest.includes('-') ? 'strip' : rest.includes('+') ? 'keep' : 'clip'
      const block = []
      let indent
      for (index += 1; index < lines.length; index += 1) {
        const next = lines[index]
        if (next.trim().length === 0) {
          block.push('')
          continue
        }
        const nextIndent = next.length - next.trimStart().length
        if (indent === undefined) {
          if (nextIndent === 0) {
            index -= 1
            break
          }
          indent = nextIndent
        }
        if (nextIndent < indent) {
          index -= 1
          break
        }
        block.push(next.slice(indent))
      }
      let value = folded ? block.join(' ') : block.join('\n')
      value = folded ? value.replace(/[ \t]+/g, ' ').trim() : value.replace(/[ \t]+$/gm, '')
      if (chomp === 'strip') value = value.replace(/\n+$/, '')
      if (chomp === 'clip') value = value.replace(/\n*$/, '\n')
      data[key] = value
      continue
    }
    data[key] = unquote(rest)
  }
  return { data, body }
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function stringField(data, key) {
  const value = data[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
