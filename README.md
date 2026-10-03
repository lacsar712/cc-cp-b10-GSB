# 冷链探头超温台

记录员上报探头编号与摄氏温度，后台工人用数据库行锁认领待处理队列，按 **8℃** 上限判定 **合格** 或 **超温**。

## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python aiohttp + asyncpg |
| 工人 | `worker.py`（psycopg，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Preact + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3197 |
| 接口 | http://localhost:8197 |
| PostgreSQL | localhost:54397（库名 `coldchain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| logger | log123456 | 记录员，可提交读数 |
| watcher | watch123456 | 值班员，只读（含温度对照，不可锁副本） |

## 启动

```bash
cd projects/18-coldchain-probe-desk
docker compose up --build
```

健康检查：`GET http://localhost:8197/api/health` → `{"status":"ok","service":"coldchain-probe-desk"}`

## 温度对照与锁副本

顶栏「温度对照」入口进入对照页：

- 上方选择近 **5/10/20/30** 条；中点表只列**已办结**点，按办结先后排列，与总览办结序一致，并标 **合格/超温**。
- 点表内各选一个基准点、对照点，右侧差值卡展示两点差值。差值一律由服务端按库中温度计算（`POST /api/comparison/diff`），页面不自行相减；未办结或同一点拒绝计算。
- **仅记录员**可点「锁定当前对照为副本」：锁定瞬间点集与差值冻结入库，之后新办结只更新在线点表，旧副本不再变化；记录员与值班员都可在「已锁副本」区打开查看。值班员只能看对照，不能锁。

接口：

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/comparison/points?limit=N` | 登录 | 近次已办结点（办结序） |
| POST | `/api/comparison/diff` | 登录 | 服务端算两点差值 |
| GET | `/api/comparison/snapshots` | 登录 | 已锁副本列表 |
| POST | `/api/comparison/snapshots` | 记录员 | 冻结当前点集与差值 |
| GET | `/api/comparison/snapshots/{id}` | 登录 | 查看某份冻结副本 |

## 种子数据

| 探头 | 温度 | 结论 |
|------|------|------|
| 探头A01 | 4.2℃ | 合格 |
| 探头B02 | 12.5℃ | 超温 |
| 探头C03 | 6.8℃ | 合格 |

## 本地开发（可选）

```bash
# 需本机 PostgreSQL 或仅起 db 容器
cd backend && pip install -r requirements.txt && python api.py
cd backend && python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8197**。
