// 冒烟测试：用假的 ctx 跑一遍 apply()，确认服务 / 端点 / 工具三条路都通。
// 不需要真的装进 DSH：宿主那几个方法（agents.get / resume / webServer.register / tools.register）
// 用最小的假实现顶住就行。跑法：node test/smoke.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert'

// 假的 DSH_HOME：只放一个 profile，里面有 agent-default-model，用来验证「默认路由」这条兜底
const home = mkdtempSync(join(tmpdir(), 'wake-up-home-'))
mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
writeFileSync(
  join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
  ['- id: agent-default-model', '  provider: test-provider', '  model: test-model', '  reasoningEffort: high'].join('\n') + '\n',
)
process.env.DSH_HOME = home

const { apply, name, inject } = await import('../lib/index.js')
assert.equal(name, 'wake-up')
assert.deepEqual(inject, ['agents', 'webServer', 'tools'])

const handlers = new Map()
const tools = []
const provided = {}
const live = new Map()
const resumeCalls = []

const ctx = {
  agents: {
    get: (id) => live.get(id),
    resume: async (opts) => {
      resumeCalls.push(opts)
      live.set(opts.resumeSessionId, { sessionId: opts.resumeSessionId })
    },
    list: () => [...live.values()],
  },
  webServer: {
    register: ({ path, handler }) => {
      handlers.set(path, handler)
      return () => handlers.delete(path)
    },
  },
  tools: {
    register: (tool) => {
      tools.push(tool)
      return () => {}
    },
  },
  effect: (fn) => fn(),
  get: () => undefined,
  provide: (n, v) => {
    provided[n] = v
    return () => {}
  },
}

apply(ctx, { 开机唤醒: [] })

// 1) 服务挂上了
assert.ok(provided.wakeUp, 'ctx.provide("wakeUp") 没调用')
assert.equal(typeof provided.wakeUp.resume, 'function')

// 2) 端点挂上了
assert.ok(handlers.has('/dsh-wake-up/wake'), '缺 /dsh-wake-up/wake')
assert.ok(handlers.has('/dsh-wake-up/state'), '缺 /dsh-wake-up/state')

const call = async (path, body) => {
  const res = { headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(s) { this.body = s } }
  const req = (async function* () {
    yield JSON.stringify(body || {})
  })()
  await handlers.get(path)(req, res)
  return JSON.parse(res.body)
}

// 3) 叫醒一间没活着的会话：应带上兜底路由
const r1 = await call('/dsh-wake-up/wake', { 会话: 'session-11111111-2222-3333-4444-555555555555' })
assert.equal(r1.ok, true, '唤醒失败了：' + JSON.stringify(r1))
assert.deepEqual(r1.路由, { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' })
assert.equal(resumeCalls.length, 1)
assert.equal(resumeCalls[0].resumeSessionId, 'session-11111111-2222-3333-4444-555555555555')
assert.deepEqual(resumeCalls[0].agentOptions, { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' })

// 4) 已经活着的会话不再重复 resume
const r2 = await call('/dsh-wake-up/wake', { session: '11111111-2222-3333-4444-555555555555' })
assert.equal(r2.ok, true)
assert.equal(resumeCalls.length, 1, '活着的会话不该再 resume 一次')

// 5) 空 id 被拒
const r3 = await call('/dsh-wake-up/wake', {})
assert.equal(r3.ok, false)

// 6) 工具
const tool = tools.find((t) => t.name === 'wake_session')
assert.ok(tool, '缺工具 wake_session')
assert.equal(tool.parameters.required[0], 'session')
const t1 = await tool.execute({ session: 'session-99999999-8888-7777-6666-555555555555' })
assert.equal(t1.ok, true)
assert.match(t1.message, /已拉起/)
assert.deepEqual(t1.route, { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' })
const t2 = await tool.execute({})
assert.equal(t2.ok, false)

// 7) state
const s = await call('/dsh-wake-up/state')
assert.equal(s.ok, true)
assert.equal(s.插件, 'dsh-wake-up')

// 8) 叫不醒时如实返回 false（resume 抛错）
ctx.agents.resume = async () => {
  throw new Error('boom')
}
const b = await provided.wakeUp.resume('session-deadbeef-0000-0000-0000-000000000000')
assert.equal(b, false)

console.log('✓ smoke ok：服务 / 端点 / 工具 / 兜底路由 / 重复唤醒 / 失败路径 全部符合预期')
