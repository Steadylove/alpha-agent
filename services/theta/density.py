"""Lognormal terminal distributions and exact bounded piecewise-linear P&L.

All probabilities retain their input measure label. A Q0 probability is not a
forecast of physical trading success. Costs are cash today; payoffs are discounted.
"""
from __future__ import annotations

from dataclasses import dataclass
import math

from scipy.special import ndtr, ndtri


@dataclass(frozen=True)
class Lognormal:
    forward: float
    total_vol: float
    measure: str = 'Q0_market_lognormal_approximation'

    def __post_init__(self):
        if not (math.isfinite(self.forward) and self.forward > 0
                and math.isfinite(self.total_vol) and self.total_vol > 0):
            raise ValueError('Positive finite forward and volatility required')

    @property
    def mu(self):
        return math.log(self.forward) - self.total_vol ** 2 / 2

    def z(self, spot):
        return -math.inf if spot <= 0 else (math.log(spot) - self.mu) / self.total_vol

    def cdf(self, spot):
        return float(ndtr(self.z(spot)))

    def quantile(self, probability):
        if not 0 <= probability <= 1:
            raise ValueError('Probability must lie in [0, 1]')
        if probability == 0:
            return 0.
        if probability == 1:
            return math.inf
        return math.exp(self.mu + self.total_vol * float(ndtri(probability)))

    @staticmethod
    def normal_mass(low, high):
        # Survival differences avoid cancellation in the right tail.
        return float(ndtr(-low) - ndtr(-high) if low > 0 else ndtr(high) - ndtr(low))

    def probability(self, low, high):
        if high <= low or high <= 0:
            return 0.
        return self.normal_mass(self.z(max(0., low)), self.z(high))

    def first_moment(self, low, high):
        if high <= low or high <= 0:
            return 0.
        return self.forward * self.normal_mass(self.z(max(0., low)) - self.total_vol,
                                              self.z(high) - self.total_vol)

    def expected_option(self, strike, right):
        if right == 'call':
            return self.first_moment(strike, math.inf) - strike * self.probability(strike, math.inf)
        if right == 'put':
            return strike * self.probability(0, strike) - self.first_moment(0, strike)
        raise ValueError('Unknown option right')


def validate_legs(legs):
    seen = set()
    for leg in legs:
        key = (leg['strike'], leg['right'])
        if (not math.isfinite(leg['strike']) or leg['strike'] <= 0
                or leg['right'] not in ('call', 'put') or type(leg['qty']) is not int
                or not leg['qty'] or key in seen):
            raise ValueError('Legs need positive strikes, call/put rights and unique nonzero integer quantities')
        seen.add(key)
    if sum(l['qty'] for l in legs if l['right'] == 'call') != 0:
        raise ValueError('Only payoffs bounded on S >= 0 are supported')


def terminal_payoff(legs, spot, multiplier=100):
    return multiplier * sum(l['qty'] * max(spot - l['strike'] if l['right'] == 'call'
                                           else l['strike'] - spot, 0.) for l in legs)


def segments(legs, cost=0., discount=1., multiplier=100):
    """Return (low, high, slope, intercept) covering S in [0, infinity)."""
    validate_legs(legs)
    cuts = [0.] + sorted({float(l['strike']) for l in legs}) + [math.inf]
    result = []
    for lo, hi in zip(cuts, cuts[1:]):
        a = b = 0.
        for l in legs:
            if l['right'] == 'call' and l['strike'] <= lo:
                a += l['qty']; b -= l['qty'] * l['strike']
            elif l['right'] == 'put' and l['strike'] > lo:
                a -= l['qty']; b += l['qty'] * l['strike']
        result.append((lo, hi, a * multiplier * discount, b * multiplier * discount - cost))
    return result


def clipped_below(segment, threshold, strict=False):
    lo, hi, a, b = segment
    if a == 0:
        return (lo, hi) if (b < threshold if strict else b <= threshold) else (lo, lo)
    root = (threshold - b) / a
    return (lo, max(lo, min(hi, root))) if a > 0 else (min(hi, max(lo, root)), hi)


