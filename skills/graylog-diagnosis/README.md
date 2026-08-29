# Graylog 排障（MCP）

`graylog-diagnosis` 是一个轻量诊断 Skill：它负责从源码建立稳定检索锚点、选择严格的时间窗和 Stream、组织证据链，并将**所有实际日志查询**交给 `graylog43-query-mcp` 的只读 MCP 工具。

## 运行前提

在当前 Agent 会话中注册两个 profile：

- `graylog_tst`：测试/灰度等非正式环境；
- `graylog_prd`：正式环境。

MCP 的启动配置、环境变量名称和安全要求以 `graylog43-query-mcp/codex-config.example.toml`、`graylog43-query-mcp/.env.example` 为准。Token 只保存在受控环境变量或 `.env`，绝不写入 Skill、仓库文档、查询参数或结论。

## 行为约定

1. 每次排查先验证系统可达并列出允许的 Stream。
2. 仅查询目标 profile 的 allowlist Stream；候选不唯一、缺失或环境无法区分时停止，不跨 profile 回退。
3. 以 traceId、requestId、业务/消息 ID、精确 logger、source 或 app_name 等稳定锚点配合窄时间窗搜索。
4. 每次检索输出都脱敏；过大结果要缩窄条件，不能用无限制导出替代排查。
5. 报告只将证据支持的现象描述为已证实，并明确未检索到和待验证部分。

Skill 的完整流程在 `SKILL.md`；MCP 工具映射与回归检查在 `references/mcp-integration.md`。
