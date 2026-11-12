#!/usr/bin/env node
/**
 * 旧项目迁移：给 `bible/foreshadowing.md` 的伏笔表补两列
 * 「当章用途」「显形度」。只加列、不改已有文字，老行填「未评估」。
 *
 * 用法：
 *   node migrate-foreshadowing.mjs [--project novel-project] [--apply] [--json]
 *
 * 默认 dry-run，只打印计划；加 --apply 才写盘（写前留一份 .bak-<日期>，只留一次）。
 * 退出码：0 无需迁移或迁移完成 / 1 有告警（表格对不齐等）/ 2 用法或读不到文件。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const USAGE = `用法：node migrate-foreshadowing.mjs [--project <目录>] [--apply] [--json]

  --project  项目目录，默认 novel-project
  --apply    真正写盘（默认只打印计划）
  --json     输出 JSON`

const argv = process.argv.slice(2)
const opts = { project: 'novel-project', apply: false, json: false }
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--project') opts.project = argv[++i]
  else if (arg === '--apply') opts.apply = true
  else if (arg === '--json') opts.json = true
  else if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0) }
  else { console.error(`未知参数：${arg}\n${USAGE}`); process.exit(2) }
}

const projectDir = isAbsolute(opts.project) ? opts.project : resolve(process.cwd(), opts.project)
const file = join(projectDir, 'bible', 'foreshadowing.md')
if (!existsSync(file)) {
  console.error(`读不到 ${file}`)
  process.exit(2)
}

const NEW_COLS = ['当章用途', '显形度']
const FILLER = '未评估'

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

const lines = readFileSync(file, 'utf8').split('\n')
const headerAt = lines.findIndex((line) => /^\s*\|/.test(line) && /编号/.test(line))
if (headerAt < 0) {
  console.error('没找到伏笔表的表头（含「编号」的那一行）')
  process.exit(2)
}

const header = splitRow(lines[headerAt])
if (header.includes(NEW_COLS[0])) {
  const out = { ok: true, changed: false, why: '已有「当章用途」列，无需迁移', file }
  console.log(opts.json ? JSON.stringify(out, null, 2) : '✔ 已有「当章用途」列，无需迁移。')
  process.exit(0)
}

const targetAt = header.findIndex((cell) => /指向|真相/.test(cell))
if (targetAt < 0) {
  console.error(`表头里找不到「指向的真相」列，实际表头：${header.join(' / ')}`)
  process.exit(2)
}

const warnings = []
const nextHeader = [...header]
nextHeader.splice(targetAt + 1, 0, ...NEW_COLS)

let bodyRows = 0
const nextLines = lines.slice()
nextLines[headerAt] = `| ${nextHeader.join(' | ')} |`

// 分隔行
const sepAt = headerAt + 1
if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[sepAt] || '')) {
  nextLines[sepAt] = `| ${nextHeader.map(() => '---').join(' | ')} |`
} else {
  warnings.push('表头下一行不是分隔行，未改动分隔行')
}

for (let i = sepAt + 1; i < lines.length; i += 1) {
  const line = lines[i]
  if (!/^\s*\|/.test(line)) break
  const cells = splitRow(line)
  if (cells.length !== header.length) {
    warnings.push(`第 ${i + 1} 行有 ${cells.length} 格，表头 ${header.length} 格，已跳过`)
    continue
  }
  const next = [...cells]
  next.splice(targetAt + 1, 0, FILLER, FILLER)
  nextLines[i] = `| ${next.join(' | ')} |`
  bodyRows += 1
}

const plan = {
  ok: warnings.length === 0,
  changed: true,
  applied: opts.apply,
  file,
  addedColumns: NEW_COLS,
  rows: bodyRows,
  filledWith: FILLER,
  warnings,
}

if (opts.apply) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const backup = `${file}.bak-${stamp}`
  if (!existsSync(backup)) copyFileSync(file, backup)
  writeFileSync(file, nextLines.join('\n'))
  plan.backup = existsSync(backup) ? backup : null
}

if (opts.json) console.log(JSON.stringify(plan, null, 2))
else {
  console.log(`${opts.apply ? '✔ 已迁移' : '· 计划（未写盘）'}：在「${header[targetAt]}」之后插入 ${NEW_COLS.join(' / ')}`)
  console.log(`  影响 ${bodyRows} 行，新列填「${FILLER}」`)
  console.log(`  文件：${file}`)
  if (plan.backup) console.log(`  备份：${plan.backup}`)
  if (!opts.apply) console.log('  加 --apply 执行')
  for (const w of warnings) console.log(`  ! ${w}`)
}

process.exit(warnings.length ? 1 : 0)
