-- Real-time sports betting and casino on the same prepaid balance. Every stake, payout and casino
-- wallet operation is a ledger movement, so the balance stays explainable. All data is synthetic.

CREATE TABLE sports_events (
  id SERIAL PRIMARY KEY,
  sport VARCHAR(20) NOT NULL CHECK (sport IN ('FUTBOL', 'BALONCESTO')),
  league VARCHAR(80) NOT NULL,
  home VARCHAR(80) NOT NULL,
  away VARCHAR(80) NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'LIVE', 'FINISHED')),
  minute SMALLINT NOT NULL DEFAULT 0 CHECK (minute BETWEEN 0 AND 120),
  home_score SMALLINT NOT NULL DEFAULT 0 CHECK (home_score >= 0),
  away_score SMALLINT NOT NULL DEFAULT 0 CHECK (away_score >= 0),
  -- Bumped on every change, so clients can tell a stale board from a fresh one.
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Match result market (1X2). Odds are stored in hundredths: 2.35 -> 235, so money math stays in integers.
CREATE TABLE selections (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES sports_events(id),
  code VARCHAR(4) NOT NULL CHECK (code IN ('HOME', 'DRAW', 'AWAY')),
  odds_x100 INTEGER NOT NULL CHECK (odds_x100 > 100),
  suspended BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (event_id, code)
);

CREATE TABLE bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pos_id UUID NOT NULL REFERENCES points_of_sale(id),
  selection_id INTEGER NOT NULL REFERENCES selections(id),
  stake INTEGER NOT NULL CHECK (stake > 0),
  -- Odds accepted at placement time: later movements never change a placed bet.
  odds_x100 INTEGER NOT NULL CHECK (odds_x100 > 100),
  potential_payout INTEGER NOT NULL CHECK (potential_payout >= stake),
  status VARCHAR(6) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'WON', 'LOST', 'VOID')),
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  UNIQUE (pos_id, idempotency_key)
);

CREATE INDEX idx_bets_pos_created ON bets (pos_id, created_at DESC);
CREATE INDEX idx_bets_open_selection ON bets (selection_id) WHERE status = 'OPEN';

-- Seamless-wallet casino: the game provider debits and credits the store balance with its own
-- transaction ids. The id is unique, so a retried callback is applied once.
CREATE TABLE casino_transactions (
  id BIGSERIAL PRIMARY KEY,
  pos_id UUID NOT NULL REFERENCES points_of_sale(id),
  provider_tx_id VARCHAR(80) NOT NULL UNIQUE,
  round_id VARCHAR(80) NOT NULL,
  game_code VARCHAR(40) NOT NULL,
  type VARCHAR(8) NOT NULL CHECK (type IN ('DEBIT', 'CREDIT', 'ROLLBACK')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  -- A rollback names the debit it cancels. A rollback that arrives first leaves a tombstone,
  -- and the late debit is then refused.
  rolls_back_tx_id VARCHAR(80) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT casino_rollback_link CHECK ((type = 'ROLLBACK') = (rolls_back_tx_id IS NOT NULL))
);

ALTER TABLE balance_movements
  ADD COLUMN bet_id UUID REFERENCES bets(id),
  ADD COLUMN casino_tx_id BIGINT REFERENCES casino_transactions(id),
  DROP CONSTRAINT balance_movements_type_check,
  DROP CONSTRAINT movements_sign,
  DROP CONSTRAINT movements_sale_link,
  ADD CONSTRAINT balance_movements_type_check
    CHECK (type IN ('CREDIT', 'SALE', 'REFUND', 'BET', 'BET_PAYOUT', 'CASINO_DEBIT', 'CASINO_CREDIT', 'CASINO_ROLLBACK')),
  ADD CONSTRAINT movements_sign CHECK (
    (type IN ('CREDIT', 'REFUND', 'BET_PAYOUT', 'CASINO_CREDIT', 'CASINO_ROLLBACK') AND amount > 0)
    OR (type IN ('SALE', 'BET', 'CASINO_DEBIT') AND amount < 0)
  ),
  ADD CONSTRAINT movements_source_link CHECK (
    (type = 'CREDIT' AND sale_id IS NULL AND bet_id IS NULL AND casino_tx_id IS NULL)
    OR (type IN ('SALE', 'REFUND') AND sale_id IS NOT NULL)
    OR (type IN ('BET', 'BET_PAYOUT') AND bet_id IS NOT NULL)
    OR (type LIKE 'CASINO_%' AND casino_tx_id IS NOT NULL)
  );

-- A bet is paid at most once, enforced by the database.
CREATE UNIQUE INDEX uq_movements_one_payout_per_bet ON balance_movements (bet_id) WHERE type = 'BET_PAYOUT';
