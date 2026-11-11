#!/usr/bin/env node
/**
 * 导入工具回归：造两个临时项目，跑 scan / normalize，断言关键行为。
 *
 * 用法：node test/check-import.mjs
 * 退出码：0 全过 / 1 有失败
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = join(HERE, '..', 'skills', 'novel-import', 'tools')
const PARA = '沈砚把算盘推到灯下，珠子撞出一声轻响。她数到第七档，指尖停住。账上写的是三千石，装船的吃水却只到七尺一寸——差的那一寸，就是四百二十石粮。\n\n'

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

function run(script, args) {
  try {
    const stdout = execFileSync(process.execPath, [join(TOOLS, script), ...args], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') }
  }
}

const root = mkdtempSync(join(tmpdir(), 'novel-import-'))
try {
  // 案例 1：有 chapters + outline，文件名风格混杂，含一章无标题
  const a = join(root, 'a')
  mkdirSync(join(a, 'chapters'), { recursive: true })
  mkdirSync(join(a, 'novel-project', 'outline'), { recursive: true })
  writeFileSync(join(a, 'chapters', '1 闸口.md'), `# 第 1 章 闸口\n\n${PARA.repeat(10)}`)
  writeFileSync(join(a, 'chapters', '第二章 铁匣.md'), `# 第 2 章 铁匣\n\n${PARA.repeat(10)}`)
  writeFileSync(join(a, 'chapters', 'ch_003.md'), `${PARA.repeat(9)}`)
  writeFileSync(join(a, 'novel-project', 'outline', 'vol-01.md'), '# 卷一\n\n1-3 章\n')

  const scan = run('import-scan.mjs', [a, '--project', join(a, 'novel-project'), '--json'])
  const scanned = JSON.parse(scan.stdout)
  check('扫描认出 3 章', scanned.chapters === 3, `实际 ${scanned.chapters}`)
  check('判定为案例 1', scanned.mode === 'chapters+outline', scanned.mode)
  check('缺九份账本里的大纲也被点名', scanned.missingBible.some((x) => x.file === 'bible/digest.md'))
  check('无标题的章节被抓出来', scanned.problems.some((p) => p.includes('没有标题行')))

  const dry = run('import-normalize.mjs', [a, '--project', join(a, 'novel-project')])
  check('默认 dry-run 不写文件', !existsSync(join(a, 'novel-project', 'chapters')), `exit=${dry.code}`)
  check('dry-run 打印了规范路径', dry.stdout.includes('vol-01/ch-001.md'))

  const apply = run('import-normalize.mjs', [a, '--project', join(a, 'novel-project'), '--apply'])
  check('apply 成功', apply.code === 0, apply.stderr)
  check('副本落在 vol-01', existsSync(join(a, 'novel-project', 'chapters', 'vol-01', 'ch-003.md')))
  check('原稿留底', existsSync(join(a, 'novel-project', 'chapters', '_original', 'ch-003.md')))
  check('建了 v1 存档', existsSync(join(a, 'novel-project', 'chapters', '.versions', 'vol-01', 'ch-003.v1.md')))
  const noHeading = readFileSync(join(a, 'novel-project', 'chapters', 'vol-01', 'ch-003.md'), 'utf8')
  check('无标题章节补了标题', noHeading.startsWith('# 第 3 章 未命名'), noHeading.slice(0, 20))

  const again = run('import-normalize.mjs', [a, '--project', join(a, 'novel-project'), '--apply'])
  check('重复执行不覆盖（幂等）', again.stdout.includes('都已在项目里'), again.stdout.trim().split('\n')[0])

  // 案例 2：只有 chapters，中文文件名
  const b = join(root, 'b')
  mkdirSync(join(b, '稿件'), { recursive: true })
  for (let i = 1; i <= 4; i++) writeFileSync(join(b, '稿件', `第${i}章 试写.md`), PARA.repeat(8))
  const scan2 = run('import-scan.mjs', [b, '--json'])
  check('案例 2 判定正确', JSON.parse(scan2.stdout).mode === 'chapters-only')
  const apply2 = run('import-normalize.mjs', [join(b, '稿件'), '--project', join(b, 'novel-project'), '--apply'])
  check('案例 2 apply 成功', apply2.code === 0, apply2.stderr)
  check('案例 2 四章都在', [1, 2, 3, 4].every((n) => existsSync(join(b, 'novel-project', 'chapters', 'vol-01', `ch-00${n}.md`))))

  // 章号重复必须拒绝
  const c = join(root, 'c')
  mkdirSync(join(c, 'chapters'), { recursive: true })
  writeFileSync(join(c, 'chapters', 'ch-001.md'), `# 第 1 章 甲\n\n${PARA.repeat(6)}`)
  writeFileSync(join(c, 'chapters', 'ch-001-副本.md'), `# 第 1 章 乙\n\n${PARA.repeat(6)}`)
  const dup = run('import-normalize.mjs', [c, '--project', join(c, 'novel-project'), '--apply'])
  check('章号重复时拒绝执行', dup.code === 2, `exit=${dup.code}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

let failed = 0
for (const r of results) {
  if (r.ok) console.log(`✔ ${r.name}`)
  else {
    failed++
    console.log(`✘ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)
