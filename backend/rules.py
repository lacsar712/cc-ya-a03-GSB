"""偏航对中判定与齿轮箱温漂补偿。

补偿约定：补偿后偏航 = 原始读数 + 温漂系数 × (机舱温度 − 基准温度)。
例：系数 0.1 度/℃、机舱温度较基准抬高 10℃，补偿后读数较原始读数偏大 1°。
判定：补偿后读数绝对值不超过 1.5° 为合格，否则为偏航超差。
"""

THRESHOLD_DEG = 1.5

# 温漂系数与温度的允许范围，越界即退回。
COEF_MIN = 0.0
COEF_MAX = 1.0
BASE_TEMP_MIN = -30.0
BASE_TEMP_MAX = 50.0
NACELLE_TEMP_MIN = -40.0
NACELLE_TEMP_MAX = 80.0


def compensate(yaw_err_deg: float, coef_deg_per_c: float,
               nacelle_temp_c: float, base_temp_c: float) -> float:
    """按温漂系数把原始偏航读数折算为补偿后偏航。"""
    return yaw_err_deg + coef_deg_per_c * (nacelle_temp_c - base_temp_c)


def coef_in_range(coef_deg_per_c: float) -> bool:
    return COEF_MIN <= coef_deg_per_c <= COEF_MAX


def base_temp_in_range(base_temp_c: float) -> bool:
    return BASE_TEMP_MIN <= base_temp_c <= BASE_TEMP_MAX


def nacelle_temp_in_range(nacelle_temp_c: float) -> bool:
    return NACELLE_TEMP_MIN <= nacelle_temp_c <= NACELLE_TEMP_MAX


def judge(compensated_yaw_deg: float) -> tuple[str, str]:
    if abs(compensated_yaw_deg) <= THRESHOLD_DEG:
        return "合格", f"补偿后偏航 {compensated_yaw_deg}° 在 ±{THRESHOLD_DEG}° 以内"
    return "偏航超差", f"补偿后偏航 {compensated_yaw_deg}° 超过 ±{THRESHOLD_DEG}°"
