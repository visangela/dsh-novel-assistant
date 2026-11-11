#!/usr/bin/env node
/**
 * 项目升级：把旧版插件建的项目补到当前账本结构。
 *
 * 只补缺、不覆盖、不改正文。默认只打印计划，加 --apply 才写文件。
 *
 * 用法：
 *   node project-upgrade.mjs <项目目录> [--apply] [--json]
 *
 * 退出码：0 已是新版 / 1 有待补项 / 2 路径错
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATES = resolve(HERE, '..', '..', 'novel-setup', 'templates')

const LEDGERS = [
  ['bible/facts.md', '硬事实表'],
  ['bible/digest.md', '章节摘要'],
  ['bible/timeline.md', '时间线'],
  ['bible/foreshadowing.md', '伏笔登记'],
  ['bible/knowledge-reader.md', '读者已知'],
  ['bible/knowledge-protagonist.md', '主角已知'],
  ['bible/outline.md', '故事大纲'],
  ['bible/style.md', '风格指导书'],
  ['bible/architecture.md', '架构'],
  ['bible/characters/_index.md', '人物索引'],
]

const GENERATED = [
  ['bible/relationship-map.md', '人物关系图（跑 graph-sync --init 生成）'],
  ['bible/plot-map.md', '情节发展地图（跑 graph-sync --init 生成）'],
]

function parseArgs(argv) {
  const opts = { dir: '', apply: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') opts.apply = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (!arg.startsWith('--')) opts.dir = arg
  }
  return opts
}

const BODY_MODEL_BLOCK = `## 正文模型

| 项 | 值 | 说明 |
| --- | --- | --- |
| 通道 | 主代理自写 | 主代理自写 / 自动代笔（L1） / 手动代笔（L2，默认关） |
| 代笔模型 | 不指定 | 选了 L1 才填，例如 antigravity/gemini-4-argon-low |
| 手动通道 | 关 | 关 / 开；开了才出 prompt.md 与 context.md |
| 选择方式 | 跟随默认 | 试笔 / 直接指定 / 跟随默认 |
| 试笔结论 | 未试 | 试笔后填：选中 L1 / L3、日期、一句理由 |

`

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || !opts.dir) {
    console.log('用法：node project-upgrade.mjs <项目目录> [--apply] [--json]')
    process.exit(opts.help ? 0 : 2)
  }
  let projectDir = resolve(opts.dir)
  if (existsSync(join(projectDir, 'novel-project'))) projectDir = join(projectDir, 'novel-project')
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    console.error(`读不到目录：${projectDir}`)
    process.exit(2)
  }

  const actions = []
  const warnings = []

  for (const [file, label] of LEDGERS) {
    const target = join(projectDir, file)
    if (existsSync(target)) continue
    const template = join(TEMPLATES, file)
    if (!existsSync(template)) {
      warnings.push(`${file}（${label}）缺失，但模板里也没有，需要手工建`)
      continue
    }
    actions.push({ kind: 'copy', file, label, from: template, target })
  }

  for (const [file, label] of GENERATED) {
    if (!existsSync(join(projectDir, file))) {
      actions.push({ kind: 'generate', file, label, hint: 'graph-sync.mjs --init' })
    }
  }

  const projectFile = join(projectDir, 'PROJECT.md')
  if (!existsSync(projectFile)) {
    warnings.push('没有 PROJECT.md：这不是一个项目目录，先在 novel-setup 里立项')
  } else {
    const text = readFileSync(projectFile, 'utf8')
    if (!/^## 正文模型/m.test(text)) {
      actions.push({ kind: 'patch-project', file: 'PROJECT.md', label: '补「正文模型」块' })
    }
    if (/^\| 卷 \| 标题 \| 章节范围 \| 核心事件 \| 主角变化 \| 卷末高潮 \|/m.test(text) === false) {
      const outlinePath = join(projectDir, 'bible', 'outline.md')
      if (existsSync(outlinePath)) {
        const outline = readFileSync(outlinePath, 'utf8')
        if (/^\| 卷 \| 标题 \| 章节范围 \| 核心事件 \| 主角变化 \| 卷末高潮 \|/m.test(outline)) {
          warnings.push('bible/outline.md 的分卷表是旧五列（缺「主要阻碍」「代价」「留给下一卷的钩子」）：表是空的就直接换新模板，有内容就手工补三列')
        }
      }
    }
    if (!/^\| 故事时间 \| 章节 \| 事件 \|/m.test(text)) {
      const timeline = join(projectDir, 'bible', 'timeline.md')
      if (existsSync(timeline) && !/^\| 故事时间 \| 章节 \| 事件 \| 涉及人物 \| 地点 \| 后续影响 \|/m.test(readFileSync(timeline, 'utf8'))) {
        warnings.push('bible/timeline.md 的列与当前模板不一致，建议按新模板重建（空表直接换）')
      }
    }
  }

  const summary = { ok: actions.length === 0 && warnings.length === 0, applied: opts.apply, projectDir, actions, warnings }

  if (!opts.apply) {
    if (opts.json) console.log(JSON.stringify(summary, null, 2))
    else {
      console.log(`# 项目升级计划（dry-run）\n`)
      console.log(`项目：\`${projectDir}\`\n`)
      if (!actions.length) console.log('账本结构与当前版本一致，没有要补的。')
      else {
        console.log('| 动作 | 文件 | 说明 |')
        console.log('| --- | --- | --- |')
        for (const a of actions) {
          const verb = a.kind === 'copy' ? '补模板' : a.kind === 'generate' ? '待生成' : '改文件'
          console.log(`| ${verb} | \`${a.file}\` | ${a.label}${a.hint ? `（${a.hint}）` : ''} |`)
        }
      }
      if (warnings.length) {
        console.log('\n## 要你决定的\n')
        for (const w of warnings) console.log(`- ${w}`)
      }
      console.log('\n确认无误后加 `--apply` 执行；只补缺，不覆盖任何已有文件。')
    }
    process.exit(actions.length || warnings.length ? 1 : 0)
  }

  for (const action of actions) {
    if (action.kind === 'copy') {
      mkdirSync(dirname(action.target), { recursive: true })
      copyFileSync(action.from, action.target)
    } else if (action.kind === 'patch-project') {
      const text = readFileSync(projectFile, 'utf8')
      const at = text.indexOf('\n## 决策日志')
      const next = at === -1 ? `${text}\n\n${BODY_MODEL_BLOCK}` : `${text.slice(0, at + 1)}\n${BODY_MODEL_BLOCK}${text.slice(at + 1)}`
      writeFileSync(projectFile, next)
    }
  }

  const done = actions.filter((a) => a.kind !== 'generate')
  console.log(`已补 ${done.length} 项：${done.map((a) => a.file).join('、') || '（无）'}`)
  const generate = actions.filter((a) => a.kind === 'generate')
  if (generate.length) {
    console.log(`还有 ${generate.length} 份图要生成，跑：node "<技能 Base directory>/tools/graph-sync.mjs" --project ${projectDir} --init`)
  }
  for (const w of warnings) console.log(`⚠ ${w}`)
  process.exit(warnings.length ? 1 : 0)
}

main()
