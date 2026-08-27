---
name: graylog-diagnosis
description: 使用已配置的只读 `graylog43-query-mcp`，结合本地源码和稳定关联锚点排查 Graylog 应用日志。适用于定位接口异常、异步任务卡住、消息投递/消费、回调失败、跨节点调用和状态未落库问题，以及按 traceId、requestId、业务 ID、消息 ID、精确 logger、source 或 app_name 在正式与非正式 Stream 中检索日志。查询、Stream 选择、时间窗和脱敏输出均遵循 fail-closed 原则；不用于配置 Graylog 凭据、修改数据或全量导出日志。
---

# Graylog 排障（MCP）

此 Skill 负责**如何排查**；实际日志读取只能调用已配置的只读 `graylog43-query-mcp` MCP 工具。不得使用旧脚本、Graylog Web UI、`curl` 或任何写接口来查询或修改日志数据。

## 先决条件与边界

- 根据环境选择已配置的 MCP：正式环境使用 `graylog_prd`，测试/灰度等非正式环境使用 `graylog_tst`。以当前会话实际暴露的工具命名空间为准。
- 每次排查先调用目标 MCP 的 `get_system_info` 和 `list_allowed_streams`。仅从后者返回的 `stream_key` 中选择 Stream；没有匹配项、环境不明确或 MCP 不可达时停止并说明缺少的信息，**不得**回退到其他 profile、其他 Stream 或全量搜索。
- MCP 只返回 `timestamp`、`source`、`level`、`app_name`、`message`。不要假设可获取原始全部字段、聚合统计、已保存 Search 或任意 Stream ID。
- `gray` 与 `test` 若共用非正式 Stream，必须使用可验证的 `app_name`、`source` 或业务关联 ID 二次收窄；未能隔离时只报告范围内现象，不下环境归属结论。

## 排障流程

1. **从代码建立锚点。** 阅读真实入口、调用链、日志字面量、logger 类名、Topic、异常处理和状态持久化代码。优先使用 `traceId`、`requestId`、实例/消息/订单 ID、精确类名或 logger、精确 `source`/`app_name` 等稳定字段；不要仅用“超时”“失败”“卡住”等症状词，也不要以 `*`、`source:*` 或否定条件充当锚点。
2. **确定可复现的时间窗。** 最近问题使用 `search_stream` 的短相对窗口；已知事故时间使用 `search_stream_absolute`，传入带时区的 ISO 8601 `from`/`to`。先用 15–30 分钟窗口和较小 `limit`；仅在锚点充分具体时逐步扩大。分页、重试和多步检索必须复用同一绝对时间窗，避免“现在”不断移动。
3. **验证范围后检索。** 先确认 profile 连通且 Stream 在 allowlist 中，再在单一 Stream 上执行包含稳定锚点的查询。默认保持消息截断；只有已锁定单条记录且确有必要分析完整异常栈时，才设 `message_max_chars: 0`。
4. **沿链路补证据。** 以请求/派发 → 服务执行 → 消息投递与消费 → 回调 → 状态持久化的顺序追加查询。每次只改变一个维度（关联 ID、logger、source、app_name 或时间窗），并记录该次检索的 query、Stream、时间范围和结果数量。
5. **审慎解释。** 将结论分为“已证实”“未检索到”“推测/待验证”。代码中的潜在缺陷不是本次故障根因，除非有同一实例或同一关联链路的日志证据支持。

## MCP 调用模式

相对时间窗示例（最近 30 分钟）：

```text
<graylog_profile>.search_stream({
  stream_key: "<list_allowed_streams 返回的 key>",
  query: "traceId:abc123",
  range_seconds: 1800,
  limit: 50
})
```

绝对时间窗示例（历史事件；使用确切时间和时区）：

```text
<graylog_profile>.search_stream_absolute({
  stream_key: "<list_allowed_streams 返回的 key>",
  query: "message:\"orderId=27\" AND app_name:order-service",
  from: "2026-08-10T01:00:00.000Z",
  to: "2026-08-10T02:00:00.000Z",
  limit: 50
})
```

- 需要更多结果时，先收窄条件或缩小时间窗；只有在同一冻结窗口内才使用 `offset`，并遵守 MCP 上限。不要把宽泛查询的结果数当作业务成功/失败数量。
- MCP 已对 profile、Stream、查询长度、时间窗、数量、offset 施加限制。收到限制错误时应缩小范围或补充稳定锚点，而不是改用另一个 MCP 或规避限制。
- 使用 `query: "*"` 仅用于短时间、范围已被 Stream/环境严格限定的初步探查；随后必须尽快换成稳定锚点。

## 输出与数据保护

- 对外总结只保留排障所需片段。递归脱敏 Token、密码、Authorization、Cookie、手机号、身份证号及其他凭据/个人数据；不要复制完整请求体、Cookie、表单数据或密钥。
- 结果过多时提供脱敏摘要和下一步缩窄条件，不要提高 `limit` 或 `message_max_chars` 后倾倒日志。
- 最终输出应包含：环境/profile、Stream、精确时间窗、查询锚点、已证实链路、未检索到的证据、待验证项和建议的下一步。

## MCP 未就绪时

只说明需要由运维/项目所有者配置 `graylog43-query-mcp` 的对应 profile，并引导其使用 MCP 仓库中的 `codex-config.example.toml` 与 `.env.example`；不得在 Skill、对话记录或代码中索取、写入或显示 Token。

验证与集成边界见 [mcp-integration.md](references/mcp-integration.md)。
