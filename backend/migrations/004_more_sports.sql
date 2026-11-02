-- More sports on the board: football, basketball, baseball and ice hockey. Each event has its own total
-- line (goals, points or runs) for the over/under market. Two-way sports simply have no DRAW selection.
ALTER TABLE sports_events
  ADD COLUMN total_line NUMERIC(5, 1) NOT NULL DEFAULT 2.5 CHECK (total_line > 0),
  DROP CONSTRAINT sports_events_sport_check,
  ADD CONSTRAINT sports_events_sport_check CHECK (sport IN ('FUTBOL', 'BALONCESTO', 'BEISBOL', 'HOCKEY'));
