# 今天吃什么 · Cloudflare Pages 版

一个“附近美食发现 + 双转盘抽签”页面。高德 Web 服务 Key 只保存在 Cloudflare 环境变量/Secret 中，由 Pages Function 在服务端调用高德 API，不下发到浏览器。

> 原来用于 Netlify 的 `netlify/` 和 `netlify.toml` 仍保留在项目中作为旧版本备份，但 Cloudflare Pages 不会使用它们。部署 Cloudflare 时不需要它们。

## 项目结构

```text
美食转盘/
├─ index.html                    # 单文件前端页面
├─ functions/
│  └─ api/
│     └─ food.js                 # Cloudflare Pages Function，自动映射 /api/food
├─ scripts/
│  └─ build.js                   # 把 index.html 复制到 dist/
├─ .dev.vars.example             # 本地开发环境变量示例
├─ .gitignore
├─ netlify/                      # 旧 Netlify 版本，Cloudflare 不使用
└─ netlify.toml                  # 旧 Netlify 配置，Cloudflare 不使用
```

Cloudflare 的静态发布目录是 `dist/`，Functions 目录是仓库根目录的 `functions/`。这符合 Cloudflare 的要求：Functions 必须放在静态输出目录之外。

> Cloudflare Pages 的 **Direct Upload（直接上传）目前不支持 Functions**，必须使用 **Git 集成**或 **Wrangler CLI**。本说明采用推荐的 GitHub 集成方式。

## 请求流程

```text
浏览器 index.html
  └─ GET /api/food?lat=39.9087&lng=116.3975&radius=3000
       └─ Cloudflare Pages Function: functions/api/food.js
            └─ context.env.AMAP_KEY
                 └─ 高德周边搜索（types=050000，extensions=all，最多 100 条）
                      └─ 返回简化 JSON 给浏览器
```

## 免费额度说明

Cloudflare Pages 和 Pages Functions 有免费计划额度，通常比 Netlify 的免费额度宽松，且个人项目一般不需要信用卡（以 Cloudflare 当前注册页面为准）。Pages Functions 的请求会计入 Workers 计划额度，具体以 Cloudflare 控制台为准。

## 1. 准备 GitHub 仓库

Cloudflare Pages 的 Functions 需要 Git 集成（或 Wrangler），所以先把项目上传到 GitHub：

1. 登录 https://github.com
2. 点击右上角 `+` → **New repository**
3. 仓库名例如 `food-wheel`，创建
4. 进入仓库 → **Add file → Upload files**
5. 上传整个 `美食转盘` 项目中的文件，至少包括：

```text
index.html
functions/api/food.js
scripts/build.js
.gitignore
.dev.vars.example
README.md
```

不需要上传 `dist/`（Cloudflare 构建时会自动生成），也不需要上传 `verification/`。旧的 `netlify/` 和 `netlify.toml` 可以一起上传，但 Cloudflare 不使用。

## 2. 在 Cloudflare 创建 Pages 项目

1. 登录 https://dash.cloudflare.com
2. 左侧进入 **Workers & Pages**
3. **Create application → Pages → Connect to Git**
4. 授权 GitHub，选择刚才的仓库
5. 项目名称例如 `food-wheel`
6. 生产分支选择 `main`
7. 构建设置：
   - **Build command**：`node scripts/build.js`
   - **Build output directory**：`dist`
   - **Root directory**：留空
8. 展开 **Environment variables**，添加：
   - Variable name：`AMAP_KEY`
   - Value：你的高德 **Web 服务** Key
   - 如果界面提供 **Encrypt / Secret**，建议开启
   - Production 和 Preview 都建议添加同一个 Key
9. 点击 **Save and Deploy**

首次部署完成后会得到类似下面的网址：

```text
https://food-wheel.pages.dev
```

之后每次 `git push` 都会自动部署。

## 3. 测试

打开 Pages 网址：

1. 允许浏览器定位
2. 点击「刷新附近美食」
3. 能显示店铺列表即成功

浏览器 Network 面板中应该只看到：

```text
/api/food?lat=...&lng=...&radius=...
```

