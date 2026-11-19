#!/usr/bin/env node
/**
 * 浏览器半侧的加载冒烟：用假 window / React 载入 lib/client.js，
 * 断言它能被求值、导出 id/inject/apply，并且 apply() 不抛错。
 *
 * 目的：面板的 client bundle 只有真机启动时才会被求值，一旦语法或顶层代码出错，
 * 宿主表现为「entry did not activate」，整个 DSH 起不来。把这一步放进 `npm test`，
 * 重启前就能拦住。
 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'lib', 'client.js')
const src = fs.readFileSync(file, 'utf8')

const el = () => ({
  style: {}, children: [], attributes: {}, dataset: {},
  appendChild(c) { this.children.push(c); return c },
  setAttribute(k, v) { this.attributes[k] = String(v) },
  getAttribute(k) { return this.attributes[k] ?? null },
  removeAttribute(k) { delete this.attributes[k] },
  addEventListener() {}, removeEventListener() {},
  querySelectorAll() { return [] }, querySelector() { return null },
  closest() { return null }, contains() { return false }, remove() {},
})

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {}, useRef: (v) => ({ current: v ?? null }),
  useCallback: (f) => f, useMemo: (f) => f(), Fragment: 'Fragment',
}

let loaded = null
const window = {
  __ModuleLoader__: { load: ({ id, factory }) => { loaded = { id, mod: factory((n) => (n === 'react' ? React : {})) } } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  confirm: () => true,
  fetch: async () => ({ ok: true, text: async () => '{}', json: async () => ({}) }),
  requestAnimationFrame: (f) => f(),
  document: { activeElement: null, addEventListener() {}, removeEventListener() {}, createElement: el },
}
const sandbox = {
  window, document: window.document, React, console, setTimeout, clearTimeout,
  fetch: window.fetch, requestAnimationFrame: window.requestAnimationFrame,
  localStorage: window.localStorage,
}
sandbox.require = (n) => (n === 'react' ? React : {})
sandbox.globalThis = sandbox
vm.createContext(sandbox)

const problems = []
try {
  vm.runInContext(src, sandbox, { filename: file })
} catch (e) {
  problems.push(`client.js 求值失败：${e.message}`)
}
if (!loaded) problems.push('client.js 没有调用 window.__ModuleLoader__.load')
else {
  const mod = loaded.mod || {}
  if (typeof mod.apply !== 'function') problems.push('导出的 apply 不是函数')
  else {
    const regs = []
    const ctx = {
      slots: { inject: (n, fn) => { const r = fn && fn(); regs.push(r); return r }, register: (spec, comp) => ({ spec, comp }) },
      effect: (fn) => fn && fn(),
      get: () => null,
      locale: null,
    }
    try { mod.apply(ctx) } catch (e) { problems.push(`apply() 抛错：${e.message}`) }
    if (!regs.some((r) => r && r.comp)) problems.push('apply() 没有注册任何界面组件')
  }
}

if (problems.length) {
  console.error('✘ client bundle 检查未通过')
  for (const p of problems) console.error('   -', p)
  process.exit(1)
}
console.log('✔ client bundle 可加载：id / inject / apply 正常')
