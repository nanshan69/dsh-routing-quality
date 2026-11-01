# dsh-routing-quality

> 本仓库是 [yjh051108/dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) 中 `dsh-routing-quality` 插件 0.2.4 版的转载，按 MIT 协议保留原版权声明（见 LICENSE）。包名由 `@dsh-local/dsh-routing-quality` 改为 `dsh-routing-quality`，便于用链接直接安装；功能代码未改动。
>
> 安装：在 DSHM 设置 → 插件 → 安装插件 中输入 `github.com/nanshan69/dsh-routing-quality`，装完重启应用。若已装过 `@dsh-local/dsh-routing-quality`，请先停用旧版，避免重复加载。

这是 `dsh-routing-suite` 的端侧输出质量增强插件，借鉴 Router Standard 的渐进式工具披露原则，按风险和任务复杂度节流：

- 简单任务：不追加契约；质量工具从当前模型 schema 中隐藏。“操作系统是什么意思”“解释设计模式”等简短概念问答保持轻量。
- 中等任务：追加三行短契约，包含主路径、按任务类型选择的具体检查，以及实际检查结果与未验证项。
- 复杂任务：追加四行规格、范围、输出要求和检查提示；涉及实际操作时核对目标、作用范围及可恢复方式。Host 中常驻定义 `routing_quality_check`，但只有当前 Router admission 允许时才出现在模型 schema 中。
- 风险和明确输出格式优先于“快速、只要”等篇幅偏好。“快速修复生产环境鉴权漏洞”“请删除数据库”使用复杂契约；短任务明确要求 JSON 时至少使用中等契约，同样要求合法 JSON、给定 schema 和无 Markdown 围栏。单独提到 API 或修复 JSON 解析器不会把最终回答强制成 JSON。JSON 加独立字段解释按混合输出处理；明确只/仅输出 JSON 时保持严格格式，不额外添加说明或字段。
- “继续、测试一下、验证一下、run tests”等纯后续短指令继承当前任务、任务标识和已确认的 effort；从会话历史恢复时使用最近任务。含新任务内容的指令重新判定，切换到简单新任务时清除旧契约。`/effort:<value> 继续` 可在继承任务时明确更改 effort。
- 修复任务提示先复现、再运行针对性回归；开发任务提示运行最小示例或必要测试；JSON 任务提示核对解析、字段和类型；分析任务提示核对依据。未运行的检查不能写成通过。
- `routing_quality_check` 只做本地结构检查，返回 `evidenceVerified: false`；不读文件、不跑命令、不看截图、不发网络请求、不调用模型。
- effort 计划同时考虑用户显式覆盖、风险和复杂度。DSH 通用 model catalog 的标准等级是 `off / minimal / low / medium / high / xhigh / max`；内置 DeepSeek provider 当前只广告 `off / low / high / max`，插件会按已知能力向邻近等级 clamp。自动档位只作为建议；在需要调整且能力已知时，插件会先用 DSH 原生 `userQuestions.askTimed` 询问，提供“保持当前 effort”和可用档位，收到选择后才改请求；等待超时或没有带超时选择服务时保留宿主当前值；用户显式写出 `/effort:<value>` 时视为已经选择。选择回复按原生 `user-question-reply` 的 `callId` 与当前任务绑定，旧任务回复不会影响新任务。
- 状态端点是只读诊断接口，不返回用户原文、密钥或文件内容。
- 纯 JavaScript、无 `.node` 原生模块和外部依赖，适配 DSHM 端侧安装。

- provider/model 能力优先从 DSH `llm.resolveModelInfo` 返回的 exact model metadata 读取，其次使用 agent 已有 metadata 或内置 provider 规则；未知能力使用 `inherit`。能力读取不会发起模型生成请求。

插件挂接 `agent/inbox/claimed`、`system-prompt/assemble`、`agent/request` 和 `agent/pre-step`，并注入 DSH 原生 `userQuestions` 与 `llm` 服务。这些是当前模型回合的生命周期钩子；插件没有 `ctx.llm.stream`、HTTP 请求、新 agent 或自动重试。

## 安装本地成品

完整的 DSH plugin manager 支持绝对本地目录和 tarball；DSHM 端侧队列安装使用 npm 包名或 GitHub 地址（例如 `pnpm add github.com/nanshan69/dsh-routing-quality`），本地目录或 `.tgz` 请在 Host 插件管理页导入。安装成功后重启 DSHM，之后新会话会按风险和复杂度使用契约。

## 使用

复杂任务且当前 Router admission 已开放工具时，模型可按需调用本地结构检查器：

```js
routing_quality_check({
  format: 'json',
  output: '{"ok":false,"error":{"code":"upstream_timeout","message":"上游超时"}}'
})
```

返回结果会包含 `checks`、`statuses`、`evidenceVerified:false` 和摘要。它不会把结构检查伪装成真实运行验证。

状态接口为 `GET /dsh-routing-quality/status`，只返回插件版本、会话数量、任务类型计数、复杂度档位计数和能力列表。它不会自动请求，适合端侧 smoke test。

## 验证

```sh
node --test quality-plugin/test/*.test.mjs
```

回归测试覆盖契约触发、任务继承、格式约束、effort 选择与工具可见性；不会发起真实模型生成请求。这些测试验证插件行为，不代表已证明模型输出正确率提升。实际收益仍需同模型、同 effort 和同任务的开关对照评估。

## 与 Router Standard 配合

本插件不替换原有 `router-standard`。Router Standard 继续负责阶段化工具路由、工具披露和阶段推进；本插件只补充输出格式、事实边界、风险 effort 计划和 API/JSON 结构检查。简单任务不会因为本插件出现额外提示、模型回合或可见工具。
