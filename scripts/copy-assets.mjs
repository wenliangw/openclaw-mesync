// scripts/copy-assets.mjs — 复制静态资源（模板 md）到 dist
// tsc 只编译 .ts，不复制 .md 等静态资源，这里手动复制。
// 模板按 rules/、skills/ 分类存放，递归复制子目录。

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const srcTemplates = path.join(root, 'templates')
const dstTemplates = path.join(root, 'dist', 'templates')

if (!fs.existsSync(srcTemplates)) {
  console.log('[copy-assets] templates 不存在，跳过')
  process.exit(0)
}

fs.mkdirSync(dstTemplates, { recursive: true })

let count = 0

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath)
    } else {
      fs.copyFileSync(srcPath, dstPath)
      count++
    }
  }
}

copyDir(srcTemplates, dstTemplates)

console.log(`[copy-assets] 复制 ${count} 个模板文件到 dist/templates/`)
