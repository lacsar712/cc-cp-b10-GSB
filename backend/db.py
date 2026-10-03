import os

import asyncpg
import psycopg
from psycopg.rows import dict_row

from rules import judge_temp

DSN = os.environ.get(
    "DATABASE_URL", "postgresql://app:app@localhost:54397/coldchain"
)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS probe_readings (
    id serial PRIMARY KEY,
    probe_id text NOT NULL,
    temp_c double precision NOT NULL,
    verdict text,
    reason text,
    status text NOT NULL DEFAULT 'pending',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_probe_readings_status ON probe_readings (status, id);

-- 温度对照副本（锁定后即冻结，新办结不影响旧副本）
CREATE TABLE IF NOT EXISTS comparison_snapshots (
    id serial PRIMARY KEY,
    point_limit int NOT NULL,
    locked_by text NOT NULL,
    locked_at timestamptz NOT NULL DEFAULT now(),
    base_reading_id bigint,
    target_reading_id bigint,
    base_temp_c double precision,
    target_temp_c double precision,
    diff_c double precision
);

-- 副本冻结的点集（按办结先后，序号即对照页排名）
CREATE TABLE IF NOT EXISTS comparison_snapshot_points (
    id serial PRIMARY KEY,
    snapshot_id int NOT NULL REFERENCES comparison_snapshots(id) ON DELETE CASCADE,
    rank int NOT NULL,
    reading_id bigint NOT NULL,
    probe_id text NOT NULL,
    temp_c double precision NOT NULL,
    verdict text,
    processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_snapshot_points_snapshot
    ON comparison_snapshot_points (snapshot_id, rank);

-- 在线选点差值，一律由服务端计算，浏览器不得自行相减
CREATE TABLE IF NOT EXISTS comparison_diffs (
    id serial PRIMARY KEY,
    base_reading_id bigint NOT NULL,
    target_reading_id bigint NOT NULL,
    base_temp_c double precision NOT NULL,
    target_temp_c double precision NOT NULL,
    diff_c double precision NOT NULL,
    requested_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comparison_diffs_created
    ON comparison_diffs (created_at DESC);
"""


def connect_sync():
    return psycopg.connect(DSN, row_factory=dict_row)


def ensure_schema_sync(conn) -> None:
    conn.execute(SCHEMA_SQL)


async def create_pool() -> asyncpg.Pool:
    return await asyncpg.create_pool(DSN, min_size=1, max_size=5)


async def ensure_schema_async(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        await conn.execute(SCHEMA_SQL)


async def seed_if_empty(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        n = await conn.fetchval("SELECT COUNT(*) FROM probe_readings")
        if n and n > 0:
            return
        samples = [
            ("探头A01", 4.2),
            ("探头B02", 12.5),
        ]
        for probe_id, temp_c in samples:
            verdict, reason = judge_temp(temp_c)
            await conn.execute(
                """
                INSERT INTO probe_readings
                    (probe_id, temp_c, verdict, reason, status, created_by, processed_at)
                VALUES ($1, $2, $3, $4, 'done', 'logger', now())
                """,
                probe_id,
                temp_c,
                verdict,
                reason,
            )


def seed_if_empty_sync(conn) -> None:
    row = conn.execute("SELECT COUNT(*) AS n FROM probe_readings").fetchone()
    if row["n"] > 0:
        return
    samples = [
        ("探头A01", 4.2),
        ("探头B02", 12.5),
    ]
    for probe_id, temp_c in samples:
        verdict, reason = judge_temp(temp_c)
        conn.execute(
            """
            INSERT INTO probe_readings
                (probe_id, temp_c, verdict, reason, status, created_by, processed_at)
            VALUES (%s, %s, %s, %s, 'done', 'logger', now())
            """,
            (probe_id, temp_c, verdict, reason),
        )
    conn.commit()
