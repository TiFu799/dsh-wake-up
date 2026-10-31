// dsh-wake-up · 按需叫醒休眠的会话
//
// 为什么需要它：DSH 关掉再开，之前打开过的会话不会自己活着 —— 只有你在 GUI 里点开的
// 那一间才会被实例化。任何「外部把消息投进某间会话」的集成（QQ 通道、定时任务、webhook、
// 别的插件）在会话休眠时都会撞上 `那间会话现在没活着，先把它打开`。
//
// 这个插件把「叫醒」做成一个可复用的小能力：
//   1. 服务 ctx.wakeUp.resume(sessionId)：带模型路由地把会话从磁盘 resume 回来
//   2. 端点 POST /dsh-wake-up/wake：给脚本用
//   3. 工具 wake_session：让模型自己调
//
// 关键细节：resume 必须带上 agentOptions（provider / model）。不带的话恢复出来的 agent
// 没有模型路由，提示词里 `deployment:persona-prefix` 的 {{model}} 就组装不出来，整轮直接
// 报 `prompt variable "{{model}}" has no value for this assembly`。路由从会话的
// modelSelection 投影里读，读不到再退回 profile 的 agent-default-model。
//
// resume 本身不调用模型 —— 模型请求只发生在这一轮真的需要出字的时候。

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'wake-up'

/** 需要宿主提供：agents（resume / get）+ webServer（端点）+ tools（工具）。 */
export const inject = ['agents', 'webServer', 'tools']

const 版本 = '0.1.0'
const 目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 路由前缀 = '/dsh-wake-up'

const 默认配置 = {
  开机唤醒: [], // 插件加载时先叫醒这几间（session-… 或纯 uuid），默认不做
  日志上限: 40,
}

