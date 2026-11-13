"""Pattern discovery's miner (pattern brief 2026-11-13 §5, §7, §10; ADR 0091).

Reads the factor store (`factor_snapshot`) the worker writes, forms atoms,
labels excursion outcomes from the stored bar ratios, beam-searches
conjunctions on the discovery window, verifies the finalists once on the
holdout window, and writes patterns and their occurrences. Runs in the batch
service beside the ML trainer, behind PATTERN_MINER_ENABLED.
"""

__version__ = "1.0.0"
