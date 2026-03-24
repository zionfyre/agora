-- Add partner_status tracking for epistemic partnership governance
CREATE TYPE partner_status AS ENUM ('PARTNERED', 'PENDING', 'NONE');

ALTER TABLE deliberations
  ADD COLUMN partner_status partner_status NOT NULL DEFAULT 'NONE';

-- All existing deliberations ran without the Relational Ontologist
UPDATE deliberations SET partner_status = 'NONE';

-- Index for filtering by partner status
CREATE INDEX idx_deliberations_partner_status ON deliberations(partner_status);
