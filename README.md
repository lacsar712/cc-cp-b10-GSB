# 冷链探头超温台

记录员上报探头编号与摄氏温度，后台工人用数据库行锁认领待处理队列，按 **8℃** 上限判定 **合格** 或 **超温**。

## 温度对照与锁副本

顶栏「温度对照」入口提供近次读数对照：

- 上部选择近 **5/10/20/50** 条，中列为近次**已办结**点表（按办结先后，合格/超温分色标注），右侧为差值面板与已锁副本区。
- 勾选两点（先勾为基准、后勾为对照）后自动交**服务端**计算差值，浏览器不自行相减。
- 在线点序与总览读数列表的办结序一致（均按 `processed_at DESC, id DESC`）。
- **锁定副本**只对记录员开放；锁定后点集与差值整份冻结到副本表，之后新办结只更新在线点表，旧副本不动；两侧（记录员/值班员）均可查看。
- 值班侧只读对照，没有锁定入口（接口亦对非记录员返回 403）。

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
| watcher | watch123456 | 值班员，只读列表 |

## 启动

```bash
cd projects/18-coldchain-probe-desk
docker compose up --build
```

健康检查：`GET http://localhost:8197/api/health` → `{"status":"ok","service":"coldchain-probe-desk"}`

## 对照接口（均需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/comparison?limit=10` | 近次已办结点（办结序）、最近差值、已锁副本清单 |
| POST | `/api/comparison/diffs` | 传 `base_reading_id`、`target_reading_id`，两点须存在且已办结，差值由服务端计算落库 |
| POST | `/api/comparison/snapshots` | 仅记录员；传 `limit` 与可选的两点，事务内冻结点集与差值 |
| GET | `/api/comparison/snapshots/{id}` | 取冻结副本（点集、差值停留在锁定时） |

## 种子数据

| 探头 | 温度 | 结论 |
|------|------|------|
| 探头A01 | 4.2℃ | 合格 |
| 探头B02 | 12.5℃ | 超温 |

## 本地开发（可选）

```bash
# 需本机 PostgreSQL 或仅起 db 容器
cd backend && pip install -r requirements.txt && python api.py
cd backend && python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8197**。
