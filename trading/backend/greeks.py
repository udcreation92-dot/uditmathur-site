"""Minimal Black-Scholes implied-vol + theta, used by the ROI scanner to rank short strangles by
time-decay as well as return. No external deps — just math. Index options are European-style, so
plain BS is appropriate.

We solve each leg's implied vol from the price we'd actually sell into (its bid), then take the
theta at that vol. For a SHORT option the trader EARNS the decay, so the income is the negative of
the (negative) long-option theta — callers get `theta_per_day_income` already sign-flipped to a
positive number for a short position.
"""
import math

_R = 0.065  # risk-free ~ Indian 1y T-bill; theta is only mildly sensitive to this


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _bs_price(S: float, K: float, T: float, sigma: float, is_call: bool) -> float:
    if sigma <= 0 or T <= 0:
        return max(0.0, (S - K) if is_call else (K - S))
    d1 = (math.log(S / K) + (_R + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    if is_call:
        return S * _norm_cdf(d1) - K * math.exp(-_R * T) * _norm_cdf(d2)
    return K * math.exp(-_R * T) * _norm_cdf(-d2) - S * _norm_cdf(-d1)


def _implied_vol(price: float, S: float, K: float, T: float, is_call: bool) -> float | None:
    """Bisection on sigma (BS price is monotonic in vol). Returns None if the market price can't be
    matched within a sane vol band (e.g. a stale/at-intrinsic quote on a deep strike)."""
    if price <= 0 or S <= 0 or K <= 0 or T <= 0:
        return None
    lo, hi = 1e-4, 5.0
    if _bs_price(S, K, T, lo, is_call) > price:   # price below value at ~0 vol => unmatchable
        return None
    if _bs_price(S, K, T, hi, is_call) < price:   # above value at 500% vol => clamp
        return hi
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if _bs_price(S, K, T, mid, is_call) < price:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def _theta_per_day_long(S: float, K: float, T: float, sigma: float, is_call: bool) -> float:
    """Standard BS theta (per calendar day) for a LONG option — a negative number."""
    sqrtT = math.sqrt(T)
    d1 = (math.log(S / K) + (_R + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
    d2 = d1 - sigma * sqrtT
    term1 = -(S * sigma * _norm_pdf(d1)) / (2.0 * sqrtT)
    if is_call:
        theta_year = term1 - _R * K * math.exp(-_R * T) * _norm_cdf(d2)
    else:
        theta_year = term1 + _R * K * math.exp(-_R * T) * _norm_cdf(-d2)
    return theta_year / 365.0


def short_theta_income(price: float, S: float, K: float, days: int, is_call: bool):
    """For a leg sold at `price` (its bid), return (iv, theta_income_per_day) where theta_income is
    the POSITIVE premium-points the short position decays in the seller's favour each day. Returns
    (None, None) if implied vol can't be solved."""
    T = days / 365.0
    iv = _implied_vol(price, S, K, T, is_call)
    if iv is None or iv <= 0:
        return None, None
    long_theta = _theta_per_day_long(S, K, T, iv, is_call)  # negative
    return iv, -long_theta                                   # flip: seller earns the decay
