PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS products (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_costs (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents >= 0),
 effective_from TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(product_id, effective_from)
);
CREATE TABLE IF NOT EXISTS service_materials (
 service_id TEXT NOT NULL REFERENCES services(id), product_id TEXT NOT NULL REFERENCES products(id),
 quantity REAL NOT NULL CHECK(quantity > 0), PRIMARY KEY(service_id, product_id)
);
CREATE TABLE IF NOT EXISTS sales (
 id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, contact_id TEXT NOT NULL REFERENCES contacts(id), sold_on TEXT NOT NULL,
 gross_cents INTEGER NOT NULL CHECK(gross_cents >= 0), discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(discount_cents >= 0),
 payment_method TEXT NOT NULL, installments INTEGER NOT NULL DEFAULT 1 CHECK(installments BETWEEN 1 AND 48),
 duration_minutes INTEGER CHECK(duration_minutes > 0), source TEXT NOT NULL, created_at TEXT NOT NULL,
 CHECK(discount_cents <= gross_cents)
);
CREATE TABLE IF NOT EXISTS sale_items (
 id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id), service_id TEXT NOT NULL REFERENCES services(id),
 allocated_cents INTEGER CHECK(allocated_cents >= 0), performed_on TEXT,
 direct_cost_cents INTEGER CHECK(direct_cost_cents >= 0), cost_source TEXT
);
CREATE TABLE IF NOT EXISTS receipts (
 id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id), net_cents INTEGER NOT NULL CHECK(net_cents >= 0),
 fee_cents INTEGER NOT NULL CHECK(fee_cents >= 0), received_on TEXT,
 source TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS refunds (
 id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id), amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
 refunded_on TEXT NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS expenses (
 id TEXT PRIMARY KEY, description TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
 category TEXT NOT NULL CHECK(category IN ('operational','investment','tax','transfer','withdrawal','inventory')),
 due_on TEXT NOT NULL, paid_on TEXT, source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_movements (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), quantity REAL NOT NULL CHECK(quantity != 0),
 unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents >= 0), occurred_on TEXT NOT NULL,
 expense_id TEXT REFERENCES expenses(id), sale_item_id TEXT REFERENCES sale_items(id), source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaigns (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, channel TEXT NOT NULL, spend_cents INTEGER CHECK(spend_cents >= 0),
 starts_on TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opportunities (
 id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id), campaign_id TEXT REFERENCES campaigns(id),
 title TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('new','proposal','accepted','lost')),
 last_contact_on TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
 id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL REFERENCES opportunities(id), total_cents INTEGER NOT NULL CHECK(total_cents > 0),
 status TEXT NOT NULL CHECK(status IN ('draft','accepted','rejected')), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quote_items (
 id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id), service_id TEXT NOT NULL REFERENCES services(id),
 amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0)
);
CREATE TABLE IF NOT EXISTS appointments (
 id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id), service_id TEXT NOT NULL REFERENCES services(id),
 starts_at TEXT NOT NULL, duration_minutes INTEGER NOT NULL CHECK(duration_minutes > 0),
 status TEXT NOT NULL CHECK(status IN ('scheduled','completed','cancelled')), sale_id TEXT REFERENCES sales(id), source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS period_reviews (month TEXT PRIMARY KEY, expenses_reviewed_at TEXT, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS simulations (
 id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id), price_cents INTEGER NOT NULL CHECK(price_cents > 0),
 duration_minutes INTEGER CHECK(duration_minutes > 0), as_of TEXT NOT NULL, cost_cents INTEGER,
 margin_cents INTEGER, missing_costs TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
 id TEXT PRIMARY KEY, research_id TEXT, title TEXT NOT NULL, url TEXT NOT NULL, excerpt TEXT NOT NULL,
 consulted_at TEXT NOT NULL, published_on TEXT, region TEXT NOT NULL, limitations TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('informed','observed')), version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS research (
 id TEXT PRIMARY KEY, question TEXT NOT NULL, purpose TEXT NOT NULL, region TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','running','completed','blocked','error')),
 error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_schedules (
 id TEXT PRIMARY KEY, question TEXT NOT NULL, purpose TEXT NOT NULL, region TEXT NOT NULL,
 interval_hours INTEGER NOT NULL CHECK(interval_hours >= 24), next_run_at TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS recommendations (
 id TEXT PRIMARY KEY, rule_key TEXT UNIQUE, title TEXT NOT NULL, finding TEXT NOT NULL, evidence_json TEXT NOT NULL,
 why TEXT NOT NULL, action TEXT NOT NULL, effort TEXT NOT NULL, impact TEXT NOT NULL, assumptions TEXT NOT NULL,
 uncertainty TEXT NOT NULL, reevaluate_when TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
 stale INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
 id TEXT PRIMARY KEY, recommendation_id TEXT NOT NULL REFERENCES recommendations(id),
 choice TEXT NOT NULL CHECK(choice IN ('accept','adjust','defer','reject')), reason TEXT,
 action TEXT, review_on TEXT, executed_on TEXT, outcome TEXT, outcome_on TEXT, learned TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, snapshot_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS dependencies (
 source_type TEXT NOT NULL, source_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('deterministic','analysis','external')),
 PRIMARY KEY(source_type, source_id, target_type, target_id)
);
CREATE TABLE IF NOT EXISTS events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
 action TEXT NOT NULL, before_json TEXT, after_json TEXT, impacts_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, payload_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','running','completed','blocked','error')),
 attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, available_at TEXT NOT NULL,
 error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
 request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
 id TEXT PRIMARY KEY, input TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL, explanation TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','confirmed')), result_json TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (provider TEXT NOT NULL, period TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(provider, period));
CREATE INDEX IF NOT EXISTS sales_date ON sales(sold_on);
CREATE INDEX IF NOT EXISTS receipts_sale ON receipts(sale_id);
CREATE INDEX IF NOT EXISTS deps_source ON dependencies(source_type, source_id);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, available_at);
CREATE INDEX IF NOT EXISTS events_time ON events(created_at);