def partial_integral(parts, distribution, threshold=math.inf, strict=False):
    probability = expectation = 0.
    for part in parts:
        lo, hi = clipped_below(part, threshold, strict)
        mass = distribution.probability(lo, hi)
        probability += mass
        expectation += part[2] * distribution.first_moment(lo, hi) + part[3] * mass
    return probability, expectation


def pnl_metrics(legs, distribution, debit_points, fee=1.5, slippage_points=0.,
                discount=1., tail_probability=.05, multiplier=100):
    """Cash-at-entry/PV P&L; natural debit already includes the bid/ask spread."""
    if (not math.isfinite(debit_points) or not all(math.isfinite(x) and x >= 0 for x in (fee, slippage_points))
            or not math.isfinite(discount) or discount <= 0 or not 0 < tail_probability < 1):
        raise ValueError('Invalid cost, discount or tail probability')
    count = sum(abs(l['qty']) for l in legs)
    cost = debit_points * multiplier + count * (fee + slippage_points * multiplier)
    parts = segments(legs, cost, discount, multiplier)
    endpoints = [part[2] * part[0] + part[3] for part in parts]
    minimum, maximum = min(endpoints), max(endpoints)
    mass, ev = partial_integral(parts, distribution)
    if abs(mass - 1) > 1e-10:
        raise ArithmeticError('Payoff domain must cover the entire distribution')
    loss_probability, loss_integral = partial_integral(parts, distribution, 0., strict=True)
    not_win, _ = partial_integral(parts, distribution, 0.)
    left, right = minimum, maximum
    for _ in range(75):
        mid = (left + right) / 2
        if partial_integral(parts, distribution, mid)[0] >= tail_probability:
            right = mid
        else:
            left = mid
    pnl_quantile = right
    tail_mass, tail_integral = partial_integral(parts, distribution, pnl_quantile)
    # Fractionally consume atoms at the quantile: exactly alpha of probability.
    tail_mean = pnl_quantile - (pnl_quantile * tail_mass - tail_integral) / tail_probability
    roots, zero_plateaus = [], []
    for lo, hi, a, b in parts:
        if a:
            root = -b / a
            if lo <= root <= hi:
                roots.append(root)
        elif b == 0:
            zero_plateaus.append([lo, None if math.isinf(hi) else hi])
    probability_at = lambda level: sum(distribution.probability(lo, hi) for lo, hi, a, b in parts
                                       if a == 0 and abs(b - level) < 1e-8)
    expected_loss = max(0., -loss_integral)
    return {
        'probability_measure': distribution.measure, 'integrated_probability_mass': mass,
        'signed_entry_debit_usd': debit_points * multiplier,
        'opening_fees_usd': count * fee, 'extra_slippage_usd': count * slippage_points * multiplier,
        'expected_discounted_payoff_usd': ev + cost, 'model_ev_net_usd': ev,
        'p_profit': max(0., min(1., 1 - not_win)), 'p_loss': max(0., min(1., loss_probability)),
        'p_breakeven': max(0., not_win - loss_probability),
        'net_pnl_min_usd': minimum, 'net_pnl_max_usd': maximum,
        'max_loss_net_usd': max(0., -minimum), 'max_profit_net_usd': max(0., maximum),
        'p_minimum_pnl': probability_at(minimum), 'p_maximum_pnl': probability_at(maximum),
        'expected_loss_usd': expected_loss, 'expected_gain_usd': max(0., ev + expected_loss),
        'conditional_mean_loss_usd': expected_loss / loss_probability if loss_probability > 0 else None,
        'tail_probability': tail_probability, 'lower_pnl_quantile_usd': pnl_quantile,
        'worst_tail_mean_pnl_usd': tail_mean, 'expected_shortfall_loss_usd': max(0., -tail_mean),
        'net_breakevens': sorted(set(roots)), 'zero_pnl_intervals': zero_plateaus,
    }
