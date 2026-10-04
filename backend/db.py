import os

import psycopg
from psycopg.rows import dict_row

DSN = os.environ.get(
    "DATABASE_URL",
    "postgresql://app:app@localhost:54399/yawalign",
)


def connect():
    return psycopg.connect(DSN, row_factory=dict_row)


# 逐条执行的建表/补列语句，全部幂等，兼容已存在的旧库。
SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS yaw_logs (
        id serial PRIMARY KEY,
        turbine_code text NOT NULL,
        yaw_err_deg double precision NOT NULL,
        nacelle_temp_c double precision,
        compensated_yaw_deg double precision,
        status text NOT NULL DEFAULT 'pending',
        verdict text,
        reason text,
        created_by text NOT NULL,
        created_at timestamptz NOT NULL,
        processed_at timestamptz
    )
    """,
    # 旧库补列（CREATE TABLE IF NOT EXISTS 不会为已存在的表加列）。
    "ALTER TABLE yaw_logs ADD COLUMN IF NOT EXISTS nacelle_temp_c double precision",
    "ALTER TABLE yaw_logs ADD COLUMN IF NOT EXISTS compensated_yaw_deg double precision",
    """
    CREATE TABLE IF NOT EXISTS drift_coefficients (
        turbine_code text PRIMARY KEY,
        coef_deg_per_c double precision NOT NULL,
        base_temp_c double precision NOT NULL,
        updated_by text NOT NULL,
        updated_at timestamptz NOT NULL
    )
    """,
    # 补偿账：报送时落笔一次，之后任何在线单据改动都不回写此表。
    """
    CREATE TABLE IF NOT EXISTS compensation_ledger (
        id serial PRIMARY KEY,
        log_id integer NOT NULL REFERENCES yaw_logs(id),
        turbine_code text NOT NULL,
        raw_yaw_deg double precision NOT NULL,
        nacelle_temp_c double precision NOT NULL,
        coef_deg_per_c double precision NOT NULL,
        base_temp_c double precision NOT NULL,
        compensated_yaw_deg double precision NOT NULL,
        recorded_by text NOT NULL,
        recorded_at timestamptz NOT NULL
    )
    """,
]


def ensure_schema(conn):
    for stmt in SCHEMA_STATEMENTS:
        conn.execute(stmt)
