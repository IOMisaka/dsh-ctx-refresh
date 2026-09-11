# dsh-ctx-refresh · 模型上下文窗口一键刷新 + 自动同步

DSH Web **设置页 → Plugins** 新增一张卡片，并提供输入框下方的环境状态条：

- **手动刷新**（卡片按钮）：对每个**显式配置了模型列表**的 `llm-pi-ai`
  提供商路由，按三级策略解析每个模型的上下文窗口并写回设置。
- **自动同步**（默认开启，间隔可配，默认 30 分钟）：每条用户消息进入 agent
  inbox 时检查上次同步时间；超过间隔即在后台执行一次刷新，结果记录供客户端
  展示。同一间隔窗口内至多触发一次（成功失败都计数）。
- **状态条**：composer 下方 chip 显示「正在同步…」与最近一次结果摘要
  （更新 N 个 / 耗时），约 2 分钟后淡出；每 5s 轮询 `GET /ctx-refresh/state`。

## 上下文窗口解析（三级，先命中先用）

1. **OpenAI 兼容** — `GET {baseURL}/models`，取 `context_window` /
   `context_length` 字段；路由配置了 `apiKeyEnv` 时经 credentials 服务解析出
   Bearer 认证（密钥只在内存中使用一次）。
2. **LM Studio 原生** — `GET {root}/api/v0/models`，取 `loaded_context_length`
   （后端实际加载的运行时窗口；刻意不用 `max_context_length`——那是架构上限，
   num_ctx 可能更低）。
3. **Ollama 原生** — 逐模型 `GET {root}/api/show?name=<id>`，取
   `details.context_length`。

其中 `{root}` = baseURL 去掉 query/fragment、尾部斜杠与一个 `/v1`。第 2/3 级只
对前一级没报窗口的 id 发起请求，OpenAI 网关全量上报时整个路由恰好一次请求。

## 行为边界

- 只刷新**显式 models 列表里的模型**（你在设置里手动配过的）；目录型路由跳过并报告。
- 端点没报某个模型的窗口 → 该模型保持原值，计入 `noWindowModels`。
- 写入走 settings 路径级 mutate：整条 route 的 models 数组以「仅替换
  contextWindow」的副本写回，其余字段（密钥引用、请求头等）原样透传。
- 旧对话显示要等其下一次模型调用才用新窗口（会话日志语义）。

## HTTP 接口（宿主端）

- `POST /refresh-model-ctx` — 手动刷新；进行中返回「已在进行」提示。
- `GET /ctx-refresh/state` — `{ ok, syncing, autoSyncEnabled, intervalMinutes, lastAttemptMs, lastSuccessMs, lastResult }`，供客户端轮询。

## 设置项（namespace `dsh-ctx-refresh`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `autoSyncEnabled` | `true` | 是否随消息自动同步 |
| `autoSyncIntervalMinutes` | `30` | 最小同步间隔（分钟） |

运行时状态持久化在 `$DSH_HOME/dsh-ctx-refresh/state.json`（上次尝试/成功时间戳 +
紧凑结果摘要），重启不丢。

## 隐私与边界

- 只读取本机 DSH 设置里的路由配置；API 密钥经 credentials 服务解析后仅用于单次
  Bearer 请求头，**从不落盘、不进日志**。错误信息中的 URL 会剥离 query/fragment，
  避免把内嵌凭据写进 state.json / UI。
- `state.json` 只存路由 id、模型名与计数——不含密钥或完整响应体。
- DSH Web 仅监听回环地址；对提供商的出站请求只发 GET（无 body）。

## 安装 / 卸载

`dsh plugin` 是 pnpm 转发器（在 profile 目录执行 `pnpm <args>`），支持 registry
名、本地路径与 git 依赖：

```bash
# 从 GitHub 安装（推荐 tag 固定版本）：
dsh plugin --profile web add git+https://github.com/IOMisaka/dsh-ctx-refresh.git#v0.1.0
# 或简写：
dsh plugin --profile web add github:IOMisaka/dsh-ctx-refresh

# 本地开发（在插件 checkout 目录内执行）：
dsh plugin --profile web add .

# 卸载：
dsh plugin --profile web remove dsh-ctx-refresh
```

安装后重启 DSH Web，设置页 Plugins 区即可看到卡片。

## 依赖与要求

- 兼容当前 0.1.5-rc DSH 布局：沿用同一 settings API（`installSection` / `get` /
  `mutate`）、webServer exact routes、credentials resolve 与
  `agent/inbox/inserted` 事件；客户端 slot 契约（`settings.plugin.item` keyed card +
  hooks→`useXxx` props，`conversation.composer.dock`)与 `settingsScope` API 均未变。
- 宿主端在运行时解析 `@deepseek-ai/schemastery`：平台 monorepo 树内直接可用，
  否则从本包位置向上找 vendor 副本；两者都不可达时命名空间注册退化为保留默认值的
  identity validator（默认值仍经 entry base 生效，行为不变）。
- 客户端仅需 react seed + `@deepseek-ai/dsh-client-store`（冻结模块表基线）；旧的
  `dsh-client-runtime/client` supplier 已不在该表中。
- 要求部署存在 `llm-pi-ai` settings namespace；不存在时插件静默空转（不报错）。
