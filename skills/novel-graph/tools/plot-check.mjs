#!/usr/bin/env node
/**
 * 强度曲线自检：只查三种「形状」，不评价写得好不好。
 *
 * 1. 平线：同一条故事线连续 3 章一个值 —— 这条线三章没有推进。
 * 2. 掉速：前一章 ≥4、下一章掉 ≥2 分 —— 通常是该爆的地方写软了。
 * 3. 断钩：埋了一条伏笔，之后两章内主线跌到 ≤1 —— 埋了没接。
 *
 * 用法：
 *   node plot-check.mjs [--project novel-project] [--json] [--min-run 3] [--drop 2]
 *
 * 退出码：0 没问题 / 1 有提示 / 2 用法或读不到表。
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const USAGE = `用法：node plot-check.mjs [--project <目录>] [--json] [--min-run N] [--drop N]

  --project   项目目录，默认 novel-project
  --min-run   连续同值多少章算平线，默认 3
  --drop      相邻两章掉多少分算掉速，默认 2
  --json      输出 JSON`

function parseArgs(argv) {
  const options = { project: 'novel-project', json: false, minRun: 3, drop: 2 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--project') options.project = argv[++i]
    else if (arg === '--min-run') options.minRun = Number(argv[++i])
    else if (arg === '--drop') options.drop = Number(argv[++i])
    else if (arg === '-h' || arg === '--help') { console.log(USAGE); process.exit(0) }
    else { console.error(`未知参数：${arg}\n\n${USAGE}`); process.exit(2) }
  }
  if (!Number.isFinite(options.minRun) || options.minRun < 2) options.minRun = 3
  if (!Number.isFinite(options.drop) || options.drop < 1) options.drop = 2
  return options
}

/** 读一张 markdown 表格，返回 { header, rows }；rows 是字符串数组的数组。 */
function parseTable(section) {
  const header = []
  const rows = []
  let state = 'idle'
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('|')) {
      if (state === 'body') break
      continue
    }
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
    if (state === 'idle') { header.push(...cells); state = 'divider'; continue }
    if (state === 'divider') { state = 'body'; continue }
    rows.push(cells)
  }
  return { header, rows }
}

/** 截取某个二级标题下的内容，遇到下一个二级标题就停。 */
function section(markdown, title) {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim().startsWith('## ') && line.includes(title))
  if (start === -1) return ''
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i].trim())) break
    out.push(lines[i])
  }
  return out.join('\n')
}

function toNumber(cell) {
  const value = Number(String(cell).trim())
  return Number.isFinite(value) ? value : null
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const projectDir = isAbsolute(options.project) ? options.project : resolve(process.cwd(), options.project)
  const plotFile = join(projectDir, 'bible', 'plot-map.md')
  if (!existsSync(plotFile)) {
    console.error(`读不到 ${plotFile}：先跑 graph-sync.mjs 生成表`)
    process.exit(2)
  }

  const plotText = readFileSync(plotFile, 'utf8')
  const { header, rows } = parseTable(section(plotText, '故事线强度'))
  if (!rows.length || header.length < 2) {
    console.error('plot-map.md 里没有「故事线强度」表，或表是空的：先跑 graph-sync.mjs')
    process.exit(2)
  }

  const series = header.slice(1)
  const points = rows.map((row) => ({
    chapter: Number.parseInt(row[0], 10),
    values: series.map((_, index) => toNumber(row[index + 1])),
  })).filter((point) => Number.isFinite(point.chapter))

  const notes = []
  const push = (kind, message, extra = {}) => notes.push({ kind, message, ...extra })

  // 1. 平线
  series.forEach((name, index) => {
    let runStart = 0
    for (let i = 1; i <= points.length; i += 1) {
      const same = i < points.length
        && points[i].values[index] !== null
        && points[i].values[index] === points[runStart].values[index]
      if (same) continue
      const length = i - runStart
      const value = points[runStart].values[index]
      if (value !== null && length >= options.minRun) {
        push('flat', `第 ${points[runStart].chapter}–${points[i - 1].chapter} 章「${name}」一直是 ${value} 分：这条线 ${length} 章没推进`, {
          series: name, from: points[runStart].chapter, to: points[i - 1].chapter,
        })
      }
      runStart = i
    }
  })

  // 2. 掉速
  series.forEach((name, index) => {
    for (let i = 1; i < points.length; i += 1) {
      const before = points[i - 1].values[index]
      const after = points[i].values[index]
      if (before === null || after === null) continue
      if (before >= 4 && before - after >= options.drop) {
        push('drop', `「${name}」第 ${points[i - 1].chapter} 章 ${before} 分 → 第 ${points[i].chapter} 章 ${after} 分：转折处掉速 ${before - after} 分`, {
          series: name, from: points[i - 1].chapter, to: points[i].chapter,
        })
      }
    }
  })

  // 3. 断钩：埋了伏笔，之后两章内主线跌到 ≤1
  const foreFile = join(projectDir, 'bible', 'foreshadowing.md')
  if (existsSync(foreFile)) {
    const foreText = readFileSync(foreFile, 'utf8')
    const table = parseTable(section(foreText, '伏笔') || foreText)
    const head = table.header.join('|')
    const plantedAt = table.header.findIndex((cell) => /埋设/.test(cell))
    const idAt = table.header.findIndex((cell) => /编号|ID/i.test(cell))
    const mainLine = points.map((point) => point.values[0])
    if (plantedAt >= 0) {
      table.rows.forEach((row) => {
        const match = String(row[plantedAt] || '').match(/(\d+)/)
        if (!match) return
        const planted = Number(match[1])
        for (const delta of [1, 2]) {
          const at = points.findIndex((point) => point.chapter === planted + delta)
          if (at < 0) continue
          const value = mainLine[at]
          if (value !== null && value <= 1) {
            const id = idAt >= 0 ? String(row[idAt] || '').trim() : '（未编号）'
            push('hook', `${id} 埋在第 ${planted} 章，第 ${planted + delta} 章主线跌到 ${value} 分：埋了钩子没接上`, {
              series: series[0], from: planted, to: planted + delta, id,
            })
            break
          }
        }
      })
      void head
    }
  }

  const result = {
    ok: notes.length === 0,
    chapters: points.length,
    series,
    minRun: options.minRun,
    drop: options.drop,
    notes,
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    process.exit(notes.length ? 1 : 0)
  }

  console.log(`强度曲线：${points.length} 章 × ${series.length} 条线（平线阈值 ${options.minRun} 章，掉速阈值 ${options.drop} 分）`)
  if (!notes.length) {
    console.log('✔ 没有平线、没有掉速、没有断钩。')
    process.exit(0)
  }
  for (const note of notes) {
    const mark = note.kind === 'hook' ? '✘' : '△'
    console.log(`${mark} [${note.kind}] ${note.message}`)
  }
  console.log(`\n共 ${notes.length} 条。这些只是「值得看一眼」的位置，不是判词：平线可能是刻意的铺垫，掉速也可能是换线叙述。`)
  process.exit(1)
}

main()
