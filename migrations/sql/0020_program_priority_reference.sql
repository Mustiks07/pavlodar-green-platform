ALTER TABLE program_input_versions
ADD COLUMN priority_result_id uuid REFERENCES priority_results(id);

CREATE INDEX program_input_versions_priority_idx
ON program_input_versions(priority_result_id)
WHERE priority_result_id IS NOT NULL;
