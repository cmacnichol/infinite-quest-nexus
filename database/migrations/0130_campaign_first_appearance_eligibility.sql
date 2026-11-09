-- Up Migration
ALTER TABLE campaigns ADD COLUMN first_appearance_eligible boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE campaigns DROP COLUMN first_appearance_eligible;
