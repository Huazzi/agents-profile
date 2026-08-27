# Agents Profile

这个仓库是 agent-facing 资产的可移植 source of truth，用来保证在切换 provider、切换设备或重装环境后，skills、plugins 和 MCP 的关键配置仍然可恢复、可审计、可同步。

远程仓库：

```text
https://github.com/Huazzi/agents-profile
```

## 目录结构

```text
.agents/
  skills/                         # 完整 skill 内容，直接纳入 Git 管理。
  .skill-lock.json                # skill 来源、路径、hash、checkMode 等 provenance/lock 信息。
  plugins/registry.json           # plugin 的可移植安装元数据。
  mcp/registry.json               # MCP server 的源码、构建、启动和注册元数据。
  mcp/env.example/                # 只放 env 示例文件；不要放真实 secrets。
  scripts/bootstrap.ps1           # Windows / PowerShell bootstrap。
  scripts/install-plugins.ps1
  scripts/install-mcp.ps1
  scripts/check-skills.ps1        # 只读 skill 上游/本地差异检查。
  scripts/update-skills.ps1       # 显式更新 skill 内容，并刷新 lock hash。
  scripts/bootstrap.sh            # macOS/Linux bash bootstrap。
  scripts/install-plugins.sh
  scripts/install-mcp.sh
  scripts/check-skills.sh         # macOS/Linux skill 检查入口。
  scripts/update-skills.sh        # macOS/Linux skill 更新入口。
  scripts/check-skills.js         # check-skills 共享实现。
  scripts/update-skills.js        # update-skills 共享实现。
```

## 设计原则

- `skills/` 保存完整内容，并直接提交到 Git。这样切换 provider 或设备时不依赖外部实时状态。
- `.skill-lock.json` 记录 skill 的来源、`sourceUrl`、`skillPath`、`checkMode` 和 hash，用于后续检查上游变化。
- Plugins 只登记元数据：名称、marketplace、Git repository、ref 和安装 selector。
- MCP servers 只登记元数据：名称、Git repository、ref、setup commands、launch command template 和 env 文件名。
- 运行时缓存和 provider 生成状态不纳入版本管理。例如 Codex 的运行状态应位于 `~/.codex/`。
- Secrets 不纳入版本管理。真实 MCP 凭据放在本地 `mcp/env/`，该目录已被 `.gitignore` 忽略。

## 当前已登记资产

### Plugins

- `feature-dev-codex@huazzi-plugins`
  - Repository: `https://github.com/Huazzi/feature-dev-codex.git`
  - Ref: `master`

### MCP servers

- `graylog_tst`
- `graylog_prd`

二者都使用：

```text
https://github.com/Huazzi/graylog43-query-mcp.git
```

ref 为 `main`，profiles 分别为 `tst` / `prd`。

## Windows bootstrap

1. 安装前置依赖：
   - Git
   - Node.js 20+
   - npm
   - Codex CLI
   - 推荐 PowerShell 7+；Windows PowerShell 在基础场景下通常也可用

2. 将本 profile clone 到用户 home 目录：

```powershell
git clone https://github.com/Huazzi/agents-profile.git $HOME\.agents
```

如果目录已经存在，可以在现有目录中初始化并连接 remote：

```powershell
cd $HOME\.agents
git init
git remote add origin https://github.com/Huazzi/agents-profile.git
git pull origin main
```

3. 创建本地 MCP env 文件：

```powershell
New-Item -ItemType Directory -Force -Path $HOME\.agents\mcp\env
Copy-Item $HOME\.agents\mcp\env.example\graylog43-query-mcp.env.example $HOME\.agents\mcp\env\graylog43-query-mcp.env
notepad $HOME\.agents\mcp\env\graylog43-query-mcp.env
```

不要提交 `mcp/env/` 下的文件。

4. 运行 bootstrap：

```powershell
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\bootstrap.ps1
```

常用变体：

```powershell
# 只安装/注册 plugins
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\bootstrap.ps1 -SkipMcp

# 只 clone/build/register MCP servers
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\bootstrap.ps1 -SkipPlugins

# 下载/注册 MCP，但跳过 npm install/build
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\bootstrap.ps1 -SkipMcpSetup

# 只准备 metadata/sources，不向 provider 注册
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\bootstrap.ps1 -NoInstallPlugins -NoRegisterMcp
```

## macOS bootstrap

1. 安装前置依赖：

```bash
# 如果使用 Homebrew:
brew install git node
npm install -g @openai/codex
```

