import pandas as pd
from .base import BaseModule, AnalysisResult

class VolumeSpikeModule(BaseModule):
    name = "Volume Spike"
    description = "Volume spike with price direction confirms BUY or SELL momentum"

    def __init__(self, lookback: int = 20, spike_multiplier: float = 2.0):
        self.lookback = lookback
        self.spike_multiplier = spike_multiplier

    def analyze(self, df: pd.DataFrame) -> AnalysisResult:
        avg_volume = df["volume"].iloc[-(self.lookback + 1):-1].mean()
        curr_volume = float(df["volume"].iloc[-1])
        ratio = curr_volume / avg_volume if avg_volume > 0 else 1.0

        price_change = float(df["close"].iloc[-1] - df["open"].iloc[-1])

        if ratio >= self.spike_multiplier:
            if price_change > 0:
                signal = "BUY"
                reason = f"Volume spike {ratio:.1f}x avg with bullish candle"
            else:
                signal = "SELL"
                reason = f"Volume spike {ratio:.1f}x avg with bearish candle"
            confidence = min((ratio - 1) / (self.spike_multiplier * 2), 1.0)
        else:
            signal = "HOLD"
            confidence = 0.0
            reason = f"Volume normal ({ratio:.1f}x avg)"

        return AnalysisResult(signal=signal, confidence=round(confidence, 2), reason=reason,
                              indicators={"volume_ratio": round(ratio, 2),
                                          "current_volume": int(curr_volume),
                                          "avg_volume": int(avg_volume)})
