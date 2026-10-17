import { createHash } from 'node:crypto'
import process from 'node:process'

import fs from 'fs-extra'

import { r } from './utils'

async function prepareRelease() {
  const pkg = await fs.readJSON(r('package.json'))
  const tag = `v${pkg.version}`
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version))
    throw new Error('发布版本必须为三段数字，例如 1.8.1')
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== tag)
    throw new Error(`标签必须与 package.json 版本一致：${tag}`)

  const output = r('release-assets', tag)
  await fs.ensureDir(output)
  const checksums: string[] = []
  for (const [directory, browser] of [['extension', 'chrome-edge'], ['extension-firefox', 'firefox-unsigned']]) {
    const manifest = await fs.readJSON(r(directory, 'manifest.json'))
    if (manifest.version !== pkg.version || manifest.name !== pkg.displayName
      || JSON.stringify(manifest).includes('localhost') || manifest.permissions.includes('webNavigation')) {
      throw new Error(`${directory} 不是当前版本的生产构建`)
    }
    const files = [
      'LICENSE',
      ...(manifest.background.service_worker ? [manifest.background.service_worker] : manifest.background.scripts),
      ...manifest.content_scripts.flatMap((entry: { js?: string[], css?: string[] }) => [...entry.js ?? [], ...entry.css ?? []]),
      ...Object.values(manifest.icons) as string[],
    ]
    for (const file of files) {
      if (!(await fs.stat(r(directory, file))).isFile())
        throw new Error(`缺少构建文件：${directory}/${file}`)
    }
    const name = `BewlyCatAntiJunk-${tag}-${browser}.zip`
    const data = await fs.readFile(r(`${directory}.zip`))
    await fs.writeFile(`${output}/${name}`, data)
    checksums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`)
  }
  await fs.writeFile(`${output}/SHA256SUMS.txt`, `${checksums.join('\n')}\n`)
  await fs.copyFile(r('docs/RELEASE-NOTES.md'), `${output}/INSTALL.md`)
  console.log(`发布文件已生成：${output}`)
}
prepareRelease().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
