"""Trading Magician's ML trainer (ML brief v1, ADR 0086).

A batch service: it reads feature snapshots and realised labels from Postgres,
refits the model walk-forward, and writes model runs, frozen predictions,
evaluations and the evaluation report. It never runs inside the app.
"""

__version__ = "0.1.0"
