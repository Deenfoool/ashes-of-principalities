import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('service worker never caches private API responses', async () => {
  const source = await readFile(`${root}/public/sw.js`, 'utf8')
  assert.match(source, /url\.pathname\.startsWith\('\/api\/'\)/)
  assert.match(source, /event\.respondWith\(fetch\(event\.request\)\)/)
  assert.match(source, /ashes-shell-v2/)
})
