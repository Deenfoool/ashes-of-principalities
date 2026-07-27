import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const options = { cwd: root, stdio: 'inherit' }

const children = [
  { name: 'server', process: spawn(process.execPath, ['--watch', 'server/server.mjs'], options) },
  { name: 'web', process: spawn(process.execPath, [viteCli, '--host', '0.0.0.0'], options) },
]

let stopping = false

function stop(exitCode = 0) {
  if (stopping) return
  stopping = true

  for (const child of children) {
    if (child.process.exitCode === null && !child.process.killed) child.process.kill()
  }

  process.exitCode = exitCode
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

for (const child of children) {
  child.process.on('error', (error) => {
    console.error(`[dev:${child.name}] Не удалось запустить процесс:`, error)
    stop(1)
  })

  child.process.on('exit', (code, signal) => {
    if (stopping) return
    if (signal) console.error(`[dev:${child.name}] Процесс остановлен сигналом ${signal}.`)
    else if (code !== 0) console.error(`[dev:${child.name}] Процесс завершился с кодом ${code}.`)
    stop(code ?? 1)
  })
}
