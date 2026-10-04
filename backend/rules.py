"""偏航对中判定与齿轮箱温漂补偿。

补偿后偏航 = 原始偏航 + 温漂系数 × (机舱温度 − 基准温度)。
对补偿后偏航按 ±1.5° 阈值给出结论。
"""

from db import DRIFT_COEF_MAX, DRIFT_COEF_MIN, TEMP_MAX_C, TEMP_MIN_C

THRESHOLD_DEG = 1.5


def judge(yaw_err_deg: float) -> tuple[str, str]:
    if abs(yaw_err_deg) <= THRESHOLD_DEG:
        return "合格", f"补偿后偏航 {yaw_err_deg}° 在 ±{THRESHOLD_DEG}° 以内"
    return "偏航超差", f"补偿后偏航 {yaw_err_deg}° 超过 ±{THRESHOLD_DEG}°"


def validate_coef(coef: float) -> float:
    if not (DRIFT_COEF_MIN <= coef <= DRIFT_COEF_MAX):
        raise ValueError(
            f"温漂系数须在 {DRIFT_COEF_MIN} 至 {DRIFT_COEF_MAX} 之间（度/℃），"
            f"收到 {coef}"
        )
    return coef


def validate_temp(temp: float, label: str = "机舱温度") -> float:
    if not (TEMP_MIN_C <= temp <= TEMP_MAX_C):
        raise ValueError(
            f"{label}须在 {TEMP_MIN_C}℃ 至 {TEMP_MAX_C}℃ 之间，收到 {temp}℃"
        )
    return temp


def compensate(
    raw_yaw_deg: float,
    drift_coef: float,
    nacelle_temp_c: float,
    base_temp_c: float,
) -> tuple[float, float]:
    """返回 (温差 ℃, 补偿量°, 补偿后偏航°)。"""
    temp_delta = nacelle_temp_c - base_temp_c
    correction = drift_coef * temp_delta
    compensated = raw_yaw_deg + correction
    return temp_delta, correction, compensated
