#!/usr/bin/env node
/**
 * 导入归一：把已有章节整理成项目能认的形状。
 *
 * 只做三件事，且默认只打印计划（要加 --apply 才动手）：
 *   1. 原文件复制到 chapters/_original/ 留底（不动源文件）
 *   2. 规范化副本写到 chapters/vol-01/ch-001.md
 *   3. 给每章建 .versions 存档 v1
 *
 * 正文一字不改：只在完全没有标题行时补一行「# 第 N 章 未命名」。
 *
 * 用法：
 *   node import-normalize.mjs <源目录> [--project novel-project] [--apply] [--json]
 *
 * 退出码：0 完成 / 1 有告警 / 2 路径或参数错误
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { archiveChapter, countWords, ensureVersionsIgnore, loadManifest, shortSha } from '../../../lib/versions.js'

const SKIP_DIRS = new Set(['node_modules', '.git', '.versions', '_original', 'reviews', 'bible', 'outline'])

function parseArgs(argv) {
  const opts = { dir: '', project: 'novel-project', apply: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') opts.apply = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--project') opts.project = argv[++i] || 'novel-project'
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (!arg.startsWith('--')) opts.dir = arg
  }
  return opts
}

function walk(dir, out = [], skipRoots = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (skipRoots.some((root) => full === root || full.startsWith(root + '/'))) continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out, skipRoots)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

function chapterNumber(file, heading) {
  const name = basename(file, '.md')
  const fromName = name.match(/(?:ch|chapter)[-_ ]?(\d{1,4})/i) || name.match(/第\s*(\d{1,4})\s*章/) || name.match(/^(\d{1,4})(?:[._-]|$)/)
  if (fromName) return Number(fromName[1])
  const fromHeading = heading.match(/第\s*(\d{1,4})\s*章/)
  return fromHeading ? Number(fromHeading[1]) : null
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || !opts.dir) {
    console.log('用法：node import-normalize.mjs <源目录> [--project novel-project] [--apply] [--json]')
    process.exit(opts.help ? 0 : 2)
  }
  const source = resolve(opts.dir)
  const projectDir = resolve(opts.project)
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    console.error(`读不到目录：${source}`)
    process.exit(2)
  }

  const plan = []
  const warnings = []
  const skipRoots = source === projectDir
    ? []
    : [join(projectDir, 'chapters'), join(projectDir, 'bible'), join(projectDir, 'reviews')]
  for (const file of walk(source, [], skipRoots)) {
    const raw = readFileSync(file, 'utf8')
    const headingLine = raw.split(/\r?\n/).find((line) => /^#{1,2}\s+\S/.test(line)) || ''
    const heading = headingLine.replace(/^#{1,2}\s+/, '').trim()
    const words = countWords(raw)
    const number = chapterNumber(file, heading)
    const looksLikeChapter = number !== null || (words >= 600 && /chapters?[\\/]/i.test(relative(source, file)))
    if (!looksLikeChapter) continue
    if (number === null) {
      warnings.push(`${relative(source, file)}：认不出章号，先跳过（可在文件名里写 ch-007 或标题写「第 7 章」）`)
      continue
    }
    plan.push({ file, number, heading, words, raw })
  }

  plan.sort((a, b) => a.number - b.number)
  const seen = new Map()
  for (const item of plan) {
    if (seen.has(item.number)) warnings.push(`第 ${item.number} 章出现两次：${relative(source, seen.get(item.number).file)} 与 ${relative(source, item.file)}`)
    seen.set(item.number, item)
  }

  const rows = plan.map((item) => {
    const key = `vol-01/ch-${String(item.number).padStart(3, '0')}.md`
    const cleaned = item.raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    const needsHeading = !/^#{1,2}\s+\S/.test(cleaned)
    const body = needsHeading ? `# 第 ${item.number} 章 未命名\n\n${cleaned}` : cleaned
    return {
      src: item.file,
      from: relative(source, item.file),
      to: key,
      original: `chapters/_original/${key.replace('vol-01/', '')}`,
      number: item.number,
      heading: needsHeading ? '（原文件没有标题，已补「第 N 章 未命名」）' : item.heading,
      words: item.words,
      needsHeading,
      body,
      exists: existsSync(join(projectDir, 'chapters', key)),
    }
  })

  if (!rows.length) {
    console.error('没认出任何章节。请确认文件名里有 ch-001 这样的编号，或标题写着「第 1 章」。')
    process.exit(2)
  }

  const summary = {
    ok: warnings.length === 0,
    applied: opts.apply,
    project: projectDir,
    count: rows.length,
    totalWords: rows.reduce((sum, r) => sum + r.words, 0),
    warnings,
    rows: rows.map(({ body, src, ...rest }) => rest),
  }

  if (!opts.apply) {
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2))
    } else {
      console.log(`# 导入归一计划（dry-run）\n`)
      console.log(`源目录：\`${source}\`\n目标项目：\`${projectDir}\`\n`)
      console.log('| 章 | 字数 | 原文件 | → 规范路径 | 原稿留底 |')
      console.log('| --- | --- | --- | --- | --- |')
      for (const r of rows) console.log(`| ${r.number} | ${r.words} | ${r.from} | ${r.to} | ${r.original} |`)
      if (warnings.length) {
        console.log('\n## 告警\n')
        for (const w of warnings) console.log(`- ${w}`)
      }
      console.log(`\n共 ${rows.length} 章 ${summary.totalWords} 字。确认无误后加 \`--apply\` 执行。`)
    }
    process.exit(warnings.length ? 1 : 0)
  }

  const dupNumbers = [...seen.entries()].filter(([, item]) => plan.filter((x) => x.number === item.number).length > 1)
  if (dupNumbers.length) {
    console.error(`第 ${dupNumbers.map(([n]) => n).join('、')} 章有多个文件，改名会互相覆盖。请先删掉或改号其中一个，再加 --apply。`)
    process.exit(2)
  }

  mkdirSync(join(projectDir, 'chapters', 'vol-01'), { recursive: true })
  mkdirSync(join(projectDir, 'chapters', '_original'), { recursive: true })
  const manifest = loadManifest(projectDir)
  const archived = []
  const skipped = []
  for (const row of rows) {
    const target = join(projectDir, 'chapters', row.to)
    // 已经导入过就别覆盖：作者可能已经在面板里改过这一章
    if (manifest.chapters[row.to] && existsSync(target)) {
      skipped.push(row.to)
      continue
    }
    const original = join(projectDir, row.original)
    if (!existsSync(original)) copyFileSync(row.src, original)
    writeFileSync(target, row.body)
    let result
    try {
      result = archiveChapter(projectDir, row.to, row.body, manifest, { quiet: true })
      archived.push({ to: row.to, version: result.version, words: result.words })
    } catch (error) {
      warnings.push(`${row.to}：建存档失败（${error.message}）`)
    }
  }
  ensureVersionsIgnore(projectDir)
  summary.archived = archived
  summary.skipped = skipped

  const reportDir = join(projectDir, 'reviews', 'import')
  mkdirSync(reportDir, { recursive: true })
  const lines = []
  lines.push('# 导入归一记录')
  lines.push('')
  lines.push(`- 源目录：\`${source}\``)
  lines.push(`- 时间：${new Date().toISOString()}`)
  lines.push(`- 章数：${rows.length}，共 ${summary.totalWords} 字`)
  lines.push('')
  lines.push('| 章 | 字数 | 原文件 | 规范路径 | 存档 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const r of rows) {
    const a = archived.find((x) => x.to === r.to)
    lines.push(`| ${r.number} | ${r.words} | ${r.from} | ${r.to} | ${a ? `v${a.version}` : '—'} |`)
  }
  if (warnings.length) {
    lines.push('')
    lines.push('## 告警')
    lines.push('')
    for (const w of warnings) lines.push(`- ${w}`)
  }
  lines.push('')
  lines.push('原稿在 `chapters/_original/` 留了底，正文内容除「补标题、统一换行」外未做改动。')
  writeFileSync(join(reportDir, 'normalize.md'), `${lines.join('\n')}\n`)

  if (opts.json) console.log(JSON.stringify(summary, null, 2))
  else {
    console.log(`已归一 ${archived.length} 章：${archived.map((a) => `${a.to} v${a.version}`).join('、') || '（都已在项目里，跳过）'}`)
    if (skipped.length) console.log(`跳过 ${skipped.length} 章（项目里已有，可能是你改过的稿）：${skipped.join('、')}`)
    console.log(`记录写在 reviews/import/normalize.md`)
    for (const w of warnings) console.log(`⚠ ${w}`)
  }
  process.exit(warnings.length ? 1 : 0)
}

main()
