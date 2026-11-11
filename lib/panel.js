/**
 * 兼容入口：面板的宿主半侧已移到包根（`lib/index.js`）。
 *
 * 原因：`dsh-client-modules` 只给「模块名恰好是包名」的 Loader 行解析客户端清单
 * （`exactPackageSpecifier` 不接受子路径），所以宿主行必须挂包根，浏览器半侧才会
 * 被组合进启动图。这里保留导出，旧引用不会断。
 * @module dsh-novel-assistant/lib/panel
 */
export { name, inject, apply } from './index.js'
