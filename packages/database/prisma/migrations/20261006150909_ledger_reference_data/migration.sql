-- System maker-checker policy for manual ledger adjustments: every adjustment needs one
-- independent approver (the maker can never approve their own adjustment).
INSERT INTO "approval_policies" ("id", "level", "subject_id", "service", "maker_checker_enabled", "tiers", "updated_at")
VALUES ('apl_01M48W5TR9M2M3CF7W795N7YPB', 'SYSTEM', NULL, 'ADJUSTMENT', true, '[{"up_to_minor":null,"approvals_required":1}]'::jsonb, now());
