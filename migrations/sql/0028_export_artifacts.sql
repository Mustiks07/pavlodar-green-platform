ALTER TABLE jobs DROP CONSTRAINT job_input_kind_valid;
ALTER TABLE jobs DROP CONSTRAINT job_input_shape_valid;

ALTER TABLE jobs ADD CONSTRAINT job_input_kind_valid
CHECK (input_kind IN ('revision','upload','program','calculation','program_revision'));

ALTER TABLE jobs ADD CONSTRAINT job_input_shape_valid CHECK (
 (input_kind='revision' AND input_revision_id=input_ref_id) OR
 (input_kind IN ('upload','program','calculation','program_revision') AND input_revision_id IS NULL)
);

CREATE TABLE export_artifacts (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
 owner_id uuid NOT NULL REFERENCES principals(id),
 city_id uuid NOT NULL REFERENCES cities(id),
 target_kind varchar NOT NULL CHECK (target_kind IN ('calculation','program_revision')),
 target_id uuid NOT NULL,
 format varchar NOT NULL CHECK (format IN ('pdf','xlsx')),
 storage_key varchar NOT NULL UNIQUE,
 sha256 varchar(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 20000000),
 media_type varchar NOT NULL CHECK (media_type IN ('application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
 filename varchar NOT NULL CHECK (filename ~ '^[a-z0-9_-]+[.](pdf|xlsx)$'),
 created_at timestamptz NOT NULL
);
CREATE INDEX export_artifact_city ON export_artifacts(city_id,id);
CREATE INDEX export_artifact_target ON export_artifacts(target_kind,target_id,id);

CREATE TRIGGER export_artifact_immutable BEFORE UPDATE OR DELETE ON export_artifacts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
