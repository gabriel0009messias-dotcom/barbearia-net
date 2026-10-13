-- Additive: legacy date fields and immutable payment history remain unchanged.
ALTER TABLE assinaturas ADD COLUMN vencimento_em TIMESTAMPTZ;
