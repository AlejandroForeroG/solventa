ALTER TABLE claim_review_actions ADD CONSTRAINT claim_review_action_kind
  CHECK (action IN ('take', 'assign_expert', 'request_information', 'extend_requirement', 'respond'));
ALTER TABLE claim_review_actions DROP CONSTRAINT check_action;
