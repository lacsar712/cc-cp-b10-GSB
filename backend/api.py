import json
import os
from datetime import datetime, timedelta, timezone

import asyncpg
import jwt
from aiohttp import web
from passlib.context import CryptContext

from db import create_pool, ensure_schema_async, seed_if_empty
from rules import judge_temp

SECRET = os.environ.get("JWT_SECRET", "coldchain-probe-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

COMPARISON_MIN_POINTS = 2
COMPARISON_MAX_POINTS = 50

USERS = {
    "logger": {"role": "writer", "password_hash": pwd.hash("log123456")},
    "watcher": {"role": "reader", "password_hash": pwd.hash("watch123456")},
}


def _auth_header(request: web.Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def require_user(request: web.Request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        raise web.HTTPUnauthorized(text=json.dumps({"detail": "未登录"}, ensure_ascii=False), content_type="application/json")
    return user


def require_writer(request: web.Request, forbid_text: str = "仅记录员可提交读数") -> dict:
    user = require_user(request)
    if user["role"] != "writer":
        raise web.HTTPForbidden(
            text=json.dumps({"detail": forbid_text}, ensure_ascii=False),
            content_type="application/json",
        )
    return user


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "service": "coldchain-probe-desk"})


async def login(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        raise web.HTTPUnauthorized(
            text=json.dumps({"detail": "用户名或密码错误"}, ensure_ascii=False),
            content_type="application/json",
        )
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return web.json_response(
        {"access_token": token, "username": username, "role": user["role"]}
    )


async def list_readings(request: web.Request) -> web.Response:
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        """
        SELECT id, probe_id, temp_c, verdict, reason, status, created_by, created_at, processed_at
        FROM probe_readings
        ORDER BY CASE WHEN status = 'done' THEN 1 ELSE 0 END ASC,
                 COALESCE(processed_at, created_at) DESC,
                 id DESC
        """
    )
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "probe_id": r["probe_id"],
                "temp_c": r["temp_c"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "processed_at": r["processed_at"].isoformat() if r["processed_at"] else None,
            }
        )
    return web.json_response(out)


