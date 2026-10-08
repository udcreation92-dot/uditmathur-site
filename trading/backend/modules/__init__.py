from .rsi import RSIModule
from .macd import MACDModule
from .supertrend import SupertrendModule
from .ema_crossover import EMACrossoverModule
from .volume_spike import VolumeSpikeModule

ALL_MODULES = {
    "rsi": RSIModule(),
    "macd": MACDModule(),
    "supertrend": SupertrendModule(),
    "ema_crossover": EMACrossoverModule(),
    "volume_spike": VolumeSpikeModule(),
}
