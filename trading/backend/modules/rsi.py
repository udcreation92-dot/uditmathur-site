import pandas as pd
import ta
from .base import BaseModule, AnalysisResult

class RSIModule(BaseModule):
    name = "RSI"
    description = "Relative Strength Index — oversold (<30) = BUY, overbought (>70) = SELL"

    def __init__(self, period: int = 14, oversold: float = 30, overbought: float = 70):
        self.period = period
        self.oversold = oversold
        self.overbought = overbought

    def analyze(self, df: pd.DataFrame) -> AnalysisResult:
        rsi = ta.momentum.RSIIndicator(df["close"], window=self.period).rsi()
        current = float(rsi.iloc[-1])

        if current < self.oversold:
            signal, confidence = "BUY", round((self.oversold - current) / self.oversold, 2)
            reason = f"RSI {current:.1f} is oversold (< {self.oversold})"
        elif current > self.overbought:
            signal, confidence = "SELL", round((current - self.overbought) / (100 - self.overbought), 2)
            reason = f"RSI {current:.1f} is overbought (> {self.overbought})"
        else:
            signal, confidence = "HOLD", 0.0
            reason = f"RSI {current:.1f} is neutral"

        return AnalysisResult(signal=signal, confidence=confidence, reason=reason,
                              indicators={"rsi": round(current, 2)})