如果你通过其他方式安装 `codex`，请确认它在 `PATH` 上：

```bash
codex --version
```

2. 将本 profile clone 到 macOS home 目录：

```bash
git clone https://github.com/Huazzi/agents-profile.git ~/.agents
```

如果 `~/.agents` 已存在：

```bash
cd ~/.agents
git init
git remote add origin https://github.com/Huazzi/agents-profile.git 2>/dev/null || true
git pull origin main
```

3. 创建本地 MCP env 文件：

```bash
mkdir -p ~/.agents/mcp/env
cp ~/.agents/mcp/env.example/graylog43-query-mcp.env.example ~/.agents/mcp/env/graylog43-query-mcp.env
${EDITOR:-vi} ~/.agents/mcp/env/graylog43-query-mcp.env
```

不要提交 `mcp/env/` 下的文件。

4. 使用 bash 脚本运行 bootstrap：

```bash
bash ~/.agents/scripts/bootstrap.sh
```

常用变体：

```bash
# 只安装/注册 plugins
bash ~/.agents/scripts/bootstrap.sh --skip-mcp

# 只 clone/build/register MCP servers
bash ~/.agents/scripts/bootstrap.sh --skip-plugins

# 下载/注册 MCP，但跳过 npm install/build
bash ~/.agents/scripts/bootstrap.sh --skip-mcp-setup

# 只准备 metadata/sources，不向 provider 注册
bash ~/.agents/scripts/bootstrap.sh --no-install-plugins --no-register-mcp
```

可选：如果 Git checkout 保留 executable bit，或你愿意在本地设置：

```bash
chmod +x ~/.agents/scripts/*.sh
~/.agents/scripts/bootstrap.sh
```

## 检查 skill 更新

`skills/` 作为完整内容纳入版本管理；`.skill-lock.json` 记录许多外部来源 skill 的 provenance。刷新外部 skill 之前，建议先运行检查脚本。

Windows：

```powershell
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\check-skills.ps1

# 只检查 GitHub 来源 skills
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\check-skills.ps1 -SourceType github

# 只检查一个 skill，不访问网络，只使用已有缓存
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\check-skills.ps1 -Skill code-review -NoFetch

# 输出机器可读 JSON
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\check-skills.ps1 -Json
```

macOS/Linux：

```bash
bash ~/.agents/scripts/check-skills.sh

# 只检查 GitHub 来源 skills
bash ~/.agents/scripts/check-skills.sh --source-type github

# 只检查一个 skill，不访问网络，只使用已有缓存
bash ~/.agents/scripts/check-skills.sh --skill code-review --no-fetch

# 输出机器可读 JSON
bash ~/.agents/scripts/check-skills.sh --json
```

`check-skills` 默认不会更新或覆盖 `skills/`，只报告差异：

- GitHub `skill-folder` 模式：比较本地 skill 目录 hash 和 `.cache/skill-sources/` 中缓存的 upstream skill 目录 hash。
- GitHub `source-file` 模式：比较一个 upstream 源文件和 `.skill-lock.json` 中记录的本地源文件。
- GitHub `metadata-only` 模式：只记录来源并检查远程 HEAD，不 clone 内容，也不做内容比较。
- `well-known` 来源：只检查远程 `SKILL.md`；本地 `references/` 和其他 assets 暂不验证。
- `untracked-local`：表示 `skills/` 下存在目录，但 `.skill-lock.json` 没有登记。
- `up-to-date`：表示本地内容按当前 `checkMode` 已与 upstream 对齐；报告中不会再细分 `source-file-up-to-date` 或 `up-to-date-skill-md`。

## 显式更新 skill

第二阶段的更新逻辑使用独立脚本：`update-skills`。它和 `check-skills` 分开，避免“检查”动作意外改写本地 `skills/`。

建议工作流：先 `check-skills` 看差异，再用 `update-skills` 明确更新，最后用 `git diff` 审查变更。

Windows：

```powershell
# 预览全部可更新 skills，不写文件
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\update-skills.ps1 -DryRun

# 更新全部可更新 skills
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\update-skills.ps1 -All

# 只更新指定 skill；-Skill 支持数组，也支持逗号分隔
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\update-skills.ps1 -Skill code-review
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\update-skills.ps1 -Skill code-review,karpathy-guidelines

# 只更新 GitHub 来源 skills
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\update-skills.ps1 -SourceType github -All
```

macOS/Linux：

