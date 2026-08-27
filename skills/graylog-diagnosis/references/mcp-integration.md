# graylog43-query-mcp 集成说明

## 工具映射

| 诊断阶段 | MCP 工具 | 使用规则 |
|---|---|---|
| 连接预检 | `get_system_info` | 每次排查的第一步；失败即停止。 |
| 范围确认 | `list_allowed_streams` | 仅使用本次返回的逻辑 `stream_key`；不传递 Graylog Stream ID。 |
| 最近故障 | `search_stream` | 使用稳定锚点和短相对时间窗。 |
| 历史事故/分页 | `search_stream_absolute` | 使用冻结的 ISO 8601 `from`/`to`，所有后续页面复用该窗口。 |

`graylog_prd` 只能接受正式 Stream，`graylog_tst` 只能接受非正式 Stream。服务端拒绝跨 profile 的 Stream，因此 Skill 不得尝试跨环境回退。

## 回归检查清单

每次修改 Skill 或 MCP 契约时，确认：

1. **稳定锚点**：症状词、通配符和纯否定条件不能成为首次查询依据；traceId、业务 ID、精确 logger/source/app_name 可以。
2. **时间窗**：默认从短窗口开始；历史查询采用绝对时间；继续检索时不漂移窗口。
3. **Stream fail-closed**：只从 `list_allowed_streams` 的结果选择 key；未配置或不匹配时不查询其他 profile/Stream。
4. **最小化输出**：小 `limit`、默认消息截断；只在锁定单条异常栈时请求完整消息。
5. **脱敏报告**：不回显凭据、Cookie、完整请求体或无关个人数据；区分已证实、未检索到和推测。

MCP 自身的查询边界和工具测试位于 `graylog43-query-mcp/src/policy.ts` 与 `graylog43-query-mcp/test/`；本 Skill 不复制或绕过那些限制。
