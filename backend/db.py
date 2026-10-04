import os

import psycopg
from psycopg.rows import dict_row

DSN = os.environ.get(
    "DATABASE_URL",
    "postgresql://app:app@localhost:54399/yawalign",
)


def connect():
    return psycopg.connect(DSN, row_factory=dict_row)


# 系数与温度允许范围（度 / 摄氏度）
DRIFT_COEF_MIN = -1.0
DRIFT_COEF_MAX = 1.0
TEMP_MIN_C = -50.0
TEMP_MAX_C = 100.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS yaw_logs (
    id serial PRIMARY KEY,
    turbine_code text NOT NULL,
    yaw_err_deg double precision NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    verdict text,
    reason text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL,
    processed_at timestamptz
);
ALTER TABLE yaw_logs ADD COLUMN IF NOT EXISTS nacelle_temp_c double precision;
ALTER TABLE yaw_logs ADD COLUMN IF NOT EXISTS correction_deg double precision;
ALTER TABLE yaw_logs ADD COLUMN IF NOT EXISTS compensated_yaw_deg double precision;
ALTER TABLE yaw_logs ADD COLUMN IF NOT EXISTS display_yaw_deg double precision;
ALTER TABLE yaw_logs ADD COLUMN IF NOT EXISTS display_updated_by text;
ALTER TABLE yaw_logs ADD COLUMN IF NOT EXISTS display_updated_at timestamptz;

CREATE TABLE IF NOT EXISTS turbine_coeffs (
    turbine_code text PRIMARY KEY,
    drift_coef double precision NOT NULL
        CHECK (drift_coef BETWEEN {coef_min} AND {coef_max}),
    base_temp_c double precision NOT NULL
        CHECK (base_temp_c BETWEEN {temp_min} AND {temp_max}),
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS comp_ledger (
    id serial PRIMARY KEY,
    log_id integer NOT NULL UNIQUE REFERENCES yaw_logs(id),
    turbine_code text NOT NULL,
    raw_yaw_deg double precision NOT NULL,
    nacelle_temp_c double precision NOT NULL
        CHECK (nacelle_temp_c BETWEEN {temp_min} AND {temp_max}),
    drift_coef double precision NOT NULL
        CHECK (drift_coef BETWEEN {coef_min} AND {coef_max}),
    base_temp_c double precision NOT NULL
        CHECK (base_temp_c BETWEEN {temp_min} AND {temp_max}),
    temp_delta_c double precision NOT NULL,
    correction_deg double precision NOT NULL,
    compensated_yaw_deg double precision NOT NULL,
    verdict text,
    reason text,
    submitted_by text NOT NULL,
    created_at timestamptz NOT NULL,
    processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_comp_ledger_log_id ON comp_ledger(log_id);
""".format(
    coef_min=DRIFT_COEF_MIN,
    coef_max=DRIFT_COEF_MAX,
    temp_min=TEMP_MIN_C,
    temp_max=TEMP_MAX_C,
)