```bash
# 预览全部可更新 skills，不写文件
bash ~/.agents/scripts/update-skills.sh --dry-run

# 更新全部可更新 skills
bash ~/.agents/scripts/update-skills.sh --all

# 只更新指定 skill；--skill 可重复，也支持逗号分隔
bash ~/.agents/scripts/update-skills.sh --skill code-review
bash ~/.agents/scripts/update-skills.sh --skill code-review,karpathy-guidelines

# 只更新 GitHub 来源 skills
bash ~/.agents/scripts/update-skills.sh --source-type github --all
```

更新规则：

- GitHub `skill-folder`：用 upstream skill 目录替换本地 `skills/<name>/`，然后刷新 `.skill-lock.json` 中的 `skillFolderHash` 和 `updatedAt`。
- GitHub `source-file`：只更新 lock 中登记的 `localSourcePath`，并刷新 `localSourceHash` / `skillFolderHash`。不会自动改写本地 `SKILL.md`，因为这类 skill 通常需要人工适配。
- GitHub `metadata-only`：跳过。它只登记 repository 信息，没有可安全同步的内容路径。
- `well-known`：只更新本地 `SKILL.md`，暂不处理 `references/` 或其他 assets。

更新后请审查并提交：

```bash
git status --short
git diff -- skills .skill-lock.json
```

### 补充登记本地 skill 来源

如果某个本地 skill 显示为 `untracked-local`，可以补充 provenance。

Windows：

```powershell
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\check-skills.ps1 -Register "my-skill=https://github.com/owner/repo/blob/main/skills/my-skill/SKILL.md"

# 对所有 .skill-lock.json 中缺失的本地 skills 逐个提示输入来源 URL
pwsh -ExecutionPolicy Bypass -File $HOME\.agents\scripts\check-skills.ps1 -RegisterMissing
```

macOS/Linux：

```bash
bash ~/.agents/scripts/check-skills.sh --register "my-skill=https://github.com/owner/repo/blob/main/skills/my-skill/SKILL.md"

# 对所有 .skill-lock.json 中缺失的本地 skills 逐个提示输入来源 URL
bash ~/.agents/scripts/check-skills.sh --register-missing
```

登记模式只会编辑 `.skill-lock.json`，不会下载、更新或覆盖 `skills/` 下的文件。

URL 到 `checkMode` 的自动判断规则：

- GitHub `blob/.../SKILL.md` 和 `tree/.../<skill-dir>`：登记为 `skill-folder`。
- GitHub `blob/.../<other-file>.md`：登记为 `source-file`。
- 纯 repository URL：登记为 `metadata-only`；如需内容比较，可后续手动补充 `skillPath`。

推荐工作流：

```bash
bash ~/.agents/scripts/check-skills.sh
# 查看报告
# 如需手动更新某个 skill，更新后先用 git diff 审查，再提交
```

## 跨平台路径约定

Registries 中应使用 placeholders，避免硬编码机器路径：

```text
${AGENTS_HOME}
${HOME}
${USERPROFILE}
```

Registry path 推荐使用 forward slashes，例如：

```json
"${AGENTS_HOME}/mcp-sources/graylog43-query-mcp/dist/index.js"
```

安装脚本会在 Windows 和 macOS 上展开这些 placeholders。

## 脚本工作方式

### Plugins

`plugins/registry.json` 当前将 `feature-dev-codex` 记录为 `codex-marketplace-repo`。安装脚本会运行等价于以下命令的操作：

```powershell
codex plugin marketplace add https://github.com/Huazzi/feature-dev-codex.git --ref master
codex plugin add feature-dev-codex@huazzi-plugins
```

`codex plugin add` 会把已安装 plugin 状态写入当前 Codex home/config 和 cache，不会反向写入本仓库的 registry。

### MCP

`mcp/registry.json` 记录 `graylog_tst` 和 `graylog_prd`。安装脚本会把 MCP repo clone 或更新到：

```text
~/.agents/mcp-sources/graylog43-query-mcp
```

然后运行：

```bash
npm install
npm run build
```

最后用 `codex mcp remove` + `codex mcp add` 重新创建 Codex MCP registrations。

## Git hygiene / 提交前检查

推荐的首次提交流程：

```bash
cd ~/.agents
git init
git remote add origin https://github.com/Huazzi/agents-profile.git
git add skills plugins mcp scripts .gitignore README.md .skill-lock.json
git commit -m "Initialize portable agents profile"
git branch -M main
git push -u origin main
```

提交前，请仔细检查 staged files，确认没有 secrets：

```bash
git status --short
git diff --cached --stat
git diff --cached
```

