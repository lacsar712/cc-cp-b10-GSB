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


def require_writer(request: web.Request) -> dict:
    user = require_user(request)
    if user["role"] != "writer":
        raise web.HTTPForbidden(
            text=json.dumps({"detail": "仅记录员可提交读数"}, ensure_ascii=False),
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
        ORDER BY processed_at DESC NULLS LAST, id DESC
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


POINT_ORDER = "processed_at DESC, id DESC"
DEFAULT_LIMIT = 10
MAX_LIMIT = 100


def _parse_limit(request: web.Request) -> int:
    raw = request.query.get("limit", str(DEFAULT_LIMIT))
    try:
        limit = int(raw)
    except (TypeError, ValueError):
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "条数必须是整数"}, ensure_ascii=False),
            content_type="application/json",
        )
    if limit < 1:
        limit = 1
    return min(limit, MAX_LIMIT)


def _reading_out(r) -> dict:
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


def _snapshot_out(row, points) -> dict:
    return {
        "id": row["id"],
        "point_limit": row["point_limit"],
        "locked_by": row["locked_by"],
        "locked_at": row["locked_at"].isoformat() if row["locked_at"] else None,
        "base_reading_id": row["base_reading_id"],
        "target_reading_id": row["target_reading_id"],
        "base_temp_c": row["base_temp_c"],
        "target_temp_c": row["target_temp_c"],
        "diff_c": row["diff_c"],
        "points": points,
    }


async def comparison_overview(request: web.Request) -> web.Response:
    require_user(request)
    limit = _parse_limit(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        f"""
        SELECT id, probe_id, temp_c, verdict, reason, status, created_by, created_at, processed_at
        FROM probe_readings
        WHERE status = 'done'
        ORDER BY {POINT_ORDER}
        LIMIT $1
        """,
        limit,
    )
    diff_rows = await pool.fetch(
        """
        SELECT id, base_reading_id, target_reading_id, base_temp_c, target_temp_c,
               diff_c, requested_by, created_at
        FROM comparison_diffs
        ORDER BY created_at DESC, id DESC
        LIMIT 20
        """
    )
    snap_rows = await pool.fetch(
        """
        SELECT s.id, s.point_limit, s.locked_by, s.locked_at,
               s.base_reading_id, s.target_reading_id, s.base_temp_c,
               s.target_temp_c, s.diff_c,
               (SELECT count(*) FROM comparison_snapshot_points p WHERE p.snapshot_id = s.id) AS point_count
        FROM comparison_snapshots s
        ORDER BY s.locked_at DESC, s.id DESC
        """
    )
    return web.json_response(
        {
            "limit": limit,
            "points": [_reading_out(r) for r in rows],
            "diffs": [
                {
                    "id": r["id"],
                    "base_reading_id": r["base_reading_id"],
                    "target_reading_id": r["target_reading_id"],
                    "base_temp_c": r["base_temp_c"],
                    "target_temp_c": r["target_temp_c"],
                    "diff_c": r["diff_c"],
                    "requested_by": r["requested_by"],
                    "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                }
                for r in diff_rows
            ],
            "snapshots": [
                {
                    "id": r["id"],
                    "point_limit": r["point_limit"],
                    "locked_by": r["locked_by"],
                    "locked_at": r["locked_at"].isoformat() if r["locked_at"] else None,
                    "point_count": r["point_count"],
                    "base_reading_id": r["base_reading_id"],
                    "target_reading_id": r["target_reading_id"],
                    "diff_c": r["diff_c"],
                }
                for r in snap_rows
            ],
        }
    )


async def create_diff(request: web.Request) -> web.Response:
    user = require_user(request)
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    try:
        base_id = int(body.get("base_reading_id"))
        target_id = int(body.get("target_reading_id"))
    except (TypeError, ValueError) as exc:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "请选择两个已办结的点"}, ensure_ascii=False),
            content_type="application/json",
        ) from exc
    if base_id == target_id:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "请选择两个不同的点"}, ensure_ascii=False),
            content_type="application/json",
        )

    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        "SELECT id, temp_c, status FROM probe_readings WHERE id = ANY($1::bigint[])",
        [base_id, target_id],
    )
    by_id = {r["id"]: r for r in rows}
    missing = [i for i in (base_id, target_id) if i not in by_id]
    if missing:
        raise web.HTTPNotFound(
            text=json.dumps({"detail": "所选读数不存在"}, ensure_ascii=False),
            content_type="application/json",
        )
    not_done = [i for i in (base_id, target_id) if by_id[i]["status"] != "done"]
    if not_done:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "只能选择已办结的读数"}, ensure_ascii=False),
            content_type="application/json",
        )

    # 差值只允许在服务端计算
    diff_c = float(by_id[target_id]["temp_c"]) - float(by_id[base_id]["temp_c"])
    row = await pool.fetchrow(
        """
        INSERT INTO comparison_diffs
            (base_reading_id, target_reading_id, base_temp_c, target_temp_c,
             diff_c, requested_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, base_reading_id, target_reading_id, base_temp_c,
                  target_temp_c, diff_c, requested_by, created_at
        """,
        base_id,
        target_id,
        float(by_id[base_id]["temp_c"]),
        float(by_id[target_id]["temp_c"]),
        diff_c,
        user["username"],
    )
    return web.json_response(
        {
            "id": row["id"],
            "base_reading_id": row["base_reading_id"],
            "target_reading_id": row["target_reading_id"],
            "base_temp_c": row["base_temp_c"],
            "target_temp_c": row["target_temp_c"],
            "diff_c": row["diff_c"],
            "requested_by": row["requested_by"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        },
        status=201,
    )


async def create_snapshot(request: web.Request) -> web.Response:
    user = require_writer_locked(request)
    try:
        body = await request.json()
    except json.JSONDecodeError:
        body = {}
    try:
        limit = int(body.get("limit", DEFAULT_LIMIT))
    except (TypeError, ValueError):
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "条数必须是整数"}, ensure_ascii=False),
            content_type="application/json",
        )
    limit = max(1, min(limit, MAX_LIMIT))

    try:
        base_id = body.get("base_reading_id")
        target_id = body.get("target_reading_id")
        base_id = int(base_id) if base_id is not None else None
        target_id = int(target_id) if target_id is not None else None
    except (TypeError, ValueError):
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "所选点无效"}, ensure_ascii=False),
            content_type="application/json",
        )

    pool: asyncpg.Pool = request.app["pool"]
    async with pool.acquire() as conn:
        async with conn.transaction():
            rows = await conn.fetch(
                f"""
                SELECT id, probe_id, temp_c, verdict, processed_at
                FROM probe_readings
                WHERE status = 'done'
                ORDER BY {POINT_ORDER}
                LIMIT $1
                """,
                limit,
            )
            point_ids = [r["id"] for r in rows]

            base_temp = target_temp = diff_c = None
            if base_id is not None and target_id is not None:
                if base_id == target_id or base_id not in point_ids or target_id not in point_ids:
                    raise web.HTTPBadRequest(
                        text=json.dumps(
                            {"detail": "只能冻结当前对照点集中两个不同的点"},
                            ensure_ascii=False,
                        ),
                        content_type="application/json",
                    )
                temps = {r["id"]: float(r["temp_c"]) for r in rows}
                base_temp = temps[base_id]
                target_temp = temps[target_id]
                # 副本差值同样只由服务端计算
                diff_c = target_temp - base_temp

            snap = await conn.fetchrow(
                """
                INSERT INTO comparison_snapshots
                    (point_limit, locked_by, base_reading_id, target_reading_id,
                     base_temp_c, target_temp_c, diff_c)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id, point_limit, locked_by, locked_at, base_reading_id,
                          target_reading_id, base_temp_c, target_temp_c, diff_c
                """,
                limit,
                user["username"],
                base_id,
                target_id,
                base_temp,
                target_temp,
                diff_c,
            )
            frozen_points = []
            for rank, r in enumerate(rows, start=1):
                await conn.execute(
                    """
                    INSERT INTO comparison_snapshot_points
                        (snapshot_id, rank, reading_id, probe_id, temp_c, verdict, processed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    """,
                    snap["id"],
                    rank,
                    r["id"],
                    r["probe_id"],
                    float(r["temp_c"]),
                    r["verdict"],
                    r["processed_at"],
                )
                frozen_points.append(
                    {
                        "rank": rank,
                        "reading_id": r["id"],
                        "probe_id": r["probe_id"],
                        "temp_c": float(r["temp_c"]),
                        "verdict": r["verdict"],
                        "processed_at": r["processed_at"].isoformat()
                        if r["processed_at"]
                        else None,
                    }
                )

    return web.json_response(_snapshot_out(snap, frozen_points), status=201)


