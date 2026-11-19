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

/** 每次都在全新的沙箱里求值，避免模块级状态跨场景串味。 */
function loadClient() {
  let loaded = null
  const win = {
    __ModuleLoader__: { load: ({ id, factory }) => { loaded = { id, mod: factory((n) => (n === 'react' ? React : {})) } } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    confirm: () => true,
    fetch: async () => ({ ok: true, text: async () => '{}', json: async () => ({}) }),
    requestAnimationFrame: (f) => f(),
    document: { activeElement: null, addEventListener() {}, removeEventListener() {}, createElement: el },
  }
  const box = {
    window: win, document: win.document, React, console, setTimeout, clearTimeout,
    fetch: win.fetch, requestAnimationFrame: win.requestAnimationFrame, localStorage: win.localStorage,
  }
  box.require = (n) => (n === 'react' ? React : {})
  box.globalThis = box
  vm.createContext(box)
  vm.runInContext(src, box, { filename: file })
  if (!loaded) throw new Error('没有调用 window.__ModuleLoader__.load')
  if (typeof loaded.mod.apply !== 'function') throw new Error('导出的 apply 不是函数')
  return loaded.mod
}

try { loadClient() } catch (e) { problems.push(`client bundle 求值失败：${e.message}`) }

// 场景一：cordis 严格 ctx —— 访问未注入的服务属性即抛错（真实宿主会让整条 entry 失败）
try {
  const mod = loadClient()
  const regs = []
  const slots = { inject: (n, fn) => { const r = fn && fn(); regs.push(r); return r }, register: (spec, comp) => ({ spec, comp }) }
  const strict = new Proxy({ slots, effect: (fn) => fn && fn(), get: () => null }, {
    get(target, key) {
      if (key in target) return target[key]
      throw new Error(`service "${String(key)}" is not available`)
    },
  })
  mod.apply(strict)
  if (!regs.some((r) => r && r.comp)) problems.push('apply() 没有注册任何界面组件')
} catch (e) {
  problems.push(`apply() 在严格 ctx 下抛错：${e.message}`)
}

// 场景二：现在就拿得到 locale 服务 —— 侧栏标签应立刻是英文
try {
  const mod = loadClient()
  const specs = []
  const ctx = {
    slots: { inject: (n, fn) => fn && fn(), register: (spec) => { specs.push(spec); return { spec } } },
    effect: (fn) => fn && fn(),
    get: (name) => (name === 'locale' ? { register() {}, bind: (ns) => (k) => `en:${ns}:${k}` } : undefined),
  }
  mod.apply(ctx)
  const label = specs.find((x) => x && x.name === 'sidebar.panellist')
  const text = label && label.label ? label.label() : ''
  if (!/^en:novel-assistant:panel\.name$/.test(text)) problems.push(`locale 就绪时标签不是英文：${text}`)
} catch (e) {
  problems.push(`locale 就绪场景抛错：${e.message}`)
}

// 场景三：语言服务晚于插件激活 —— 通过 ctx.inject 回调补注册，标签随后变英文
try {
  const mod = loadClient()
  const specs = []
  let late = null
  const ctx = {
    slots: { inject: (n, fn) => fn && fn(), register: (spec) => { specs.push(spec); return { spec } } },
    effect: (fn) => fn && fn(),
    get: () => null,
    inject: (deps, cb) => { late = cb },
  }
  mod.apply(ctx)
  const label = specs.find((x) => x && x.name === 'sidebar.panellist')
  const before = label && label.label ? label.label() : ''
  if (!/小说助手/.test(before)) problems.push(`语言服务晚到时，切换前标签不是中文：${before}`)
  if (late) late({ get: (name) => (name === 'locale' ? { register() {}, bind: (ns) => (k) => `en:${ns}:${k}` } : undefined) })
  const after = label && label.label ? label.label() : ''
  if (!/^en:novel-assistant:panel\.name$/.test(after)) problems.push(`语言服务晚到时，切换后标签没有变英文：${after}`)
} catch (e) {
  problems.push(`语言服务晚到场景抛错：${e.message}`)
}

if (problems.length) {
  console.error('✘ client bundle 检查未通过')
  for (const p of problems) console.error(`   - ${p}`)
  process.exit(1)
}
console.log('✔ client bundle 可加载：id / inject / apply 正常')
