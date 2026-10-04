"""后台 worker：用 SKIP LOCKED 认领 pending 记录。

服务端下结论前须扣齿轮箱温漂：结论按补偿后偏航判定，并在同一事务内
回填对中记录与补偿账。
"""

import os
import time
from datetime import datetime, timezone

import psycopg

from db import SCHEMA, connect
from rules import judge

POLL_SEC = float(os.environ.get("WORKER_POLL_SEC", "0.5"))
IDLE_SEC = float(os.environ.get("WORKER_IDLE_SEC", "1.0"))


def ensure_schema(conn):
    conn.execute(SCHEMA)
    conn.commit()


def claim_and_process(conn) -> bool:
    with conn.transaction():
        row = conn.execute(
            """SELECT id, COALESCE(compensated_yaw_deg, yaw_err_deg) AS judged_yaw_deg
               FROM yaw_logs
               WHERE status = 'pending'
               ORDER BY id
               FOR UPDATE SKIP LOCKED
               LIMIT 1"""
        ).fetchone()
        if row is None:
            return False
        compensated = float(row["judged_yaw_deg"])
        verdict, reason = judge(compensated)
        now = datetime.now(timezone.utc)
        conn.execute(
            """UPDATE yaw_logs
               SET status = 'done', verdict = %s, reason = %s, processed_at = %s
               WHERE id = %s""",
            (verdict, reason, now, row["id"]),
        )
        conn.execute(
            """UPDATE comp_ledger
               SET verdict = %s, reason = %s, processed_at = %s
               WHERE log_id = %s""",
            (verdict, reason, now, row["id"]),
        )
    return True


def main():
    print("yaw-align worker started", flush=True)
    with connect() as conn:
        ensure_schema(conn)
    while True:
        try:
            with connect() as conn:
                if claim_and_process(conn):
                    conn.commit()
                    time.sleep(POLL_SEC)
                else:
                    time.sleep(IDLE_SEC)
        except psycopg.Error as exc:
            print(f"worker db error: {exc}", flush=True)
            time.sleep(IDLE_SEC)


if __name__ == "__main__":
    main()
