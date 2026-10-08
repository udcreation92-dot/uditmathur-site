from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Literal
import pandas as pd

Signal = Literal["BUY", "SELL", "HOLD"]

@dataclass
class AnalysisResult:
    signal: Signal
    confidence: float        # 0.0 to 1.0
    reason: str
    indicators: dict         # raw indicator values for display

class BaseModule(ABC):
    name: str
    description: str

    @abstractmethod
    def analyze(self, df: pd.DataFrame) -> AnalysisResult:
        """df must have columns: open, high, low, close, volume (float, sorted asc by time)"""
        ...
