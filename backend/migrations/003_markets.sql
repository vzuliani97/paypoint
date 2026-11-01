-- More markets per match, all priced from the same goal model as the match result: double chance,
-- total goals over or under 2.5, and both teams to score. Existing selections are match-result ones.
ALTER TABLE selections
  ADD COLUMN market VARCHAR(8) NOT NULL DEFAULT 'MATCH',
  ALTER COLUMN code TYPE VARCHAR(6),
  DROP CONSTRAINT selections_code_check,
  DROP CONSTRAINT selections_event_id_code_key,
  ADD CONSTRAINT selections_market_code CHECK (
    (market = 'MATCH' AND code IN ('HOME', 'DRAW', 'AWAY'))
    OR (market = 'DOUBLE' AND code IN ('1X', '12', 'X2'))
    OR (market = 'GOALS' AND code IN ('OVER', 'UNDER'))
    OR (market = 'BTTS' AND code IN ('YES', 'NO'))
  ),
  ADD CONSTRAINT selections_event_market_code_key UNIQUE (event_id, market, code);