async def create_reading(request: web.Request) -> web.Response:
    user = require_writer(request)
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    probe_id = str(body.get("probe_id", "")).strip()
    if not probe_id:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "探头编号不能为空"}, ensure_ascii=False),
            content_type="application/json",
        )
    try:
        temp_c = float(body.get("temp_c"))
    except (TypeError, ValueError) as exc:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "温度必须是数字"}, ensure_ascii=False),
            content_type="application/json",
        ) from exc

    pool: asyncpg.Pool = request.app["pool"]
    row = await pool.fetchrow(
        """
        INSERT INTO probe_readings (probe_id, temp_c, status, created_by, created_at)
        VALUES ($1, $2, 'pending', $3, now())
        RETURNING id, probe_id, temp_c, verdict, reason, status, created_by, created_at, processed_at
        """,
        probe_id,
        temp_c,
        user["username"],
    )
    return web.json_response(
        {
            "id": row["id"],
            "probe_id": row["probe_id"],
            "temp_c": row["temp_c"],
            "verdict": row["verdict"],
            "reason": row["reason"],
            "status": row["status"],
            "created_by": row["created_by"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "processed_at": None,
            "message": "已入队，后台工人将认领并判定",
        },
        status=201,
    )


def _reading_payload(r) -> dict:
    return {
        "id": r["id"],
        "probe_id": r["probe_id"],
        "temp_c": r["temp_c"],
        "verdict": r["verdict"],
        "reason": r["reason"],
        "status": r["status"],
        "created_by": r["created_by"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "processed_at": r["processed_at"].isoformat() if r["processed_at"] else None,
    }


async def _fetch_points(pool: asyncpg.Pool, limit: int) -> list[dict]:
    """近次已办结点：办结序（processed_at, id）与总览在线点序一致。"""
    rows = await pool.fetch(
        """
        SELECT id, probe_id, temp_c, verdict, reason, status, created_by, created_at, processed_at
        FROM probe_readings
        WHERE status = 'done' AND processed_at IS NOT NULL
        ORDER BY processed_at DESC, id DESC
        LIMIT $1
        """,
        limit,
    )
    return [_reading_payload(r) for r in rows]


async def comparison_points(request: web.Request) -> web.Response:
    require_user(request)
    try:
        limit = int(request.query.get("limit", "10"))
    except ValueError:
        limit = 10
    limit = max(COMPARISON_MIN_POINTS, min(limit, COMPARISON_MAX_POINTS))
    pool: asyncpg.Pool = request.app["pool"]
    points = await _fetch_points(pool, limit)
    return web.json_response({"points": points, "limit": limit})


async def comparison_diff(request: web.Request) -> web.Response:
    """选两点交给服务端：差值以库中当时温度重算，浏览器不得自行相减。"""
    require_user(request)
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    try:
        base_id = int(body.get("base_id"))
        other_id = int(body.get("other_id"))
    except (TypeError, ValueError) as exc:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "请选择两个已办结点"}, ensure_ascii=False),
            content_type="application/json",
        ) from exc
    if base_id == other_id:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "请选择两个不同的点"}, ensure_ascii=False),
            content_type="application/json",
        )
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        """
        SELECT id, probe_id, temp_c, verdict, reason, status, created_by, created_at, processed_at
        FROM probe_readings
        WHERE id = ANY($1::int[])
        """,
        [base_id, other_id],
    )
    by_id = {r["id"]: r for r in rows}
    missing = [pid for pid in (base_id, other_id) if pid not in by_id]
    if missing:
        raise web.HTTPNotFound(
            text=json.dumps({"detail": "所选点不存在"}, ensure_ascii=False),
            content_type="application/json",
        )
    not_done = [r for r in (by_id[base_id], by_id[other_id]) if r["status"] != "done"]
    if not_done:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "所选点尚未办结，暂不可算差值"}, ensure_ascii=False),
            content_type="application/json",
        )
    base, other = by_id[base_id], by_id[other_id]
    diff_c = float(base["temp_c"]) - float(other["temp_c"])
    return web.json_response(
        {
            "base": _reading_payload(base),
            "other": _reading_payload(other),
            "diff_c": diff_c,
        }
    )


async def _snapshot_payload(row, points: list[dict]) -> dict:
    return {
        "id": row["id"],
        "base_point_id": row["base_point_id"],
        "other_point_id": row["other_point_id"],
        "diff_c": row["diff_c"],
        "points": points,
        "locked_by": row["locked_by"],
        "locked_at": row["locked_at"].isoformat() if row["locked_at"] else None,
    }


async def create_snapshot(request: web.Request) -> web.Response:
    """锁副本：冻结当时的点集与两点差值，之后新办结只更新在线点表，旧副本不动。"""
    user = require_writer(request, "仅记录员可锁定副本")
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    try:
        base_id = int(body.get("base_id"))
        other_id = int(body.get("other_id"))
        limit = int(body.get("limit", 10))
    except (TypeError, ValueError) as exc:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "请选择两个已办结点再锁定副本"}, ensure_ascii=False),
            content_type="application/json",
        ) from exc
    limit = max(COMPARISON_MIN_POINTS, min(limit, COMPARISON_MAX_POINTS))
    if base_id == other_id:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "请选择两个不同的点"}, ensure_ascii=False),
            content_type="application/json",
        )

    pool: asyncpg.Pool = request.app["pool"]
    async with pool.acquire() as conn:
        # 与 diff 接口一致：锁时由服务端按库中数据重算
        rows = await conn.fetch(
            """
            SELECT id, probe_id, temp_c, verdict, reason, status, created_by, created_at, processed_at
            FROM probe_readings
            WHERE id = ANY($1::int[])
            """,
            [base_id, other_id],
        )
        by_id = {r["id"]: r for r in rows}
        if base_id not in by_id or other_id not in by_id:
            raise web.HTTPNotFound(
                text=json.dumps({"detail": "所选点不存在"}, ensure_ascii=False),
                content_type="application/json",
            )
        if any(r["status"] != "done" for r in (by_id[base_id], by_id[other_id])):
            raise web.HTTPBadRequest(
                text=json.dumps({"detail": "所选点尚未办结，暂不可锁定副本"}, ensure_ascii=False),
                content_type="application/json",
            )
        diff_c = float(by_id[base_id]["temp_c"]) - float(by_id[other_id]["temp_c"])
        points = await _fetch_points(conn, limit)
        points_json = json.dumps(points, ensure_ascii=False)
        row = await conn.fetchrow(
            """
            INSERT INTO comparison_snapshots
                (base_point_id, other_point_id, diff_c, points, locked_by)
            VALUES ($1, $2, $3, $4::jsonb, $5)
            RETURNING id, base_point_id, other_point_id, diff_c, points, locked_by, locked_at
            """,
            base_id,
            other_id,
            diff_c,
            points_json,
            user["username"],
        )
    return web.json_response(
        await _snapshot_payload(row, json.loads(row["points"])), status=201
    )


