-- Abandoned-checkout sheets: their rows go to the confirmation team like orders, tagged as abandoned.
ALTER TABLE sheet_sources DROP CONSTRAINT sheet_sources_kind_check;
ALTER TABLE sheet_sources ADD CONSTRAINT sheet_sources_kind_check CHECK (kind IN ('real', 'abandoned', 'fake'));
