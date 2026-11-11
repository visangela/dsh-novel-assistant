#!/usr/bin/env node
/**
 * 导入体检：扫一遍已有稿件，说清楚「有什么、缺什么、哪里对不上」。
 *
 * 只读。不改任何文件，不调用模型。
 *
 * 用法：
 *   node import-scan.mjs <目录> [--json] [--write] [--project <项目目录>]
 *
 * 退出码：0 干净 / 1 有需要处理的问题 / 2 路径读不到
 */
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { countWords } from '../../../lib/versions.js'

const EXPECTED_BIBLE = [
  ['bible/outline.md', '大纲'],
  ['bible/style.md', '风格'],
  ['bible/characters/_index.md', '人物索引'],
  ['bible/timeline.md', '时间线'],
  ['bible/foreshadowing.md', '伏笔'],
  ['bible/facts.md', '硬事实'],
  ['bible/digest.md', '章节摘要'],
  ['bible/relationship-map.md', '关系图'],
  ['bible/plot-map.md', '情节图'],
]

const SKIP_DIRS = new Set(['node_modules', '.git', '.versions', '_original', 'reviews'])

function parseArgs(argv) {
  const opts = { dir: '', json: false, write: false, project: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') opts.json = true
    else if (arg === '--write') opts.write = true
    else if (arg === '--project') opts.project = argv[++i] || ''
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
  if (heading) {
    const fromHeading = heading.match(/第\s*(\d{1,4})\s*章/)
    if (fromHeading) return Number(fromHeading[1])
  }
  return null
}

function classify(files, root) {
  const rows = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const headingLine = text.split(/\r?\n/).find((line) => /^#{1,2}\s+\S/.test(line)) || ''
    const heading = headingLine.replace(/^#{1,2}\s+/, '').trim()
    const words = countWords(text)
    const number = chapterNumber(file, heading)
    const headingNumber = heading.match(/第\s*(\d{1,4})\s*章/)
    rows.push({
      file,
      rel: relative(root, file),
      number,
      heading,
      headingNumber: headingNumber ? Number(headingNumber[1]) : null,
      words,
      crlf: /\r\n/.test(text),
      bom: text.charCodeAt(0) === 0xfeff,
      bytes: Buffer.byteLength(text, 'utf8'),
      looksLikeChapter: Boolean(
        number !== null
        || (words >= 600 && /chapters?[\\/]/i.test(relative(root, file)))
        || (words >= 600 && /第\s*\d+\s*章/.test(heading)),
      ),
    })
  }
  return rows
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || !opts.dir) {
    console.log('用法：node import-scan.mjs <目录> [--json] [--write] [--project <项目目录>]')
    process.exit(opts.help ? 0 : 2)
  }
  const root = resolve(opts.dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`读不到目录：${root}`)
    process.exit(2)
  }

  const projectGuess = opts.project
    ? resolve(opts.project)
    : existsSync(join(root, 'novel-project')) ? join(root, 'novel-project') : root
  const skipRoots = projectGuess === root
    ? []
    : [join(projectGuess, 'chapters'), join(projectGuess, 'bible'), join(projectGuess, 'reviews')]
  const files = walk(root, [], skipRoots)

  const rows = classify(files, root)
  const chapters = rows.filter((r) => r.looksLikeChapter).sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || a.rel.localeCompare(b.rel))
  const others = rows.filter((r) => !r.looksLikeChapter)

  const numbers = chapters.map((c) => c.number).filter((n) => n !== null)
  const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i)
  const unique = [...new Set(numbers)].sort((a, b) => a - b)
  const gaps = []
  if (unique.length > 1) {
    for (let n = unique[0]; n <= unique[unique.length - 1]; n++) {
      if (!unique.includes(n)) gaps.push(n)
    }
  }

  const hasOutlineEarly = existsSync(join(projectGuess, 'bible', 'outline.md')) || existsSync(join(projectGuess, 'outline'))
  const mode = chapters.length === 0 ? 'no-manuscript' : hasOutlineEarly ? 'chapters+outline' : 'chapters-only'

  const problems = []
  if (!chapters.length) problems.push('一个章节都没认出来：文件既不在 chapters/ 下，也没有 ch-001 / 第 1 章 这样的编号')
  if (duplicates.length) problems.push(`章号重复：${[...new Set(duplicates)].join('、')}`)
  if (gaps.length) problems.push(`章号不连续，缺：${gaps.join('、')}`)
  const noHeading = chapters.filter((c) => !c.heading)
  if (noHeading.length) problems.push(`没有标题行：${noHeading.slice(0, 5).map((c) => c.rel).join('、')}${noHeading.length > 5 ? ' 等' : ''}`)
  const mismatch = chapters.filter((c) => c.number !== null && c.headingNumber !== null && c.number !== c.headingNumber)
  if (mismatch.length) problems.push(`文件名与标题的章号不一致：${mismatch.slice(0, 5).map((c) => `${c.rel}（标题第 ${c.headingNumber} 章）`).join('、')}`)
  if (mode === 'no-manuscript') problems.push('没有正文：先跑 project-upgrade.mjs 迁移账本，不要用 import-normalize.mjs')
  if (chapters.some((c) => c.crlf)) problems.push('有文件是 CRLF 换行（Windows 写的）：导入时会统一成 LF，正文内容不变')
  if (chapters.some((c) => c.bom)) problems.push('有文件带 BOM：导入时会去掉，正文内容不变')

  const missing = EXPECTED_BIBLE.filter(([file]) => !existsSync(join(projectGuess, file))).map(([file, label]) => ({ file, label }))
  const hasProject = existsSync(join(projectGuess, 'PROJECT.md'))
  const hasOutline = existsSync(join(projectGuess, 'bible', 'outline.md')) || existsSync(join(projectGuess, 'outline'))

  const words = chapters.map((c) => c.words).filter((n) => n > 0)
  const total = words.reduce((sum, n) => sum + n, 0)
  const sorted = [...words].sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0

  const result = {
    ok: problems.length === 0,
    root,
    project: projectGuess,
    chapters: chapters.length,
    totalWords: total,
    medianWords: median,
    shortest: sorted.length ? sorted[0] : 0,
    longest: sorted.length ? sorted[sorted.length - 1] : 0,
    mode,
    hasProject,
    missingBible: missing,
    problems,
    otherMarkdown: others.map((r) => r.rel),
    list: chapters.map((c) => ({ number: c.number, heading: c.heading, words: c.words, file: c.rel })),
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    process.exit(problems.length ? 1 : 0)
  }

  const modeText = mode === 'no-manuscript'
    ? '案例 0：没有正文（旧项目迁移，不是导入）'
    : mode === 'chapters+outline' ? '案例 1：已有 chapters + outline' : '案例 2：只有 chapters'
  const lines = []
  lines.push(`# 导入体检 · ${basename(root)}`)
  lines.push('')
  lines.push(`- 扫描目录：\`${root}\``)
  lines.push(`- 判定：${modeText}`)
  if (mode === 'no-manuscript') {
    lines.push('- 说明：这套 `novel-import` 流程处理的是「已经写了正文」的稿子；没有正文的项目应该走 `project-upgrade.mjs` 补账本与 PROJECT.md 字段，然后从当前阶段继续。')
  }
  lines.push(`- 章节：${chapters.length} 章，共 ${total} 字（中位 ${median} 字/章，最短 ${sorted[0] || 0}，最长 ${sorted[sorted.length - 1] || 0}）`)
  lines.push(`- 已有 PROJECT.md：${hasProject ? '是' : '否'}`)
  lines.push('')
  lines.push('## 章节清单')
  lines.push('')
  lines.push('| 章 | 标题 | 字数 | 文件 |')
  lines.push('| --- | --- | --- | --- |')
  for (const c of chapters) {
    lines.push(`| ${c.number ?? '?'} | ${c.heading || '（无标题）'} | ${c.words} | ${c.rel} |`)
  }
  lines.push('')
  lines.push('## 缺什么')
  lines.push('')
  if (!missing.length) {
    lines.push('设定库的九份都在，导入只需要补正文与摘要。')
  } else {
    lines.push('| 缺 | 名称 | 导入时怎么补 |')
    lines.push('| --- | --- | --- |')
    const how = {
      'bible/outline.md': '案例 1 直接搬；案例 2 按已写部分反推，标「推定」',
      'bible/style.md': '读正文统计句长/段长/对话占比，摘 5 段样文',
      'bible/characters/_index.md': '扫人名与称谓，逐章归纳后去重',
      'bible/timeline.md': '逐章抓时间词（次日、三日后、霜降夜）',
      'bible/foreshadowing.md': '只收正文里明确有回应的；反复出现的物件另列「疑似」',
      'bible/facts.md': '抓数字 + 单位，逐条指回原句',
      'bible/digest.md': '每章一句话 + 谁的状态变了 + 埋收了什么',
      'bible/relationship-map.md': '从人物小传的「关系网」表汇总',
      'bible/plot-map.md': '按章给每条线打分，再算伏笔埋收',
    }
    for (const item of missing) lines.push(`| \`${item.file}\` | ${item.label} | ${how[item.file] || '导入时补'} |`)
  }
  lines.push('')
  lines.push('## 要对账的问题')
  lines.push('')
  if (!problems.length) {
    lines.push('没有发现章号、标题或编码层面的问题。')
  } else {
    for (const problem of problems) lines.push(`- ${problem}`)
  }
  lines.push('')
  lines.push('## 下一步')
  lines.push('')
  lines.push(`1. 确认章序：上面 ${chapters.length} 章的顺序对不对（脚本按文件名与标题的章号排）`)
  lines.push(`2. 运行 \`node "${fileURLToPath(new URL('./import-normalize.mjs', import.meta.url))}" ${root} --project ${projectGuess}\`，先看它准备怎么改名与建存档`)
  lines.push('3. 归一确认后再跑阶段 3–5 的抽取（novel-import 技能第三节）')

  const markdown = lines.join('\n')
  if (opts.write) {
    const dir = join(projectGuess, 'reviews', 'import')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'scan.md')
    writeFileSync(file, `${markdown}\n`)
    console.log(`已写入 ${file}`)
  } else {
    console.log(markdown)
  }
  process.exit(problems.length ? 1 : 0)
}

main()
