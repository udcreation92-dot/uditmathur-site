import pandas as pd
from .base import BaseModule, AnalysisResult

class EMACrossoverModule(BaseModule):
    name = "EMA Crossover"
    description = "Fast EMA crosses above slow EMA = BUY, crosses below = SELL"

    def __init__(self, fast: int = 9, slow: int = 21):
        self.fast = fast
        self.slow = slow

    def analyze(self, df: pd.DataFrame) -> AnalysisResult:
        ema_fast = df["close"].ewm(span=self.fast, adjust=False).mean()
        ema_slow = df["close"].ewm(span=self.slow, adjust=False).mean()

        curr_diff = float(ema_fast.iloc[-1] - ema_slow.iloc[-1])
        prev_diff = float(ema_fast.iloc[-2] - ema_slow.iloc[-2])

        if prev_diff < 0 and curr_diff > 0:
            signal, confidence = "BUY", 0.8
            reason = f"EMA{self.fast} crossed above EMA{self.slow}"
        elif prev_diff > 0 and curr_diff < 0:
            signal, confidence = "SELL", 0.8
            reason = f"EMA{self.fast} crossed below EMA{self.slow}"
        elif curr_diff > 0:
            signal, confidence = "BUY", 0.3
            reason = f"EMA{self.fast} ({ema_fast.iloc[-1]:.2f}) above EMA{self.slow} ({ema_slow.iloc[-1]:.2f})"
        else:
            signal, confidence = "SELL", 0.3
            reason = f"EMA{self.fast} ({ema_fast.iloc[-1]:.2f}) below EMA{self.slow} ({ema_slow.iloc[-1]:.2f})"

        return AnalysisResult(signal=signal, confidence=confidence, reason=reason,
                              indicators={f"ema{self.fast}": round(float(ema_fast.iloc[-1]), 2),
                                          f"ema{self.slow}": round(float(ema_slow.iloc[-1]), 2)})
