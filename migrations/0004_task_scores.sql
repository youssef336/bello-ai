-- Measured per-task skill (0..100) from the benchmark in src/bench.ts. NULL = not measured yet.
ALTER TABLE models ADD COLUMN score_code INTEGER;
ALTER TABLE models ADD COLUMN score_reasoning INTEGER;
ALTER TABLE models ADD COLUMN score_arabic INTEGER;
ALTER TABLE models ADD COLUMN bench_at INTEGER;
