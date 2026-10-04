import asyncio
import os
from datetime import datetime, timedelta, timezone
from functools import wraps

from jose import JWTError, jwt
from passlib.context import CryptContext
from quart import Quart, jsonify, request

from db import (
    DRIFT_COEF_MAX,
    DRIFT_COEF_MIN,
    SCHEMA,
    TEMP_MAX_C,
    TEMP_MIN_C,
    connect,
)
from rules import compensate, judge, validate_coef, validate_temp

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


def _parse_float(value, field_cn: str) -> float:
    try:
        if value is None or str(value).strip() == "":
            raise ValueError
        return float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field_cn}必须是数字")


def seed_if_empty(conn):
    conn.execute(SCHEMA)
    count = conn.execute("SELECT COUNT(*) AS n FROM yaw_logs").fetchone()["n"]
    if count > 0:
        return
    now = datetime.now(timezone.utc)
    # 种子机组温漂系数：0.1 度/℃，基准温度 20℃；种子记录机舱温度等于基准温度，
    # 因此补偿量为 0，结论与原始读数一致。
    seed_coef = 0.1
    base_temp = 20.0
    samples = [
        ("W01", 0.4, 20.0, "合格"),
        ("W07", 3.2, 20.0, "偏航超差"),
    ]
    for code, err, nacelle, expected_verdict in samples:
        temp_delta, correction, compensated = compensate(
            err, seed_coef, nacelle, base_temp
        )
        verdict, reason = judge(compensated)
        assert verdict == expected_verdict
        conn.execute(
            """INSERT INTO turbine_coeffs
               (turbine_code, drift_coef, base_temp_c, updated_by, updated_at)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (turbine_code) DO NOTHING""",
            (code, seed_coef, base_temp, "technician", now),
        )
        log_row = conn.execute(
            """INSERT INTO yaw_logs
               (turbine_code, yaw_err_deg, nacelle_temp_c, correction_deg,
                compensated_yaw_deg, display_yaw_deg,
                status, verdict, reason,
                created_by, created_at, processed_at)
               VALUES (%s, %s, %s, %s, %s, %s, 'done', %s, %s, %s, %s, %s)
               RETURNING id""",
            (
                code,
                err,
                nacelle,
                correction,
                compensated,
                err,
                verdict,
                reason,
                "technician",
                now,
                now,
            ),
        ).fetchone()
        conn.execute(
            """INSERT INTO comp_ledger
               (log_id, turbine_code, raw_yaw_deg, nacelle_temp_c,
                drift_coef, base_temp_c, temp_delta_c, correction_deg,
                compensated_yaw_deg, verdict, reason,
                submitted_by, created_at, processed_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                log_row["id"],
                code,
                err,
                nacelle,
                seed_coef,
                base_temp,
                temp_delta,
                correction,
                compensated,
                verdict,
                reason,
                "technician",
                now,
                now,
            ),
        )


@app.before_serving
async def startup():
    def init():
        with connect() as conn:
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


def require_writer(handler):
    @wraps(handler)
    async def wrapper(*args, **kwargs):
        user = await current_user()
        if user is None:
            return jsonify({"detail": "未登录"}), 401
        if user["role"] != "writer":
            return jsonify({"detail": "仅现场技师可进行此操作"}), 403
        return await handler(user, *args, **kwargs)

    return wrapper


LOG_COLUMNS = """id, turbine_code, yaw_err_deg, nacelle_temp_c, correction_deg,
                 compensated_yaw_deg, display_yaw_deg,
                 display_updated_by, display_updated_at,
                 status, verdict, reason,
                 created_by, created_at, processed_at"""


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
                f"SELECT {LOG_COLUMNS} FROM yaw_logs ORDER BY id DESC"
            ).fetchall()

    rows = await run_db(query)
    return jsonify(rows)


@app.patch("/api/logs/<int:log_id>")
@require_writer
async def patch_log(user, log_id):
    """仅修改在线单据上的展示数字；补偿账快照不受影响。"""
    body = await request.get_json(force=True, silent=True) or {}
    try:
        display = _parse_float(body.get("display_yaw_deg"), "展示偏航读数")
    except ValueError as exc:
        return jsonify({"detail": str(exc)}), 400

    def update():
        with connect() as conn:
            row = conn.execute(
                """UPDATE yaw_logs
                   SET display_yaw_deg = %s,
                       display_updated_by = %s,
                       display_updated_at = %s
                   WHERE id = %s
                   RETURNING """ + LOG_COLUMNS,
                (display, user["username"], datetime.now(timezone.utc), log_id),
            ).fetchone()
            if row is None:
                conn.rollback()
            else:
                conn.commit()
            return row

    row = await run_db(update)
    if row is None:
        return jsonify({"detail": "单据不存在"}), 404
    return jsonify(row)


@app.get("/api/coeffs")
@require_login
async def list_coeffs(user):
    def query():
        with connect() as conn:
            return conn.execute(
                """SELECT turbine_code, drift_coef, base_temp_c,
                          updated_by, updated_at
                   FROM turbine_coeffs ORDER BY turbine_code"""
            ).fetchall()

    rows = await run_db(query)
    return jsonify(rows)


@app.put("/api/coeffs/<turbine_code>")
@require_writer
async def put_coeff(user, turbine_code):
    body = await request.get_json(force=True, silent=True) or {}
    turbine_code = turbine_code.strip()
    if not turbine_code:
        return jsonify({"detail": "机组编号不能为空"}), 400
    try:
        coef = _parse_float(body.get("drift_coef"), "温漂系数")
        validate_coef(coef)
    except ValueError as exc:
        return jsonify({"detail": str(exc)}), 400
    try:
        base_temp = _parse_float(body.get("base_temp_c"), "基准温度")
        validate_temp(base_temp, "基准温度")
    except ValueError as exc:
        return jsonify({"detail": str(exc)}), 400

    def upsert():
        with connect() as conn:
            row = conn.execute(
                """INSERT INTO turbine_coeffs
                   (turbine_code, drift_coef, base_temp_c, updated_by, updated_at)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (turbine_code) DO UPDATE
                     SET drift_coef = EXCLUDED.drift_coef,
                         base_temp_c = EXCLUDED.base_temp_c,
                         updated_by = EXCLUDED.updated_by,
                         updated_at = EXCLUDED.updated_at
                   RETURNING turbine_code, drift_coef, base_temp_c,
                             updated_by, updated_at""",
                (
                    turbine_code,
                    coef,
                    base_temp,
                    user["username"],
                    datetime.now(timezone.utc),
                ),
            ).fetchone()
            conn.commit()
            return row

    row = await run_db(upsert)
    return jsonify(row)


@app.get("/api/ledger")
@require_login
async def list_ledger(user):
    def query():
        with connect() as conn:
            return conn.execute(
                """SELECT id, log_id, turbine_code, raw_yaw_deg, nacelle_temp_c,
                          drift_coef, base_temp_c, temp_delta_c, correction_deg,
                          compensated_yaw_deg, verdict, reason,
                          submitted_by, created_at, processed_at
                   FROM comp_ledger ORDER BY id DESC"""
            ).fetchall()

    rows = await run_db(query)
    return jsonify(rows)


@app.post("/api/logs")
@require_writer
async def create_log(user):
    body = await request.get_json(force=True, silent=True) or {}
    turbine_code = (body.get("turbine_code") or "").strip()
    if not turbine_code:
        return jsonify({"detail": "机组编号不能为空"}), 400
    try:
        yaw_err_deg = _parse_float(body.get("yaw_err_deg"), "偏航误差")
    except ValueError as exc:
        return jsonify({"detail": str(exc)}), 400

    # 温度缺失或越界，提交直接退回，说法清楚。
    raw_temp = body.get("nacelle_temp_c")
    if raw_temp is None or str(raw_temp).strip() == "":
        return jsonify({"detail": "报送须填写机舱温度，否则无法进行齿轮箱温漂补偿"}), 400
    try:
        nacelle_temp = _parse_float(raw_temp, "机舱温度")
        validate_temp(nacelle_temp, "机舱温度")
    except ValueError as exc:
        return jsonify({"detail": str(exc)}), 400

    def insert():
        # 入队与补偿账落笔在同一个事务内，捆绑提交，任一侧失败则整笔作废。
        with connect() as conn:
            with conn.transaction():
                coeff = conn.execute(
                    """SELECT drift_coef, base_temp_c
                       FROM turbine_coeffs WHERE turbine_code = %s""",
                    (turbine_code,),
                ).fetchone()
                if coeff is None:
                    return "no_coeff", None
                drift_coef = float(coeff["drift_coef"])
                base_temp = float(coeff["base_temp_c"])
                try:
                    validate_coef(drift_coef)
                    validate_temp(base_temp, "基准温度")
                except ValueError as exc:
                    return "bad_coeff", str(exc)

                temp_delta, correction, compensated = compensate(
                    yaw_err_deg, drift_coef, nacelle_temp, base_temp
                )
                now = datetime.now(timezone.utc)
                log_row = conn.execute(
                    """INSERT INTO yaw_logs
                       (turbine_code, yaw_err_deg, nacelle_temp_c, correction_deg,
                        compensated_yaw_deg, display_yaw_deg,
                        status, created_by, created_at)
                       VALUES (%s, %s, %s, %s, %s, %s, 'pending', %s, %s)
                       RETURNING """ + LOG_COLUMNS,
                    (
                        turbine_code,
                        yaw_err_deg,
                        nacelle_temp,
                        correction,
                        compensated,
                        yaw_err_deg,
                        user["username"],
                        now,
                    ),
                ).fetchone()
                conn.execute(
                    """INSERT INTO comp_ledger
                       (log_id, turbine_code, raw_yaw_deg, nacelle_temp_c,
                        drift_coef, base_temp_c, temp_delta_c, correction_deg,
                        compensated_yaw_deg, submitted_by, created_at)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        log_row["id"],
                        turbine_code,
                        yaw_err_deg,
                        nacelle_temp,
                        drift_coef,
                        base_temp,
                        temp_delta,
                        correction,
                        compensated,
                        user["username"],
                        now,
                    ),
                )
                return "ok", log_row

    code, row = await run_db(insert)
    if code == "no_coeff":
        return (
            jsonify(
                {
                    "detail": (
                        f"机组 {turbine_code} 尚未设置齿轮箱温漂系数与基准温度，"
                        "请先由技师在补偿账专页系数区设置后再报送"
                    )
                }
            ),
            400,
        )
    if code == "bad_coeff":
        return jsonify({"detail": f"机组 {turbine_code} 温漂参数越界：{row}"}), 400
    return jsonify(row), 201
