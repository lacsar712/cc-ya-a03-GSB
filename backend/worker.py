"""后台 worker：用 SKIP LOCKED 认领 pending 记录，按补偿后偏航写入判定结论。"""

import os
import time
from datetime import datetime, timezone

import psycopg
from psycopg.rows import dict_row

from db import connect, ensure_schema
from rules import judge

POLL_SEC = float(os.environ.get("WORKER_POLL_SEC", "0.5"))
IDLE_SEC = float(os.environ.get("WORKER_IDLE_SEC", "1.0"))


def claim_and_process(conn) -> bool:
    with conn.transaction():
        row = conn.execute(
            """SELECT id, turbine_code, yaw_err_deg, compensated_yaw_deg
               FROM yaw_logs
               WHERE status = 'pending'
               ORDER BY id
               FOR UPDATE SKIP LOCKED
               LIMIT 1"""
        ).fetchone()
        if row is None:
            return False
        raw = float(row["yaw_err_deg"])
        compensated = row["compensated_yaw_deg"]
        # 下结论前须扣齿轮箱温漂：有补偿后读数一律按补偿后读数判定。
        effective = float(compensated) if compensated is not None else raw
        verdict, reason = judge(effective)
        if compensated is not None:
            reason += f"（原始读数 {raw}°，已按齿轮箱温漂补偿）"
        now = datetime.now(timezone.utc)
        conn.execute(
            """UPDATE yaw_logs
               SET status = 'done', verdict = %s, reason = %s, processed_at = %s
               WHERE id = %s""",
            (verdict, reason, now, row["id"]),
        )
    return True


def main():
    print("yaw-align worker started", flush=True)
    with connect() as conn:
        ensure_schema(conn)
        conn.commit()
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
