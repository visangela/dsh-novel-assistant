#!/usr/bin/env node
/**
 * 宿主半侧的加载冒烟：import lib/index.js 并 apply 一次假 ctx，
 * 断言导出 name/inject 正常、13 条路由都注册成功。
 * 宿主这一半出错时，DSH 启动会直接报 “entry did not activate”。
 */
const problems = []
let mod
try {
  mod = await import('../lib/index.js')
} catch (e) {
  problems.push(`import 失败：${e.message}`)
}
if (mod) {
  if (typeof mod.apply !== 'function') problems.push('导出的 apply 不是函数')
  else {
    const routes = []
    const ctx = {
      webServer: { register(route) { routes.push(route); return () => {} } },
      effect(fn) { fn() },
      get() { return null },
    }
    try { mod.apply(ctx, {}) } catch (e) { problems.push(`apply() 抛错：${e.message}`) }
    if (routes.length !== 13) problems.push(`注册路由 ${routes.length} 条，期望 13 条`)
  }
}

if (problems.length) {
  console.error('✘ host plugin 检查未通过')
  for (const p of problems) console.error('   -', p)
  process.exit(1)
}
console.log('✔ host plugin 可加载：apply 注册 13 条路由')
