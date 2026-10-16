CREATE UNIQUE INDEX financial_contract_offer_revision ON financial_contracts ((terms->>'offerId'), (terms->>'offerVersion'));
