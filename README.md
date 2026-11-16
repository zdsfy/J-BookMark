# 我的书签（Bookmark NAS）

> 自托管书签管理工具：零第三方依赖，一条命令跑在 NAS 上。
> 分类管理常用网站地址，支持全文/标签搜索、链接健康检查、访问统计与站点图标自提取。
> 内置 REST API，为浏览器插件预留接口。

![Node Version](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/License-Apache%202.0-blue)
![Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen)
![Platform](https://img.shields.io/badge/Platform-NAS%20%7C%20Linux-yellow)

---

## 特性

- **分类管理**：新建 / 重命名 / 删除分类，支持「未分类」视图
- **书签管理**：增删改查，标题、网址、备注、标签（多标签逗号分隔）
- **全文/标签搜索**：按标题、网址、备注、标签实时搜索；点卡片标签可一键筛选
- **链接健康检查**：批量检测书签链接（HEAD 优先、失败回退 GET，8 秒超时、4 并发），标记为「正常 / 失效 / 异常」，带 HTTP 状态码
- **站点图标自提取**：不依赖 Google/第三方 favicon 服务，服务端按需抓取站点图标并本地缓存（含 SSRF 防护），前端图标加载失败时显示首字母占位
- **访问统计**：点击卡片自动计数，按访问最多 / 最近访问 / 最新添加 / 标题排序；统计弹窗展示总数、今日访问、7 天趋势、Top5
- **深色/浅色主题**：跟随系统或手动切换，本地记住偏好
- **REST API + 跨源访问控制**：供后续浏览器插件跨源调用；跨源访问默认关闭，支持白名单与 Token 鉴权

## 技术栈

纯 Node.js（**零第三方依赖**）+ Node 内置 `node:sqlite` + 原生前端单页。无需 `npm install`，无原生模块编译，NAS 上最稳。

- 后端：Node.js ≥ 22.5（内置 HTTP 服务器、`node:sqlite`、`fetch`）
- 前端：原生 HTML / CSS / JS，无构建步骤、无框架依赖
- 数据库：SQLite（WAL 模式），零配置自动建表

## 快速开始

环境要求：**Node.js ≥ 22.5**（自带 `node:sqlite`，无需任何依赖安装）。

```bash
# 克隆并启动（默认端口 9989）
git clone https://github.com/zdsfy/J-BookMark.git
cd J-BookMark
node server.js

# 或自定义端口
PORT=9000 node server.js
```

浏览器访问 `http://<主机>:9989` 即可使用。首次启动自动创建 `data/` 目录与数据库表结构，无初始化步骤。

### 常用环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `9989` | 监听端口 |
| `BM_TOKEN` | 无 | API Token 鉴权口令（见下方「安全」） |
| `BM_CORS_ORIGINS` | 无 | 跨源白名单，逗号分隔的完整 Origin（如 `https://plugin.example.com`），白名单请求免 Token |

## 在 NAS 上常驻运行

### 方案一：Synology DSM 任务计划（推荐）

1. 控制面板 → 任务计划 → 新增 → **触发的任务** → **用户自定义脚本**
2. 设置：
   - 事件：**开机**（或登录）
   - 用户：`root` 或你的管理员账号
   - 任务设置 → 用户自定义脚本：
     ```bash
     cd /path/to/J-BookMark && nohup node server.js >> data/server.log 2>&1 &
     ```
3. 保存后手动运行一次确认无报错。以后每次开机自动启动。

停止服务：

```bash
pkill -f "node server.js"
```

### 方案二：systemd（通用 Linux）

新建 `/etc/systemd/system/bookmark.service`：

```ini
[Unit]
Description=Bookmark NAS Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/J-BookMark
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
cd /path/to/J-BookMark
pm2 start server.js --name bookmark --update-env
pm2 save && pm2 startup
```

> 本项目本身无需 `npm install`，pm2 只是作为进程守护工具。

## 安全（跨源访问控制）

API 默认只监听局域网，**跨源数据访问默认关闭**（仅允许同源网页与无 Origin 的内网脚本），避免任意网页把你的书签读走。

访问规则按优先级：

1. **无 `Origin` 的请求**（curl、内网脚本）→ 放行
2. **同源请求**（网页版，`Origin` 与请求 Host 的协议 + host + 端口完全一致）→ 放行，无需 Token
3. **`BM_CORS_ORIGINS` 白名单**中的来源 → 放行，无需 Token
4. 其余**跨源**请求 → 必须携带 `Authorization: Bearer <token>` 或 `X-API-Token: <token>`，否则返回 401

浏览器插件等跨源客户端两种接入方式任选其一：

- 设置 `BM_CORS_ORIGINS` 把插件来源加入白名单（推荐，简单直观）
- 或启用 Token：`BM_TOKEN=你的随机密钥 node server.js`，插件请求头带 Token

> ⚠️ Token 只约束带 `Origin` 的跨源请求；无 `Origin` 的请求（curl 等）默认放行。若面向公网开放，请务必放在带访问控制的反向代理后面，并给网页版加登录。

生成随机密钥：`openssl rand -hex 32`

### 链接健康检查的安全限制（防 SSRF）

为防恶意书签让服务器去扫内网端口，健康检查**跳过内网/保留地址**（`127.*`、`10.*`、`172.16-31.*`、`192.168.*`、`169.254.*`、`0.0.0.0`、`localhost`、IPv6 字面量），这些书签状态为「未检测」。内网书签本身仍可正常保存和打开，只是不做自动探测。

### 站点图标（favicon）提取

网页前端不依赖 Google 的 favicon 服务，改由服务端按需提取并本地缓存（`data/favicons/<书签id>.<扩展名>`）：

- 提取策略：先尝试 `<书签协议>://<host>/favicon.ico`，失败则抓首页解析 `<link rel="icon">`（含 apple-touch-icon）
- 首次请求某书签图标时触发抓取，之后走本地缓存（响应 `Cache-Control: private, max-age=86400`）
- SSRF 防护：内网/保留地址不提取（与健康检查同一规则）；跟随重定向后的最终地址若为内网则拒绝
- 图标上限 1.5MB、首页上限 512KB，仅接受常见图片类型
- 编辑书签的 URL 或删除书签时自动清理对应缓存，新 URL 的图标按需重新提取
- 提取失败的站点有 6 小时降级缓存，不会反复请求死站；前端在无图标时显示首字母占位

> 备份时 `data/` 目录下的 `favicons/` 子目录一并备份即可。

## REST API 文档

统一前缀 `/api`，返回 JSON；错误统一为 `{"error": "..."}`，如 `401 未授权`、`404 不存在`、`409 冲突`、`413 请求体过大`。

### 分类

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/categories` | 分类列表（含书签数、失效数） |
| POST | `/api/categories` | 新建分类 `{name, sort_order?}` |
| PUT | `/api/categories/:id` | 重命名 / 排序 `{name?, sort_order?}`（sort_order 必须是整数） |
| DELETE | `/api/categories/:id` | 删除分类（书签变为未分类） |

### 书签

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/bookmarks` | 列表；支持 `category_id`（数字或 `none`）、`health`（ok/dead/error/unknown）、`q`（全文搜索）、`tag`、`sort`（clicks/recent/created/alpha） |
| POST | `/api/bookmarks` | 新建 `{title, url, category_id?, notes?, tags?}`（url 须为 http/https，tags 支持逗号/空格分隔） |
| GET | `/api/bookmarks/:id` | 详情 |
| GET | `/api/bookmarks/:id/favicon` | 站点图标（按需提取并缓存，见上文） |
| PUT | `/api/bookmarks/:id` | 更新（字段可部分传入） |
| DELETE | `/api/bookmarks/:id` | 删除 |
| POST | `/api/bookmarks/:id/visit` | 访问计数 +1（插件/前端打开链接时调用） |

示例（curl）：

```bash
# 列出所有书签
curl http://192.168.1.100:9989/api/bookmarks

# 新建书签（自动触发链接健康检查与 favicon 提取）
curl -X POST http://192.168.1.100:9989/api/bookmarks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Node.js","url":"https://nodejs.org","tags":"dev,doc"}'

# 搜索含 "文档" 的书签
curl 'http://192.168.1.100:9989/api/bookmarks?q=%E6%96%87%E6%A1%A3'
```

### 健康检查

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/bookmarks/:id/check` | 检测单个书签（不占用批量进度） |
| POST | `/api/check-all` | 后台批量检测（立即返回，轮询进度） |
| GET | `/api/check-all/status` | 任务进度 `{job: {running, total, done, ok, dead, error, unknown}}` |

### 统计与其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats` | 总数、今日访问、健康分布、7 天趋势、Top5 |
| GET | `/api/health` | 服务存活探测（供监控使用） |

## Chrome 浏览器插件

仓库内置完整的 Chrome / Edge 扩展（MV3），复用本服务 REST API，实现一键收藏、搜索、快速打开。

<details>
<summary><b>📦 安装（开发者模式加载）</b></summary>

1. 克隆仓库后，浏览器打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择仓库下的 `extension/` 目录
4. 图标出现在工具栏后，点击 ⚙ 打开设置

> 扩展为纯本地代码，无远程加载、无统计上报。
</details>

<details>
<summary><b>⚙ 配置</b></summary>

打开扩展设置页，填写：

| 字段 | 说明 |
|------|------|
| 服务地址 | 你的 bookmark-nas 地址，如 `http://nas.local:9989`（无需 `/api` 后缀） |
| API Token | 可选。仅当服务端设置了 `BM_TOKEN` 时需要，留空则不发送 |

点「测试连接」可验证地址与 Token 是否正确。
</details>

<details>
<summary><b>🚀 使用</b></summary>

- **保存当前页**：点击工具栏图标 → 弹窗自动填入当前页标题 → 选分类、填标签 → 保存
- **保存链接**：网页上右键链接 →「保存链接到书签」；右键页面 →「保存此页面到书签」
- **搜索/快速打开**：弹窗顶部搜索框实时搜索，点击条目在新标签页打开并自动计数
- **快捷键**：`Ctrl+Shift+B` 打开弹窗（可在 `chrome://extensions/shortcuts` 修改）
</details>

> **服务端跨源说明**：扩展请求自带 `Origin: chrome-extension://<id>`，服务端已将
> 该协议来源与「无 Origin 的 curl」同级放行（浏览器 Origin 无法被网页伪造）。
> 因此**无需配置 Token 或白名单**即可使用；若服务端开启了 `BM_TOKEN`，扩展不带
> Token 也能访问（协议来源受信任），恶意网页来源则仍被 401 拦截。

### 扩展文件结构

```
extension/
├── manifest.json     # MV3 清单（权限、弹窗、后台、快捷键）
├── background.js     # Service Worker：右键菜单保存、消息处理
├── common.js         # 共享 API 客户端（配置读取、请求封装、Token）
├── popup.html/js     # 弹窗：保存当前页、搜索、快速打开
├── options.html/js   # 设置页：服务地址、Token、连接测试
├── gen-icons.mjs     # 图标生成脚本（Node 零依赖，重跑可再生成）
└── icons/            # 16/32/48/128 图标（由 gen-icons.mjs 生成）
```

## 隐私说明

本项目是**纯代码仓库**：

- 你的书签数据（`data/bookmark.db`、`data/favicons/`）**不在** git 仓库内（已被 `.gitignore` 排除），上传 / 同步不会泄露个人数据
- 服务端不向任何第三方（如 Google favicon 服务）上报书签域名

## 数据备份与迁移

- 数据全部在 `data/bookmark.db`（WAL 模式下还有 `-wal`、`-shm` 两个伴随文件）
- **在线热备（推荐，保证一致性）**：本仓库的图形界面关闭期间不做限制，直接执行即可（SQLite 并发安全）：

  ```bash
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/bookmark.db');db.exec(\"VACUUM INTO '/backup/bookmark-$(date +%Y%m%d).db'\");db.close();"
  ```

  或停止服务后整体拷贝：`cp -r data /备份目录/`
- 迁移：整个 `bookmark` 目录拷到新机器，`node server.js` 直接启动，自动完成建表
- 首次启动自动创建 `data/` 目录，无初始化步骤

## 目录结构

```
J-BookMark/
├── server.js          # HTTP 入口：静态文件 + 跨源访问控制 + Token 校验
├── src/
│   ├── db.js          # SQLite 初始化与迁移（node:sqlite）
│   ├── api.js         # REST API 全部端点
│   ├── health.js      # 链接健康检查器（并发 + 超时 + SSRF 防护）
│   └── favicon.js     # 站点图标提取器（抓取 + 缓存 + SSRF 防护）
├── public/            # 前端单页（无构建步骤）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── extension/         # Chrome / Edge 浏览器插件（MV3，见上方章节）
├── data/              # 运行时生成（bookmark.db、favicons/），不入 git
├── package.json
└── .gitignore
```

## 常见问题

**Q: 如何清理数据？**
直接删除 `data/` 目录（或只删 `bookmark.db`）即可，重启后自动重建。

**Q: 为什么健康检查对某些内网站点显示「未检测」？**
因为防 SSRF 策略跳过内网/保留地址的探测（见「安全」）。内网书签仍可正常使用。

**Q: 只有一台普通 Linux 机器能跑吗？**
可以，任何 Node.js ≥ 22.5 的环境都能跑，不依赖 NAS 特定功能。

## License

[Apache-2.0](LICENSE)