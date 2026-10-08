import pandas as pd
import ta
from .base import BaseModule, AnalysisResult

class MACDModule(BaseModule):
    name = "MACD"
    description = "MACD crossover — bullish cross = BUY, bearish cross = SELL"

    def __init__(self, fast: int = 12, slow: int = 26, signal: int = 9):
        self.fast = fast
        self.slow = slow
        self.signal_period = signal

    def analyze(self, df: pd.DataFrame) -> AnalysisResult:
        ind = ta.trend.MACD(df["close"], window_fast=self.fast,
                            window_slow=self.slow, window_sign=self.signal_period)
        macd = ind.macd()
        sig = ind.macd_signal()
        hist = ind.macd_diff()

        prev_hist = float(hist.iloc[-2])
        curr_hist = float(hist.iloc[-1])
        curr_macd = float(macd.iloc[-1])
        curr_sig = float(sig.iloc[-1])

        if prev_hist < 0 and curr_hist > 0:
            signal, confidence = "BUY", min(abs(curr_hist) / 0.5, 1.0)
            reason = f"MACD bullish crossover (hist: {curr_hist:.3f})"
        elif prev_hist > 0 and curr_hist < 0:
            signal, confidence = "SELL", min(abs(curr_hist) / 0.5, 1.0)
            reason = f"MACD bearish crossover (hist: {curr_hist:.3f})"
        else:
            signal, confidence = "HOLD", 0.0
            reason = f"MACD no crossover (hist: {curr_hist:.3f})"

        return AnalysisResult(signal=signal, confidence=round(confidence, 2), reason=reason,
                              indicators={"macd": round(curr_macd, 3),
                                          "signal": round(curr_sig, 3),
                                          "histogram": round(curr_hist, 3)})
