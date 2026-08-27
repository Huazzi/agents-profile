# Graylog Views Search API

已验证的只读接口：

- `GET /api/views/search/{searchId}`：读取 Search 定义。
- `POST /api/views/search/{searchId}/execute`：执行已保存的 Search。

认证：

```text
Authorization: Basic base64(<api-token>:token)
X-Requested-By: codex-graylog-diagnosis
```

执行体：

```json
{
  "parameter_bindings": {}
}
```

`parameter_bindings` 只对 Search 定义中已经存在的参数有效。执行结果通常含有 `execution` 和 `results`；消息列表位于 `messages` Search Type 的结果中。

分页查询必须在第一次请求前把相对时间冻结为带时区的 absolute timerange，后续页面复用完全一致的 `from` 和 `to`：

```json
{
  "type": "absolute",
  "from": "2026-08-10T01:00:00.000Z",
  "to": "2026-08-10T02:00:00.000Z"
}
```

配置顶级键 `default` 和每个业务系统都只保存 `baseUrl` 与 `tokenEnv`。用户指定的业务系统没有配置时，完整回退到 `default`。业务 Stream 不写入配置，客户端以业务系统名称在运行时匹配对应 Stream。环境是运行时筛选条件，不写入业务名称；灰度与测试共用非正式 Stream 时，必须再按 `serverEnv`、Topic 或主机隔离。

本实例验证：`POST /api/views/search` 返回可执行资源，创建结果不会出现在 Search 列表；`DELETE /api/views/search/{id}` 返回 `405`，不能宣称已删除。提交 JSON 时传入 UTF-8 字节数组，避免中文查询词被服务端错误解码。客户端必须校验执行回显的 `query_string` 与请求条件一致。

所有响应都必须经过递归脱敏并受响应字节、终端输出字节和分页总量限制。调试模式的 raw response 不得绕过这些边界。

不要使用旧版 `/api/search/universal/relative` 作为默认接口：该实例已验证对 API Token 返回 `403`。
