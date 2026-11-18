import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

test('the host entry registers one prefix route and both agent tools', async () => {
  const routes = []
  const tools = []
  const disposers = []
  const ctx = {
    inject: (_dependencies, callback) => callback(ctx),
    effect: fn => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    webServer: {
      register: route => {
        routes.push(route)
        return () => undefined
      },
    },
    tools: {
      register: definition => {
        tools.push(definition)
        return () => undefined
      },
    },
  }
  apply(ctx, { home: process.cwd(), cacheDir: `${process.cwd()}/.dsh-test/cache` })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/plugins/dsh-file-library')
  assert.equal(typeof routes[0].handler, 'function')
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['library_list', 'library_read', 'library_use'])
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.output.schema.type, 'json')
  }
  for (const dispose of disposers) dispose()
})
