# 我的书签（bookmark-nas）

个人书签管理工具，跑在 NAS 上的网页版。分类管理常用网站地址，支持全文/标签搜索、链接健康检查、访问统计。内置 REST API，为后续开发 Chrome / Edge 浏览器插件预留了接口。

**技术栈**：纯 Node.js（零第三方依赖）+ Node 内置 SQLite + 原生前端单页。无需 npm install，无原生模块编译，NAS 上最稳。

---

## 功能

- **分类管理**：新建 / 重命名 / 删除分类，支持「未分类」视图
- **书签管理**：增删改查，标题、网址、备注、标签（多标签逗号分隔）
- **全文/标签搜索**：按标题、网址、备注、标签实时搜索；点卡片标签可一键筛选
- **链接健康检查**：批量检测书签链接（HEAD 优先、失败回退 GET，8 秒超时、4 并发），标记为「正常 / 失效 / 异常」，带 HTTP 状态码
- **访问统计**：点击卡片自动计数，按访问最多 / 最近访问 / 最新添加 / 标题排序；统计弹窗展示总数、今日访问、7 天趋势、Top5
- **导入导出**：数据即 SQLite 文件，直接备份 `data/` 目录即可
- **深色/浅色主题**：跟随系统或手动切换，本地记住偏好
- **REST API + CORS + 可选 API Token**：供后续浏览器插件跨源调用

## 快速开始

环境要求：Node.js ≥ 22.5（自带 `node:sqlite`）。

```bash
# 启动（默认端口 9989）
node server.js
# 或自定义端口
PORT=9000 node server.js
```

浏览器访问 `http://<NAS 地址>:9989` 即可使用。

### 常用环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `9989` | 监听端口 |
| `BM_TOKEN` | 无 | 开启 API Token 鉴权（见下方「安全」） |

## 在 NAS 上常驻运行

### 方案一：Synology DSM 任务计划（推荐）

1. 控制面板 → 任务计划 → 新增 → **触发的任务** → **用户自定义脚本**（或「开机触发」）
2. 设置：
   - 事件：**开机**（或登录）
   - 用户：`root` 或你的管理员账号
   - 任务设置 → 用户自定义脚本：
     ```bash
     cd /volume1/AI-agent/bookmark && nohup node server.js >> data/server.log 2>&1 &
     ```
3. 保存后手动运行一次确认无报错。以后每次开机自动启动，进程崩溃也不影响（可另加监控任务）。

停止服务：`任务计划里手动运行` 或
```bash
pkill -f "node server.js"
```

### 方案二：systemd（通用 Linux NAS / 群晖开了 systemd 的场景）

新建 `/etc/systemd/system/bookmark.service`：

```ini
[Unit]
Description=Bookmark NAS Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/volume1/AI-agent/bookmark
ExecStart=/usr/local/bin/node server.js
Environment=PORT=9989
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bookmark
```

### 方案三：pm2（需要 npm 环境）

```bash
npm install -g pm2
cd /volume1/AI-agent/bookmark
pm2 start server.js --name bookmark --update-env
pm2 save && pm2 startup
```

> 本项目本身无需 `npm install`，pm2 只是作为进程守护工具。

## 安全（API Token）

默认所有接口对局域网开放（CORS 允许所有来源），适合个人 NAS 内网使用。若计划让**浏览器插件**（运行在其他来源）或公网访问写入数据，建议设置 Token：

```bash
BM_TOKEN=你的随机密钥 node server.js
```

设置后规则：
- 网页版（同源访问）**不受影响**，无需 Token；
- 浏览器插件等**跨源**请求必须携带 `Authorization: Bearer <token>` 或 `X-API-Token: <token>`，否则返回 401；
- 无 `Origin` 的请求（如 curl、内网脚本）默认放行。

生成随机密钥：`openssl rand -hex 32`

## REST API 文档

统一前缀 `/api`，返回 JSON；错误统一为 `{"error": "..."}`。

### 分类

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/categories` | 分类列表（含书签数、失效数） |
| POST | `/api/categories` | 新建分类 `{name, sort_order?}` |
| PUT | `/api/categories/:id` | 重命名 / 排序 `{name?, sort_order?}` |
| DELETE | `/api/categories/:id` | 删除分类（书签变为未分类） |

### 书签

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/bookmarks` | 列表；支持 `category_id`（数字或 `none`）、`health`（ok/dead/error/unknown）、`q`（全文搜索）、`tag`、`sort`（clicks/recent/created/alpha） |
| POST | `/api/bookmarks` | 新建 `{title, url, category_id?, notes?, tags?}` |
| GET | `/api/bookmarks/:id` | 详情 |
| PUT | `/api/bookmarks/:id` | 更新（字段可部分传入） |
| DELETE | `/api/bookmarks/:id` | 删除 |
| POST | `/api/bookmarks/:id/visit` | 访问计数 +1（插件/前端打开链接时调用） |

### 健康检查

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/bookmarks/:id/check` | 检测单个书签 |
| POST | `/api/check-all` | 后台批量检测（立即返回，轮询进度） |
| GET | `/api/check-all/status` | 任务进度 `{job: {running, total, done, ok, dead, error}}` |

### 统计与其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats` | 总数、今日访问、健康分布、7 天趋势、Top5 |
| GET | `/api/health` | 服务存活探测（供插件/监控使用） |

## 浏览器插件规划

网页版 API 已按「插件可复用」设计：

- Chrome / Edge 扩展的 Service Worker 通过 `fetch` 调用本服务的 REST API；
- 插件保存当前标签页：`POST /api/bookmarks`（带 `category_id`、`tags`）；
- 用户点击书签打开时：`POST /api/bookmarks/:id/visit` 记录访问；
- 跨源调用需在插件设置里配置 NAS 地址与 API Token（`BM_TOKEN`）。

## 数据备份与迁移

- 数据全部在 `data/bookmark.db`（WAL 模式下还有 `-wal`、`-shm` 两个文件，备份时三个一起拷）。
- 备份：`cp -r data /备份目录/`
- 迁移：整个 `bookmark` 目录拷到新机器，`node server.js` 直接启动，自动完成建表。
- 首次启动自动创建 `data/` 目录，无初始化步骤。

## 目录结构

```
bookmark/
├── server.js          # HTTP 入口：静态文件 + CORS + API Token 校验
├── src/
│   ├── db.js          # SQLite 初始化与迁移（node:sqlite）
│   ├── api.js         # REST API 全部端点
│   └── health.js      # 链接健康检查器（并发 + 超时 + 状态机）
├── public/            # 前端单页（无构建步骤）
│   ├── index.html
│   ├── style.css
│   └── app.js
└── data/              # 运行时生成（bookmark.db），已在 .gitignore
```
