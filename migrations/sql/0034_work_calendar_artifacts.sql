ALTER TABLE export_artifacts DROP CONSTRAINT export_artifacts_target_kind_check;
ALTER TABLE export_artifacts ADD CONSTRAINT export_artifacts_target_kind_check
CHECK (target_kind IN ('calculation','program_revision','work_calendar'));
