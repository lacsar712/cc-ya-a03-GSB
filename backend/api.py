import asyncio
import os
from datetime import datetime, timedelta, timezone
from functools import wraps

from jose import JWTError, jwt
from passlib.context import CryptContext
from quart import Quart, jsonify, request

from db import connect, ensure_schema
from rules import (
    BASE_TEMP_MAX,
    BASE_TEMP_MIN,
    COEF_MAX,
    COEF_MIN,
    NACELLE_TEMP_MAX,
    NACELLE_TEMP_MIN,
    base_temp_in_range,
    coef_in_range,
    compensate,
    judge,
    nacelle_temp_in_range,
)

SECRET = os.environ.get("JWT_SECRET", "yaw-align-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "technician": {
        "role": "writer",
        "password_hash": pwd.hash("tech123456"),
    },
    "observer": {
        "role": "reader",
        "password_hash": pwd.hash("obs123456"),
    },
}

app = Quart(__name__)


def _run_db(fn, *args, **kwargs):
    return fn(*args, **kwargs)


async def run_db(fn, *args, **kwargs):
    return await asyncio.to_thread(_run_db, fn, *args, **kwargs)


def seed_if_empty(conn):
    count = conn.execute("SELECT COUNT(*) AS n FROM yaw_logs").fetchone()["n"]
    if count > 0:
        return
    now = datetime.now(timezone.utc)
    # 种子机组的温漂系数：0.1 度/℃，基准 20℃。
    seeds = [
        # code, raw_err, coef, base_temp, nacelle_temp, expected_verdict
        ("W01", 0.4, 0.1, 20.0, 20.0, "合格"),
        ("W07", 3.2, 0.1, 20.0, 20.0, "偏航超差"),
    ]
    for code, err, coef, base_temp, nacelle_temp, expected_verdict in seeds:
        conn.execute(
            """INSERT INTO drift_coefficients
               (turbine_code, coef_deg_per_c, base_temp_c, updated_by, updated_at)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (turbine_code) DO NOTHING""",
            (code, coef, base_temp, "technician", now),
        )
        compensated = compensate(err, coef, nacelle_temp, base_temp)
        verdict, reason = judge(compensated)
        assert verdict == expected_verdict
        row = conn.execute(
            """INSERT INTO yaw_logs
               (turbine_code, yaw_err_deg, nacelle_temp_c, compensated_yaw_deg,
                status, verdict, reason, created_by, created_at, processed_at)
               VALUES (%s, %s, %s, %s, 'done', %s, %s, %s, %s, %s)
               RETURNING id""",
            (code, err, nacelle_temp, compensated, verdict, reason,
             "technician", now, now),
        ).fetchone()
        conn.execute(
            """INSERT INTO compensation_ledger
               (log_id, turbine_code, raw_yaw_deg, nacelle_temp_c,
                coef_deg_per_c, base_temp_c, compensated_yaw_deg,
                recorded_by, recorded_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (row["id"], code, err, nacelle_temp, coef, base_temp,
             compensated, "technician", now),
        )


@app.before_serving
async def startup():
    def init():
        with connect() as conn:
            ensure_schema(conn)
            seed_if_empty(conn)
            conn.commit()

    await run_db(init)


def parse_bearer():
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


async def current_user():
    token = parse_bearer()
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except JWTError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def require_login(handler):
    @wraps(handler)
    async def wrapper(*args, **kwargs):
        user = await current_user()
        if user is None:
            return jsonify({"detail": "未登录"}), 401
        return await handler(user, *args, **kwargs)

    return wrapper


def require_writer(message="仅现场技师可提交偏航记录"):
    def decorator(handler):
        @wraps(handler)
        async def wrapper(*args, **kwargs):
            user = await current_user()
            if user is None:
                return jsonify({"detail": "未登录"}), 401
            if user["role"] != "writer":
                return jsonify({"detail": message}), 403
            return await handler(user, *args, **kwargs)

        return wrapper

    return decorator


def _parse_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


@app.get("/api/health")
async def health():
    return jsonify({"status": "ok", "service": "yaw-align-log"})


@app.post("/api/auth/login")
async def login():
    body = await request.get_json(force=True, silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return jsonify({"detail": "用户名或密码错误"}), 401
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return jsonify(
        {
            "access_token": token,
            "username": username,
            "role": user["role"],
        }
    )


@app.get("/api/logs")
@require_login
async def list_logs(user):
    def query():
        with connect() as conn:
            return conn.execute(
                """SELECT id, turbine_code, yaw_err_deg, nacelle_temp_c,
                          compensated_yaw_deg, status, verdict, reason,
                          created_by, created_at, processed_at
                   FROM yaw_logs ORDER BY id DESC"""
            ).fetchall()

    rows = await run_db(query)
    return jsonify(rows)


@app.post("/api/logs")
@require_writer()
async def create_log(user):
    body = await request.get_json(force=True, silent=True) or {}
    turbine_code = (body.get("turbine_code") or "").strip()
    if not turbine_code:
        return jsonify({"detail": "机组编号不能为空"}), 400
    yaw_err_deg = _parse_float(body.get("yaw_err_deg"))
    if yaw_err_deg is None:
        return jsonify({"detail": "偏航误差必须是数字"}), 400

    if body.get("nacelle_temp_c") is None:
        return jsonify({"detail": "缺机舱温度：报送必须填写机舱温度，本次提交已退回"}), 400
    nacelle_temp_c = _parse_float(body.get("nacelle_temp_c"))
    if nacelle_temp_c is None:
        return jsonify({"detail": "机舱温度必须是数字"}), 400
    if not nacelle_temp_in_range(nacelle_temp_c):
        return jsonify(
            {"detail": f"机舱温度越界：允许 {NACELLE_TEMP_MIN}~{NACELLE_TEMP_MAX} ℃，本次提交已退回"}
        ), 400

    now = datetime.now(timezone.utc)

    def insert_bundled():
        # 入队与补偿账落笔在同一事务内提交，任一侧失败整体作废。
        with connect() as conn:
            coef_row = conn.execute(
                """SELECT coef_deg_per_c, base_temp_c
                   FROM drift_coefficients WHERE turbine_code = %s""",
                (turbine_code,),
            ).fetchone()
            if coef_row is None:
                return None, (
                    {"detail": f"机组 {turbine_code} 尚未设置温漂系数，请先在系数区设置后再报送"},
                    400,
                )
            coef = float(coef_row["coef_deg_per_c"])
            base_temp = float(coef_row["base_temp_c"])
            if not coef_in_range(coef):
                return None, (
                    {"detail": f"机组 {turbine_code} 的温漂系数 {coef} 越界"
                               f"（允许 {COEF_MIN}~{COEF_MAX} 度/℃），本次提交已退回"},
                    400,
                )
            if not base_temp_in_range(base_temp):
                return None, (
                    {"detail": f"机组 {turbine_code} 的基准温度 {base_temp}℃ 越界"
                               f"（允许 {BASE_TEMP_MIN}~{BASE_TEMP_MAX} ℃），本次提交已退回"},
                    400,
                )

            compensated = compensate(yaw_err_deg, coef, nacelle_temp_c, base_temp)
            row = conn.execute(
                """INSERT INTO yaw_logs
                   (turbine_code, yaw_err_deg, nacelle_temp_c, compensated_yaw_deg,
                    status, verdict, reason, created_by, created_at)
                   VALUES (%s, %s, %s, %s, 'pending', NULL, NULL, %s, %s)
                   RETURNING id, turbine_code, yaw_err_deg, nacelle_temp_c,
                             compensated_yaw_deg, status, verdict, reason,
                             created_by, created_at, processed_at""",
                (turbine_code, yaw_err_deg, nacelle_temp_c, compensated,
                 user["username"], now),
            ).fetchone()
            conn.execute(
                """INSERT INTO compensation_ledger
                   (log_id, turbine_code, raw_yaw_deg, nacelle_temp_c,
                    coef_deg_per_c, base_temp_c, compensated_yaw_deg,
                    recorded_by, recorded_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (row["id"], turbine_code, yaw_err_deg, nacelle_temp_c,
                 coef, base_temp, compensated, user["username"], now),
            )
            conn.commit()
            return row, None

    row, error = await run_db(insert_bundled)
    if error is not None:
        body, status = error
        return jsonify(body), status
    return jsonify(row), 201


@app.put("/api/logs/<int:log_id>")
@require_writer()
async def update_log(user, log_id):
    """改在线单据的展示数字；补偿账里当时写下的旧值不回写、不覆盖。"""
    body = await request.get_json(force=True, silent=True) or {}
    yaw_err_deg = _parse_float(body.get("yaw_err_deg"))
    if yaw_err_deg is None:
        return jsonify({"detail": "偏航误差必须是数字"}), 400

    def update():
        with connect() as conn:
            row = conn.execute(
                """UPDATE yaw_logs
                   SET yaw_err_deg = %s
                   WHERE id = %s
                   RETURNING id, turbine_code, yaw_err_deg, nacelle_temp_c,
                             compensated_yaw_deg, status, verdict, reason,
                             created_by, created_at, processed_at""",
                (yaw_err_deg, log_id),
            ).fetchone()
            conn.commit()
            return row

    row = await run_db(update)
    if row is None:
        return jsonify({"detail": f"记录 {log_id} 不存在"}), 404
    return jsonify(row)


@app.get("/api/coefficients")
@require_login
async def list_coefficients(user):
    def query():
        with connect() as conn:
            return conn.execute(
                """SELECT turbine_code, coef_deg_per_c, base_temp_c,
                          updated_by, updated_at
                   FROM drift_coefficients ORDER BY turbine_code"""
            ).fetchall()

    rows = await run_db(query)
    return jsonify(rows)


@app.put("/api/coefficients/<turbine_code>")
@require_writer("仅现场技师可修改温漂系数")
async def set_coefficient(user, turbine_code):
    turbine_code = turbine_code.strip()
    if not turbine_code:
        return jsonify({"detail": "机组编号不能为空"}), 400
    body = await request.get_json(force=True, silent=True) or {}
    coef = _parse_float(body.get("coef_deg_per_c"))
    if coef is None:
        return jsonify({"detail": "温漂系数必须是数字"}), 400
    if not coef_in_range(coef):
        return jsonify(
            {"detail": f"温漂系数越界：允许 {COEF_MIN}~{COEF_MAX} 度/℃"}
        ), 400
    base_temp = _parse_float(body.get("base_temp_c"))
    if base_temp is None:
        return jsonify({"detail": "基准温度必须是数字"}), 400
    if not base_temp_in_range(base_temp):
        return jsonify(
            {"detail": f"基准温度越界：允许 {BASE_TEMP_MIN}~{BASE_TEMP_MAX} ℃"}
        ), 400

    now = datetime.now(timezone.utc)

    def upsert():
        with connect() as conn:
            row = conn.execute(
                """INSERT INTO drift_coefficients
                   (turbine_code, coef_deg_per_c, base_temp_c, updated_by, updated_at)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (turbine_code) DO UPDATE
                   SET coef_deg_per_c = EXCLUDED.coef_deg_per_c,
                       base_temp_c = EXCLUDED.base_temp_c,
                       updated_by = EXCLUDED.updated_by,
                       updated_at = EXCLUDED.updated_at
                   RETURNING turbine_code, coef_deg_per_c, base_temp_c,
                             updated_by, updated_at""",
                (turbine_code, coef, base_temp, user["username"], now),
            ).fetchone()
            conn.commit()
            return row

    row = await run_db(upsert)
    return jsonify(row)


@app.get("/api/compensation-ledger")
@require_login
async def list_compensation_ledger(user):
    def query():
        with connect() as conn:
            return conn.execute(
                """SELECT id, log_id, turbine_code, raw_yaw_deg, nacelle_temp_c,
                          coef_deg_per_c, base_temp_c, compensated_yaw_deg,
                          recorded_by, recorded_at
                   FROM compensation_ledger ORDER BY id DESC"""
            ).fetchall()

    rows = await run_db(query)
    return jsonify(rows)