export function apply(ctx, config) {
  const 配置 = { ...默认配置, ...(config && typeof config === 'object' ? config : {}) }
  const 日志 = []

  const 记账 = (文) => {
    const 条 = { 时间: new Date().toISOString().slice(11, 19), 文本: String(文) }
    日志.push(条)
    const 上限 = Number(配置.日志上限) > 0 ? Number(配置.日志上限) : 40
    while (日志.length > 上限) 日志.shift()
  }

  const 短id = (id) => {
    const s = String(id)
    return s.length <= 8 ? s : s.slice(-8)
  }

  /** 带 / 不带 `session-` 前缀两个方向都试。 */
  const 候选id = (id) => {
    const 原 = String(id == null ? '' : id).trim()
    if (原 === '') return []
    return 原.startsWith('session-') ? [原, 原.slice('session-'.length)] : [原, 'session-' + 原]
  }

  const 找agent = (id) => {
    for (const 一个 of 候选id(id)) {
      try {
        const a = ctx.agents.get(一个)
        if (a !== undefined) return a
      } catch (error) {
        /* 试下一个形状 */
      }
    }
    return undefined
  }

  /** 从投影缓存的一行里抽出 {provider, model, reasoningEffort?}。 */
  const 取路由 = (块) => {
    const 值 = 块 && (块.lastUsed !== undefined ? 块 : 块.val)
    const 末 = 值 && 值.lastUsed
    if (!末 || typeof 末.provider !== 'string' || typeof 末.model !== 'string') return null
    if (!末.provider || !末.model) return null
    const 路由 = { provider: 末.provider, model: 末.model }
    if (typeof 末.reasoningEffort === 'string' && 末.reasoningEffort !== '') 路由.reasoningEffort = 末.reasoningEffort
    return 路由
  }

  /** 这间会话上次用的模型路由。先问投影缓存服务，再退到磁盘上的投影文件。 */
  const 会话模型 = (id) => {
    const 候选 = 候选id(id)
    if (候选.length === 0) return null
    try {
      const 缓存 = ctx.get('sessionProjectionCache')
      for (const 一个 of 候选) {
        const 快照 = 缓存 && typeof 缓存.cachedSnapshot === 'function' ? 缓存.cachedSnapshot({ id: 一个 }) : undefined
        const 路由 = 取路由(快照 && 快照.values && 快照.values.modelSelection)
        if (路由) return 路由
      }
    } catch (error) {
      /* 服务不可用就退到文件，不打扰用户 */
    }
    try {
      for (const 一个 of 候选) {
        const 文件 = join(目录, 'storages', 'session_projcache', 'sessions', 一个 + '.json')
        if (!existsSync(文件)) continue
        const 记录 = JSON.parse(readFileSync(文件, 'utf8'))
        const 行 = 记录 && 记录.record && 记录.record.rows && 记录.record.rows.modelSelection
        const 路由 = 取路由(行)
        if (路由) return 路由
      }
    } catch (error) {
      /* 文件坏了就当没有 */
    }
    return null
  }

  /** 兜底：会话从来没跑过时用 profile 里 agent-default-model 的默认路由（只扫那一小段 YAML）。 */
  const 默认模型 = () => {
    try {
      const 根 = join(目录, 'profiles')
      if (!existsSync(根)) return null
      for (const 子 of readdirSync(根)) {
        const 文件 = join(根, 子, 'cordis.patch.yml')
        if (!existsSync(文件)) continue
        const 文 = readFileSync(文件, 'utf8')
        const 段 = 文.split(/(?:^|\n)-\s+id:\s*/).find((块) => 块.startsWith('agent-default-model'))
        if (!段) continue
        const 抽 = (键) => {
          const 命中 = 段.match(new RegExp('^\\s*' + 键 + ':\\s*(\\S+)\\s*$', 'm'))
          return 命中 ? 命中[1].replace(/^["']|["']$/g, '') : ''
        }
        const provider = 抽('provider')
        const model = 抽('model')
        if (provider && model) {
          const 路由 = { provider, model }
          const 努力 = 抽('reasoningEffort')
          if (努力) 路由.reasoningEffort = 努力
          return 路由
        }
      }
    } catch (error) {
      /* 读不到就算了 */
    }
    return null
  }

  /** 唤醒时要带的路由：会话自己的优先，没有就用 profile 默认。 */
  const 唤醒路由 = (id) => 会话模型(id) || 默认模型()

  /**
   * 把一间休眠的会话 resume 回来，成功返回 true。
   * 已经在活着的时候直接返回 true（不重复 resume）。
   */
  const 叫醒会话 = async (id) => {
    const 原 = String(id == null ? '' : id).trim()
    if (原 === '') return false
    if (!ctx.agents || typeof ctx.agents.resume !== 'function') {
      记账('宿主没有 agents.resume，跳过')
      return false
    }
    if (找agent(原) !== undefined) return true
    const 路由 = 唤醒路由(原)
    for (const 一个 of 候选id(原)) {
      try {
        await ctx.agents.resume({ resumeSessionId: 一个, ...(路由 ? { agentOptions: 路由 } : {}) })
        if (ctx.agents.get(一个) !== undefined) {
          记账('已拉起 ' + 短id(一个) + (路由 ? '（' + 路由.provider + '/' + 路由.model + '）' : '（没读到模型路由）'))
          return true
        }
      } catch (error) {
        记账('叫不醒 ' + 短id(一个) + '：' + String((error && error.message) || error))
      }
    }
    return false
  }

  const 会话清单 = () => {
    const 出 = []
    try {
      const 会话目录 = join(目录, 'storages', 'session_projcache', 'sessions')
      if (!existsSync(会话目录)) return 出
      for (const 名 of readdirSync(会话目录)) {
        if (!名.endsWith('.json')) continue
        const id = 名.slice(0, -5)
        出.push({ 会话: id, 活着: 找agent(id) !== undefined, 有路由: 会话模型(id) !== null })
      }
    } catch (error) {
      /* 目录不在就当没有 */
    }
    return 出
  }

  const 概况 = () => ({
    插件: 'dsh-wake-up',
    版本,
    活着的会话: ctx.agents && typeof ctx.agents.list === 'function' ? 安全列表() : undefined,
    盘上会话: 会话清单(),
    最近日志: 日志.slice(-20),
  })

  const 安全列表 = () => {
    try {
      const 全 = ctx.agents.list()
      if (!Array.isArray(全)) return undefined
      return 全.map((a) => (a && (a.sessionId || a.id)) || String(a)).filter(Boolean)
    } catch (error) {
      return undefined
    }
  }

  // ---------- 服务：给别的插件用 ----------
  ctx.effect(
    () =>
      ctx.provide('wakeUp', {
        版本,
        resume: 叫醒会话,
        isAwake: (id) => 找agent(id) !== undefined,
        route: 唤醒路由,
        state: 概况,
      }),
    'wake-up: 服务 ctx.wakeUp',
  )

  // ---------- 端点 ----------
  const 回 = (res, o) => {
    try {
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.end?.(JSON.stringify(o))
    } catch (error) {}
  }

  const 读体 = async (req) => {
    let body = ''
    try {
      for await (const chunk of req) body += chunk
    } catch (error) {}
    try {
      return JSON.parse(body || '{}')
    } catch (error) {
      return {}
    }
  }

  const 路线 = (路径, handler) =>
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: 路径,
          handler: async (req, res) => {
            try {
              await handler(req, res)
            } catch (error) {
              回(res, { ok: false, 说: String((error && error.message) || error) })
            }
          },
        }),
      'wake-up: ' + 路径,
    )

  路线(`${路由前缀}/wake`, async (req, res) => {
    const 体 = await 读体(req)
    const 这间 = String((体 && (体.会话 || 体.session)) || '').trim()
    if (!这间) return 回(res, { ok: false, 说: '给个会话 id（session-… 或纯 uuid 都行）' })
    const 醒 = await 叫醒会话(这间)
    return 回(res, { ok: 醒, 说: (醒 ? '已拉起 ' : '叫不醒 ') + 短id(这间), 路由: 唤醒路由(这间) || null })
  })

  路线(`${路由前缀}/state`, async (_req, res) => {
    return 回(res, { ok: true, ...概况() })
  })

  // ---------- 工具：让模型自己叫醒 ----------
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'wake_session',
        description:
          'Wake a dormant DSH session by resuming it from disk, with the provider/model route it last used. Use when an external integration (a chat bridge, a scheduler, another plugin) needs to deliver a message into a session that is not currently live and ctx reports that the session is not alive. Resuming does not call the model by itself — a model request only happens when that session then has a turn to answer.',
        parameters: {
          type: 'object',
          properties: {
            session: {
              type: 'string',
              description: 'Session id: `session-<uuid>` or the bare uuid.',
            },
          },
          required: ['session'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              route: {
                type: ['object', 'null'],
                properties: {
                  provider: { type: 'string' },
                  model: { type: 'string' },
                  reasoningEffort: { type: 'string' },
                },
              },
            },
            required: ['ok', 'message'],
          },
          render: (_args, value) => [{ type: 'text', text: String(value && value.message ? value.message : '') }],
        },
        isConcurrencySafe: () => true,
        async execute(args) {
          const 这间 = String((args && args.session) || '').trim()
          if (!这间) return { ok: false, message: 'wake_session needs a session id.' }
          const 醒 = await 叫醒会话(这间)
          const 路由 = 唤醒路由(这间) || null
          return {
            ok: 醒,
            message: 醒
              ? `已拉起会话 ${短id(这间)}${路由 ? '（' + 路由.provider + '/' + 路由.model + '）' : '（没读到模型路由）'}`
              : `叫不醒会话 ${短id(这间)}：宿主没有 agents.resume，或这个 id 不存在`,
            route: 路由,
          }
        },
      }),
    'wake-up: 工具 wake_session',
  )

  // ---------- 开机唤醒（可选） ----------
  const 开机 = Array.isArray(配置.开机唤醒) ? 配置.开机唤醒.filter((x) => typeof x === 'string' && x.trim() !== '') : []
  if (开机.length > 0) {
    ctx.effect(() => {
      const 表 = setTimeout(() => {
        for (const 一间 of 开机) 叫醒会话(一间).catch(() => {})
      }, 3000)
      if (表 && typeof 表.unref === 'function') 表.unref()
      return () => clearTimeout(表)
    }, 'wake-up: 开机唤醒')
  }

  记账(`已装好 v${版本}：POST ${路由前缀}/wake · 工具 wake_session${开机.length ? ' · 开机唤醒 ' + 开机.length + ' 间' : ''}`)

  return { 叫醒会话, 概况, 会话模型, 默认模型, 日志 }
}
