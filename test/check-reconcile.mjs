#!/usr/bin/env node
/**
 * 改稿判定的回归测试（零依赖）：这些用例对应真实踩过的坑，别删。
 * 跑法：node test/check-reconcile.mjs
 */
import { buildPayload } from '../lib/reconcile.js'

let failed = 0
const names = new Set(['赵贵', '裴渡', '沈青'])

const FACTS = ['| 三闸闸槽水深 | 七尺二寸 | 第 1 章 |', '| 满载吃水 | 七尺八寸 | 第 1 章 |'].join('\n')

function verdict(beforeText, afterText, factsText = '') {
  return buildPayload({
    chapter: 1,
    key: 'vol-01/ch-001.md',
    beforeText,
    afterText,
    names,
    baseline: { version: 1 },
    factsText,
  })
}

function check(title, fn) {
  try {
    fn()
    console.log(`  ok   ${title}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${title}\n       ${error.message}`)
  }
}

function expect(actual, wanted, hint) {
  if (actual !== wanted) throw new Error(`${hint || ''} 期望 ${wanted}，实际 ${actual}`)
}

const base = [
  '他伸手拨了一下算盘。「空船三尺一寸，每百石下沉一寸四分。」',
  '赵贵把册子拍在桌上：「满载三千石，吃水七尺八寸，过不去水深七尺二寸的三道闸。」',
  '差一寸是一寸。差两寸，就是二百石的粮。',
].join('\n\n')

console.log('改稿判定回归')

// 用户真实踩到的坑：一寸、二寸在整章里都出现过，改一个数字却报级别 1。
check('数字改值：整章里别的段落也有一寸/二寸，仍要报级别 2', () => {
  const after = base.replace('七尺二寸', '七尺一寸')
  const v = verdict(base, after)
  expect(v.suggestedLevel, 2, '数字改了。')
  expect(v.numberAdded.includes('1寸'), true, '应抓到新出现的 1寸。')
  expect(v.numberRemoved.includes('2寸'), true, '应抓到不再出现的 2寸。')
})

check('措辞级：换比喻、不动数字人物，级别 1', () => {
  const after = base.replace('把册子拍在桌上', '把册子往桌上一掼')
  const v = verdict(base, after)
  expect(v.suggestedLevel, 1, '只是措辞。')
})

check('新加台词，级别 2', () => {
  const after = base.replace('差一寸是一寸。', '「你算得倒快。」差一寸是一寸。')
  const v = verdict(base, after)
  expect(v.suggestedLevel >= 2, true, '台词变了。')
})

check('事件结果 + 具体人物，提示级别 3', () => {
  const after = base.replace('差一寸是一寸。', '赵贵认下这笔账。差一寸是一寸。')
  const v = verdict(base, after)
  expect(v.suggestedLevel, 3, '事件结果变了。')
  expect(v.structuralHint, true, '应提示结构级。')
})

check('只改末尾注释：commentOnly，且不报级别 2', () => {
  const beforeText = `${base}\n\n<!-- 本章新增事实：无 -->`
  const afterText = `${base}\n\n<!-- 本章新增事实：沈青提到双闸 -->`
  const v = verdict(beforeText, afterText)
  expect(v.commentOnly, true, '只动了注释。')
  expect(v.suggestedLevel, 1, '注释不算事实改动。')
})

check('伏笔编号消失，级别 2', () => {
  const beforeText = `${base}\n\n（F003 在这里第一次露头。）`
  const afterText = base
  const v = verdict(beforeText, afterText)
  expect(v.suggestedLevel, 2, '伏笔编号没了。')
  expect(v.fxRemoved.includes('F003'), true, '应抓到 F003 消失。')
})

check('改回设定库记的值：不算事实级，也不该挂债', () => {
  const beforeText = `${base}\n\n闸槽水深只有七尺一寸。`
  // 这里 before 已是「误改成一寸」的稿，after 是改回 facts.md 的七尺二寸
  const afterText = `${base}\n\n闸槽水深只有七尺二寸。`
  const v = verdict(beforeText, afterText, FACTS)
  expect(v.suggestedLevel, 1, '这是收口，不是新事实。')
  expect(v.alignedWithFacts, '七尺二寸', '应认出改回的是设定库的值。')
  expect(v.reasons.some((r) => r.includes('改回设定库')), true, '应说明原因。')
})

check('改成设定库里没有的数字：仍是级别 2', () => {
  const beforeText = `${base}\n\n闸槽水深只有七尺二寸。`
  const afterText = `${base}\n\n闸槽水深只有七尺三寸。`
  const v = verdict(beforeText, afterText, FACTS)
  expect(v.suggestedLevel, 2, '新数字没有依据。')
})

if (failed) {
  console.error(`\n${failed} 条判定不对`)
  process.exit(1)
}
console.log('全部通过')