不应看到 `restapi.amap.com`，也不应看到高德 Key。

## 修改 AMAP_KEY 后必须做什么

Cloudflare 环境变量/Secret 只对新部署生效：

1. 进入 Pages 项目 → **Settings → Environment variables**
2. 修改或新增 `AMAP_KEY`
3. 保存
4. 进入 **Deployments**，点击 **Retry deployment** 或重新推送一次 Git commit
5. 等新部署完成后再测试

## 本地开发（可选）

需要 Node.js 18+，建议 20/24。

1. 复制环境变量示例：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

2. 编辑 `.dev.vars`，填入：

```text
AMAP_KEY=你的高德Web服务Key
```

3. 构建静态文件：

```powershell
node scripts/build.js
```

4. 启动 Cloudflare Pages 本地开发：

```powershell
npx wrangler pages dev dist
```

默认打开 `http://localhost:8788`。它会同时提供静态页面和 `/api/food` Function。

> 如果 PowerShell 提示禁止运行 npm/npx 脚本，可以改用：
>
> ```powershell
> npx.cmd wrangler pages dev dist
> ```

## 缓存策略

`functions/api/food.js` 有两层缓存：

1. **实例内存缓存**：同一半径、坐标相距 **100 米内**、**10 分钟**内的请求直接复用，不调用高德。
2. **Cloudflare Cache API 边缘缓存**：成功响应在边缘缓存 **10 分钟**，缓存键中的坐标按 3 位小数归一到约 100 米网格。

成功响应头：

```http
Cache-Control: public, max-age=600
X-Food-Cache: HIT|MISS
```

因此浏览器、边缘和函数实例都可以减少重复请求。不同半径会重新请求，避免返回错误半径的数据。

## 接口说明

### `GET /api/food`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `lat` | number | 是 | 纬度，-90 ~ 90 |
| `lng` | number | 是 | 经度，-180 ~ 180 |
| `radius` | number | 否 | 米，500 ~ 5000，默认 3000 |

成功响应节选：

```json
{
  "restaurants": [
    {
      "id": "amap:B0FF...",
      "name": "川味小馆",
      "rating": 4.7,
      "distanceKm": 1.2,
      "cost": 45,
      "category": "川菜",
      "source": "amap",
      "address": "..."
    }
  ],
  "meta": {
    "source": "amap",
    "cache": "MISS",
    "count": 100,
    "radius": 3000,
    "cacheTtlSeconds": 600
  }
}
```

状态码：

- `200`：成功（`meta.cache` 为 `HIT` 或 `MISS`）
- `400`：参数不合法
- `405`：非 GET 请求
- `429`：高德额度/频率超限
- `500`：环境变量缺失、高德 Key 无效或上游异常

前端遇到 `429` 或 `5xx` 会提示：

> 当前查询人数过多，请稍后再试。

## 排错

- **页面正常但接口 404**：确认 `functions/api/food.js` 在仓库根目录，且构建输出目录是 `dist`。
- **接口返回 `CONFIG_ERROR`**：Cloudflare Pages 项目的 `AMAP_KEY` 没配置，或修改后还没有新部署。
- **接口返回 `UPSTREAM_AUTH`**：高德 Key 无效、类型不对，或者已经重置但没有更新 Cloudflare 的变量。
- **构建失败**：确认 Build command 是 `node scripts/build.js`，构建日志里 Node 版本正常。
- **查看 Functions 日志**：Cloudflare Pages 项目 → Deployments → 对应部署 → Functions logs；也可以在本地使用 `npx wrangler pages deployment tail`。

## 安全提醒

- 高德 Key 只放在 Cloudflare 环境变量/Secret 中，不要写进 `index.html`，也不要提交 `.dev.vars`。
- 公开接口仍可能被构造不同坐标的请求刷取。建议使用低配额、可轮换的高德 Key，并在 Cloudflare 侧按需配置 WAF / 速率限制。
- 如果 Key 曾经泄露到截图或聊天中，请尽快在高德控制台重置，并同步更新 Cloudflare 环境变量。