async def list_snapshots(request: web.Request) -> web.Response:
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        """
        SELECT s.id, s.base_point_id, s.other_point_id, s.diff_c,
               s.points, s.locked_by, s.locked_at,
               b.probe_id AS base_probe_id, b.temp_c AS base_temp_c,
               o.probe_id AS other_probe_id, o.temp_c AS other_temp_c
        FROM comparison_snapshots s
        LEFT JOIN probe_readings b ON b.id = s.base_point_id
        LEFT JOIN probe_readings o ON o.id = s.other_point_id
        ORDER BY s.id DESC
        LIMIT 50
        """
    )
    out = [
        {
            "id": r["id"],
            "base_point_id": r["base_point_id"],
            "other_point_id": r["other_point_id"],
            "base_probe_id": r["base_probe_id"],
            "base_temp_c": r["base_temp_c"],
            "other_probe_id": r["other_probe_id"],
            "other_temp_c": r["other_temp_c"],
            "diff_c": r["diff_c"],
            "locked_by": r["locked_by"],
            "locked_at": r["locked_at"].isoformat() if r["locked_at"] else None,
        }
        for r in rows
    ]
    return web.json_response(out)


async def get_snapshot(request: web.Request) -> web.Response:
    require_user(request)
    snap_id = int(request.match_info["snap_id"])
    pool: asyncpg.Pool = request.app["pool"]
    row = await pool.fetchrow(
        """
        SELECT id, base_point_id, other_point_id, diff_c, points, locked_by, locked_at
        FROM comparison_snapshots
        WHERE id = $1
        """,
        snap_id,
    )
    if not row:
        raise web.HTTPNotFound(
            text=json.dumps({"detail": "副本不存在"}, ensure_ascii=False),
            content_type="application/json",
        )
    return web.json_response(
        await _snapshot_payload(row, json.loads(row["points"]))
    )


async def on_startup(app: web.Application) -> None:
    pool = await create_pool()
    app["pool"] = pool
    await ensure_schema_async(pool)
    await seed_if_empty(pool)


async def on_cleanup(app: web.Application) -> None:
    pool: asyncpg.Pool = app.get("pool")
    if pool:
        await pool.close()


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/api/health", health)
    app.router.add_post("/api/auth/login", login)
    app.router.add_get("/api/readings", list_readings)
    app.router.add_post("/api/readings", create_reading)
    app.router.add_get("/api/comparison/points", comparison_points)
    app.router.add_post("/api/comparison/diff", comparison_diff)
    app.router.add_get("/api/comparison/snapshots", list_snapshots)
    app.router.add_post("/api/comparison/snapshots", create_snapshot)
    app.router.add_get(r"/api/comparison/snapshots/{snap_id:\d+}", get_snapshot)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=8000)
