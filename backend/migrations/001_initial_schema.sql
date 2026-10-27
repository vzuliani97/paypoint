-- Money is stored as whole Colombian pesos in INTEGER columns: no floating point.

CREATE TABLE points_of_sale (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL UNIQUE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('ADMIN', 'CASHIER')),
  pos_id UUID REFERENCES points_of_sale(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A cashier always belongs to one point of sale; an admin never does.
  CONSTRAINT users_role_pos CHECK (
    (role = 'CASHIER' AND pos_id IS NOT NULL)
    OR (role = 'ADMIN' AND pos_id IS NULL)
  )
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  type VARCHAR(16) NOT NULL CHECK (type IN ('TOPUP', 'GIFT_CARD')),
  -- Fixed-price products use min_amount = max_amount.
  min_amount INTEGER NOT NULL CHECK (min_amount > 0),
  max_amount INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT products_amount_range CHECK (max_amount >= min_amount)
);

CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pos_id UUID NOT NULL REFERENCES points_of_sale(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  destination VARCHAR(120) NOT NULL,
  channel VARCHAR(16) NOT NULL CHECK (channel IN ('PORTAL', 'PARTNER')),
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED')),
  provider_reference VARCHAR(80),
  failure_reason VARCHAR(200),
  idempotency_key VARCHAR(128) NOT NULL,
  -- SHA-256 of the request body, to detect a key reused with different data.
  request_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_idempotency UNIQUE (pos_id, idempotency_key)
);

CREATE INDEX idx_sales_pos_created ON sales (pos_id, created_at DESC);

-- Ledger: every balance change is recorded, so the balance can always be explained.
CREATE TABLE balance_movements (
  id BIGSERIAL PRIMARY KEY,
  pos_id UUID NOT NULL REFERENCES points_of_sale(id),
  type VARCHAR(16) NOT NULL CHECK (type IN ('CREDIT', 'SALE', 'REFUND')),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  sale_id UUID REFERENCES sales(id),
  note VARCHAR(200),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT movements_sign CHECK (
    (type IN ('CREDIT', 'REFUND') AND amount > 0)
    OR (type = 'SALE' AND amount < 0)
  ),
  CONSTRAINT movements_sale_link CHECK (
    (type = 'CREDIT' AND sale_id IS NULL)
    OR (type IN ('SALE', 'REFUND') AND sale_id IS NOT NULL)
  )
);

CREATE INDEX idx_movements_pos_created ON balance_movements (pos_id, created_at DESC);

-- The database itself guarantees a sale can be refunded at most once.
CREATE UNIQUE INDEX uq_movements_one_refund_per_sale
  ON balance_movements (sale_id)
  WHERE type = 'REFUND';

CREATE TABLE partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  api_key_id VARCHAR(64) NOT NULL UNIQUE,
  hmac_secret VARCHAR(128) NOT NULL,
  pos_id UUID NOT NULL REFERENCES points_of_sale(id),
  allowed_ips TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
