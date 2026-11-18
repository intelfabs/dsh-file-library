import assert from 'node:assert/strict'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { cleanup, makeHome, writeObject, writeSession } from './helpers.mjs'

const CHILD = fileURLToPath(new URL('./smoke-child.mjs', import.meta.url))
const LIB = fileURLToPath(new URL('../lib/', import.meta.url))

test('host code runs with no PATH, no desktop environment and no native toolchain', async () => {
  const home = await makeHome()
  try {
    const workspace = join(home, 'workspace')
    await mkdir(workspace, { recursive: true })
    const object = await writeObject(home, Buffer.from('headless smoke test bytes'))
    await writeSession(home, {
      sessionId: '99999999-9999-4999-8999-999999999999',
      cwd: workspace,
      title: 'Headless',
      messages: [{ name: 'headless.bin', mime: 'application/octet-stream', bytes: object.bytes, sha: object.sha }],
    })
    const env = { ...process.env, PATH: '', DISPLAY: '', WAYLAND_DISPLAY: '', DSH_HOME: home }
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CHILD, home, workspace, '99999999-9999-4999-8999-999999999999'], {
        env,
        cwd: LIB,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('error', reject)
      child.once('close', code => resolve({ code, stdout, stderr }))
    })
    assert.equal(result.code, 0, result.stderr)
    const payload = JSON.parse(result.stdout.trim())
    assert.equal(payload.ok, true)
    assert.equal(payload.count, 1)
    assert.equal(payload.reference, '@library/headless.bin')
  } finally {
    await cleanup(home)
  }
})

test('the host half imports no desktop helper, native module or second listener', async () => {
  const files = await readdir(LIB)
  for (const file of files.filter(name => name.endsWith('.js'))) {
    const source = await readFile(join(LIB, file), 'utf8')
    assert.doesNotMatch(source, /from\s+'(node:)?child_process'/, `${file} must not spawn a process`)
    assert.doesNotMatch(source, /xdg-open|explorer\.exe|sips\b|imagemagick|\bspawnSync\('open'/i, `${file} must not call a desktop helper`)
    assert.doesNotMatch(source, /node-pty|sharp|ffi-napi|bindings/, `${file} must not require a native module`)
    assert.doesNotMatch(source, /\.listen\(/, `${file} must not open a listener; routes belong to the host`)
  }
})
