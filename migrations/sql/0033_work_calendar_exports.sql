ALTER TABLE jobs DROP CONSTRAINT job_input_kind_valid;
ALTER TABLE jobs DROP CONSTRAINT job_input_shape_valid;

ALTER TABLE jobs ADD CONSTRAINT job_input_kind_valid
CHECK (input_kind IN ('revision','upload','program','calculation','program_revision','chat_session','work_calendar'));

ALTER TABLE jobs ADD CONSTRAINT job_input_shape_valid CHECK (
 (input_kind='revision' AND input_revision_id=input_ref_id) OR
 (input_kind IN ('upload','program','calculation','program_revision','chat_session','work_calendar')
  AND input_revision_id IS NULL)
);
