import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = join(root, '.test-build')
const executable = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')

await rm(output, { recursive: true, force: true })
const compile = spawnSync(executable, [
  'src/game/types.ts',
  'src/game/content.ts',
  'src/game/engine.ts',
  '--module', 'commonjs',
  '--moduleResolution', 'node',
  '--target', 'ES2022',
  '--lib', 'ES2022,DOM',
  '--strict',
  '--skipLibCheck',
  '--outDir', output,
], { cwd: root, stdio: 'inherit' })

if (compile.status !== 0) process.exit(compile.status ?? 1)
await writeFile(join(output, 'package.json'), '{"type":"commonjs"}\n', 'utf8')
const test = spawnSync(process.execPath, ['tests/game-engine.cjs'], { cwd: root, stdio: 'inherit' })
await rm(output, { recursive: true, force: true })
process.exit(test.status ?? 1)
