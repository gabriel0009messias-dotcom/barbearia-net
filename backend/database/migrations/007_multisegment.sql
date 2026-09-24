-- Additive compatibility migration: assinatura_id remains the establishment key.
CREATE TABLE business_types (
 code TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 active BOOLEAN NOT NULL DEFAULT true,
 sort_order INTEGER NOT NULL DEFAULT 0
);
INSERT INTO business_types (code,name,sort_order) VALUES
 ('barbershop','Barbearia',1), ('beauty_salon','Salão de beleza',2),
 ('nails','Unhas/Manicure',3), ('eyebrows','Sobrancelhas',4),
 ('aesthetics','Estética',5), ('massage','Massagem',6),
 ('makeup','Maquiagem',7), ('waxing','Depilação',8),
 ('lashes','Lash designer',9), ('spa','Spa',10), ('other','Outro',11);
ALTER TABLE assinaturas ADD COLUMN business_type_code TEXT NOT NULL DEFAULT 'other' REFERENCES business_types(code);
ALTER TABLE assinaturas ADD COLUMN state_code TEXT NOT NULL DEFAULT '';
ALTER TABLE assinaturas ADD COLUMN instagram_handle TEXT NOT NULL DEFAULT '';
-- Existing city/street columns are retained, including their historical values.
ALTER TABLE servicos_assinatura ADD COLUMN categoria TEXT NOT NULL DEFAULT '' CHECK (length(categoria)<=100);
