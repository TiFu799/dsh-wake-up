# dsh-wake-up

把**休眠的会话**按需叫醒 —— 带模型路由、不重复、不调模型。

[English](#english) · 简体中文

---

## 它解决什么

DSH 关掉再开，之前打开过的会话不会自己活着。只有你在 GUI 里点开的那一间才会被实例化，
其余的都在磁盘上睡觉。于是任何「外部把消息投进某间会话」的集成 —— QQ 通道、定时任务、
webhook、别的插件 —— 都会撞上同一句话：

```
那间会话现在没活着（0e4e241e），先把它打开
```

这个插件把「叫醒」做成一个可复用的能力：会话休眠时，带着它上次用的模型路由把它
`resume` 回来，外部消息就能正常投递。

## 三个入口

### 1. 端点（给脚本用）

```sh
curl -X POST http://127.0.0.1:<GUI 端口>/dsh-wake-up/wake \
  -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:<GUI 端口>' \
  -d '{"会话":"session-0e4e241e-…"}'
# {"ok":true,"说":"已拉起 0e4e241e","路由":{"provider":"deepseek-account","model":"deepseek-flash","reasoningEffort":"max"}}
```

`GET /dsh-wake-up/state` 返回盘上的会话、哪些活着、哪些读到了路由，以及最近日志。

### 2. 工具（给模型用）

```text
wake_session({ session: "session-0e4e241e-…" })
```

模型在需要往一间没打开的会话投消息时自己调它。

### 3. 服务（给别的插件用）

```js
export const inject = ['wakeUp']

export function apply(ctx) {
  if (await ctx.wakeUp.resume(id)) { /* 现在可以把消息投进去了 */ }
  ctx.wakeUp.isAwake(id)   // 已经在活着吗
  ctx.wakeUp.route(id)     // 这间会话会带什么路由去唤醒
  ctx.wakeUp.state()       // 概况
}
```

## 安装

从 GitHub 装（现在就能用）：

```sh
dsh plugin add github:TiFu799/dsh-wake-up --profile desktop
```

收录进市场之后，也可以直接在市场里搜 `dsh-wake-up` 一键安装。
装完刷新页面即可，不需要重启。

## 配置（可选）

写进 profile 的 `cordis.patch.yml`：

```yaml
- id: wake-up
  name: dsh-wake-up
  config:
    开机唤醒:              # 插件加载 3 秒后先叫醒这几间，默认空
      - session-0e4e241e-…
    日志上限: 40           # 最近日志留多少条
```

## 两个必须知道的细节

1. **resume 必须带路由。** 不带 `agentOptions`（provider / model）时，恢复出来的 agent
   没有模型路由，提示词里 `deployment:persona-prefix` 的 `{{model}}` 就组装不出来，
   整轮直接报 `prompt variable "{{model}}" has no value for this assembly`。
   本插件从会话的 `modelSelection` 投影里读上次用的路由，读不到再退回 profile 的
   `agent-default-model`。

2. **resume 不调用模型。** 它只把会话历史读回内存 —— 空闲时 0 次模型请求，和你在 GUI
   里点开会话的开销一样。模型请求只发生在这一轮真的需要出字的时候。

## 兼容性

- DSH `>= 0.2.1-rc.2`（自带 `ctx.agents.resume` 的版本）。
- 无前端、无依赖、不写任何配置文件，只用 `agents` / `webServer` / `tools` 三个宿主服务。
- 在没有 `agents.resume` 的宿主上会安静地降级为「叫不醒」，不会报错崩掉。

## 许可

MIT。

---

<a id="english"></a>

## English

Wake dormant DSH sessions on demand — with the provider/model route they last used,
never twice for a session that is already live, and without spending a model request
by itself.

After DSH restarts, only sessions you opened in the GUI are live; the rest sit on disk.
Any integration that delivers a message into a session (chat bridges, schedulers,
webhooks, other plugins) hits `that session is not alive — open it first`. This plugin
resumes it instead.

- `POST /dsh-wake-up/wake` `{"会话" | "session": "session-<uuid>"}` → `{ok, 说, 路由}`
- `GET /dsh-wake-up/state` → on-disk sessions, which are live, which have a route
- Tool `wake_session({session})`
- Service `ctx.wakeUp` (`resume` / `isAwake` / `route` / `state`)
- Config: `开机唤醒` (wake these on load), `日志上限`

Resuming without `agentOptions` breaks the persona prefix (`{{model}}` has no value),
so the route is read from the session's `modelSelection` projection, falling back to the
profile's `agent-default-model`. Resuming reads history into memory only — no model call
unless that session then actually answers.

MIT licensed.
