# GitLab 周报流水线

自动获取 GitLab 提交，执行作者、日期、项目映射及字典校验，并从同一份数据快照生成 Excel 与 HTML 周报。

## 环境要求

- Node.js 14.21 或更高版本
- 可访问目标 GitLab
- 具有 Events、项目和 Repository 读取权限的 Private Token

## 初始化

```bash
cd /Users/chen.xi/work/weekly-report
npm install
cp config/report.config.example.json config/report.config.json
cp .env.example .env
```

编辑 `.env`：

```dotenv
GITLAB_TOKEN=你的真实令牌
```

编辑 `config/report.config.json`，至少填写：

- `gitlab.baseUrl`：GitLab 根地址，不带 `/api/v4`。
- `gitlab.userId`：查询自己的周报时推荐填写 `me`，程序会调用已认证用户接口 `/events`；仅在查询其他用户时填写其 GitLab 用户 ID 或准确用户名。
- `authors`：允许写入周报的 Git 作者名或邮箱。
- `jira.baseUrl`：JIRA 浏览地址前缀；提交标题中的 JIRA 编号会自动提取并生成链接。
- `filters.excludeMergeCommits`：默认为 `true`，过滤 Merge Commit；记录仍保留在标准化数据的拒绝清单中。
- `statusColorMap`、`typeColorMap`：控制审核视图和钉钉视图中的状态、问题类型颜色；未配置的值使用默认深灰色。
- `projects`：以 GitLab 项目 ID 为键的项目与业务线映射。
- `groupOrder`：HTML 和 Excel 中业务线的显示顺序。
- 人工维护文件固定使用当前周期 `output/<周期>/周报.xlsx`，不会读取根目录的 `周报.xlsx`。

不要提交 `.env` 和 `config/report.config.json`，这两个文件已加入 `.gitignore`。

## 使用

```bash
# 获取最新数据并生成待审核 Excel；确认后再生成 HTML
npm run generate

# 指定目标周内的任意一天
node cli.js generate --week 2026-07-13

# 复用上一次获取的 Git 数据，适合修改映射后快速重跑
node cli.js generate --week 2026-07-13 --from-cache

# 分阶段执行：先生成 Excel，人工维护后再继续
node cli.js fetch --week 2026-07-13
node cli.js validate --week 2026-07-13
node cli.js prepare --week 2026-07-13 --from-cache
node cli.js continue --week 2026-07-13

# 非交互环境中直接继续生成 HTML
node cli.js generate --week 2026-07-13 --yes

# 只生成 Excel，稍后再继续
node cli.js generate --week 2026-07-13 --excel-only

# 确认本周确实没有提交时，允许生成空周报
node cli.js generate --week 2026-07-13 --allow-empty
```

`generate` 生成 Excel 后会停在确认提示处。此时可以打开终端显示的 `output/<周期>/周报.xlsx`，完成增删改并保存，再回到终端直接按回车生成 HTML。选择暂不生成时，稍后执行 `continue` 即可。`render` 是 `continue` 的兼容别名。

`after` 和 `before` 在 GitLab Events API 中不包含边界。统计 2026-07-13 至 2026-07-19 时，程序会查询：

```text
after=2026-07-12
before=2026-07-20
```

接口返回后仍会按业务时区和 `committed_date` 二次过滤。

## 数据与产物

每周数据使用独立文件，重复运行不会影响其他周期：

```text
data/raw/2026-07-13_2026-07-19.json
data/normalized/2026-07-13_2026-07-19.json
data/snapshots/2026-07-13_2026-07-19.json

output/2026-07-13_2026-07-19/
├── 周报.xlsx
├── 周报.html
├── validation.json
└── run.json
```

- `raw`：GitLab 原始响应，可用于离线重跑和问题追踪。
- `normalized`：完成日期、作者、项目映射、过滤和排序的数据。
- `snapshot`：Excel 与 HTML 的唯一共同输入。
- `validation.json`：错误、警告、项目 ID 与 Commit SHA 定位信息。
- `run.json`：本次运行周期、耗时、输入、输出及数量统计。

### 人工审核 Excel

第一阶段只根据 Git 数据生成当前周期 Excel，不读取根目录文件。用户确认继续后，程序重新读取刚才生成且可能已经人工维护过的 Excel，并按以下优先级匹配 Git 条目：

1. `Commit SHA` 列，或备注中的 `[commit:abcdef12]` 标记。
2. JIRA 编号。
3. 业务线、项目和任务描述组合。
4. 日期和任务描述组合。

匹配成功后，Excel 中的非空字段覆盖 Git 自动值；未匹配行作为人工新增条目。审核后的 Excel 是最终内容清单：删除某行后，该条目也不会进入 HTML。旧 Excel 中残留的 Merge 行仍会被过滤。

如果已经选择退出，维护完成后执行：

```bash
node cli.js continue --week 2026-07-13
```

生成的 `周报.html` 同时包含两个视图：

- **数据审核**：表格展示完整字段，用于核对、留档。
- **钉钉预览**：按“本周工作总结 → 业务线 → 有序列表”展示精简内容。

点击“复制钉钉内容”只会复制钉钉预览区域，并同时写入 HTML 富文本和纯文本；浏览器不允许 Clipboard API 时会自动使用兼容复制方式。

## Excel 模板

默认情况下，程序会创建标准的“当周数据维护”工作表。如果 `templates/weekly-report.xlsx` 存在，则先加载模板：

- 保留模板中的其他工作表。
- 删除并重新创建配置指定的周报工作表，避免模板中的旧数据在重复执行时残留；其他工作表保持不变。
- 序号写入数字类型，避免显示为 `1900-01-01`。
- 日期写入 Excel 日期类型，并设置 `yyyy/mm/dd` 格式。
- 问题类型和解决状态的数据有效性默认扩展至第 100 行。

如现有模板的周报工作表名称不同，请修改 `excel.sheetName`。

## 异常处理

| 情况 | 处理方式 |
| --- | --- |
| 401、403 | 不重试，提示检查 Token 或权限 |
| 429 | 按 `Retry-After` 等待后重试 |
| 网络超时、502、503、504 | 按 1、2、4 秒指数退避重试 |
| 单项目提交获取失败 | 记录失败项目，继续获取其他项目，校验阶段阻止生成 |
| 作者不匹配 | 排除记录并产生警告；可配置为错误 |
| 项目未映射 | 默认作为错误，不允许静默归入其他项目 |
| 最终条目为 0 | 默认失败；显式添加 `--allow-empty` 才放行 |
| Excel/HTML 条数不一致 | 产物复检失败，退出码非 0 |
| 文件生成中断 | 正式产物不会被半成品覆盖 |

## 验证

```bash
npm test
node cli.js --help
```

测试覆盖周周期计算、排他查询边界、作者和日期过滤、空数据校验、HTML 转义，以及 Excel 序号和日期格式。
