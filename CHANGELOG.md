# 更新记录

## 0.1.0

首个版本。把「按需叫醒休眠会话」从 QQ 通道里抽出来，做成独立插件。

- `ctx.wakeUp` 服务：`resume` / `isAwake` / `route` / `state`
- `POST /dsh-wake-up/wake`、`GET /dsh-wake-up/state`
- 工具 `wake_session`
- 唤醒时带 `agentOptions`（会话自己的模型路由，读不到退回 profile 默认）——
  否则提示词里的 `{{model}}` 组装不出来，整轮报
  `prompt variable "{{model}}" has no value for this assembly`
- 可选配置 `开机唤醒` / `日志上限`
- `test/smoke.mjs`：假 ctx 跑通服务、端点、工具、兜底路由、重复唤醒与失败路径
