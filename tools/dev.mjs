import { spawn } from 'node:child_process'

const children = [
  spawn(process.execPath, ['--watch', 'server/server.mjs'], { stdio: 'inherit' }),
  spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:web'], { stdio: 'inherit' }),
]

const stop = (signal = 'SIGTERM') => {
  for (const child of children) child.kill(signal)
}

process.on('SIGINT', () => { stop('SIGINT'); process.exit(0) })
process.on('SIGTERM', () => { stop('SIGTERM'); process.exit(0) })

for (const child of children) {
  child.on('exit', (code) => {
    if (code && code !== 0) {
      stop()
      process.exit(code)
    }
  })
}
