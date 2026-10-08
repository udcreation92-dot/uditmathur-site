import pandas as pd
import numpy as np
from .base import BaseModule, AnalysisResult

class SupertrendModule(BaseModule):
    name = "Supertrend"
    description = "Supertrend indicator — price above band = BUY, below = SELL"

    def __init__(self, period: int = 10, multiplier: float = 3.0):
        self.period = period
        self.multiplier = multiplier

    def analyze(self, df: pd.DataFrame) -> AnalysisResult:
        high, low, close = df["high"], df["low"], df["close"]

        # ATR
        tr = pd.concat([
            high - low,
            (high - close.shift()).abs(),
            (low - close.shift()).abs()
        ], axis=1).max(axis=1)
        atr = tr.ewm(span=self.period, adjust=False).mean()

        hl2 = (high + low) / 2
        upper_band = hl2 + self.multiplier * atr
        lower_band = hl2 - self.multiplier * atr

        supertrend = pd.Series(index=df.index, dtype=float)
        direction = pd.Series(index=df.index, dtype=int)

        for i in range(1, len(df)):
            prev_upper = upper_band.iloc[i - 1]
            prev_lower = lower_band.iloc[i - 1]
            upper_band.iloc[i] = upper_band.iloc[i] if upper_band.iloc[i] < prev_upper or close.iloc[i - 1] > prev_upper else prev_upper
            lower_band.iloc[i] = lower_band.iloc[i] if lower_band.iloc[i] > prev_lower or close.iloc[i - 1] < prev_lower else prev_lower

            if close.iloc[i] > upper_band.iloc[i]:
                direction.iloc[i] = 1
            elif close.iloc[i] < lower_band.iloc[i]:
                direction.iloc[i] = -1
            else:
                direction.iloc[i] = direction.iloc[i - 1]

            supertrend.iloc[i] = lower_band.iloc[i] if direction.iloc[i] == 1 else upper_band.iloc[i]

        curr_dir = int(direction.iloc[-1])
        prev_dir = int(direction.iloc[-2])
        curr_st = float(supertrend.iloc[-1])
        curr_close = float(close.iloc[-1])

        if curr_dir == 1 and prev_dir == -1:
            signal, confidence, reason = "BUY", 0.8, f"Supertrend flipped bullish (ST: {curr_st:.2f})"
        elif curr_dir == -1 and prev_dir == 1:
            signal, confidence, reason = "SELL", 0.8, f"Supertrend flipped bearish (ST: {curr_st:.2f})"
        elif curr_dir == 1:
            signal, confidence, reason = "BUY", 0.4, f"Price above Supertrend ({curr_close:.2f} > {curr_st:.2f})"
        else:
            signal, confidence, reason = "SELL", 0.4, f"Price below Supertrend ({curr_close:.2f} < {curr_st:.2f})"

        return AnalysisResult(signal=signal, confidence=confidence, reason=reason,
                              indicators={"supertrend": round(curr_st, 2), "direction": curr_dir})
