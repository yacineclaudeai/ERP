-- Past parcels read from the delivery companies, for the customer check (delivered / returned per phone).
CREATE TABLE customer_history (
  company_id INTEGER NOT NULL REFERENCES delivery_companies(id) ON DELETE CASCADE,
  tracking TEXT NOT NULL,
  phone TEXT NOT NULL,
  outcome TEXT NOT NULL,
  PRIMARY KEY (company_id, tracking)
);
CREATE INDEX idx_customer_history_phone ON customer_history(phone);