async def get_snapshot(request: web.Request) -> web.Response:
    require_user(request)
    try:
        snapshot_id = int(request.match_info["snapshot_id"])
    except (TypeError, ValueError):
        raise web.HTTPNotFound(
            text=json.dumps({"detail": "副本不存在"}, ensure_ascii=False),
            content_type="application/json",
        )
    pool: asyncpg.Pool = request.app["pool"]
    snap = await pool.fetchrow(
        "SELECT * FROM comparison_snapshots WHERE id = $1", snapshot_id
    )
    if not snap:
        raise web.HTTPNotFound(
            text=json.dumps({"detail": "副本不存在"}, ensure_ascii=False),
            content_type="application/json",
        )
    point_rows = await pool.fetch(
        """
        SELECT rank, reading_id, probe_id, temp_c, verdict, processed_at
        FROM comparison_snapshot_points
        WHERE snapshot_id = $1
        ORDER BY rank
        """,
        snapshot_id,
    )
    points = [
        {
            "rank": r["rank"],
            "reading_id": r["reading_id"],
            "probe_id": r["probe_id"],
            "temp_c": float(r["temp_c"]),
            "verdict": r["verdict"],
            "processed_at": r["processed_at"].isoformat() if r["processed_at"] else None,
        }
        for r in point_rows
    ]
    return web.json_response(_snapshot_out(snap, points))


def require_writer_locked(request: web.Request) -> dict:
    user = require_user(request)
    if user["role"] != "writer":
        raise web.HTTPForbidden(
            text=json.dumps({"detail": "仅记录员可锁定对照副本"}, ensure_ascii=False),
            content_type="application/json",
        )
    return user


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
    app.router.add_get("/api/comparison", comparison_overview)
    app.router.add_post("/api/comparison/diffs", create_diff)
    app.router.add_post("/api/comparison/snapshots", create_snapshot)
    app.router.add_get("/api/comparison/snapshots/{snapshot_id}", get_snapshot)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=8000)
