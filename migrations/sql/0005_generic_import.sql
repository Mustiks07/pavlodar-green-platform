CREATE TABLE uploads (
 id uuid PRIMARY KEY,
 dataset_id uuid NOT NULL REFERENCES datasets(id),
 owner_id uuid NOT NULL REFERENCES principals(id),
 filename varchar NOT NULL,
 content_type varchar NOT NULL,
 byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 500000000),
 sha256 varchar(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 state varchar NOT NULL CHECK (state IN ('ticketed','stored','consumed')),
 storage_key varchar NOT NULL UNIQUE,
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 stored_at timestamptz,
 import_job_id uuid,
 import_request jsonb
);
CREATE INDEX upload_dataset ON uploads(dataset_id);
CREATE INDEX upload_state ON uploads(state);

ALTER TABLE jobs ALTER COLUMN input_revision_id DROP NOT NULL;
ALTER TABLE jobs ADD COLUMN input_ref_id uuid;
ALTER TABLE jobs ADD COLUMN input_kind varchar;
UPDATE jobs SET input_ref_id=input_revision_id,input_kind='revision';
ALTER TABLE jobs ALTER COLUMN input_ref_id SET NOT NULL;
ALTER TABLE jobs ALTER COLUMN input_kind SET NOT NULL;
ALTER TABLE jobs ADD CONSTRAINT job_input_kind_valid CHECK (input_kind IN ('revision','upload'));
ALTER TABLE jobs ADD CONSTRAINT job_input_shape_valid CHECK (
 (input_kind='revision' AND input_revision_id=input_ref_id) OR
 (input_kind='upload' AND input_revision_id IS NULL)
);
ALTER TABLE uploads ADD CONSTRAINT upload_import_job_fk FOREIGN KEY(import_job_id) REFERENCES jobs(id);

CREATE TABLE import_records (
 version_id uuid NOT NULL REFERENCES dataset_versions(id),
 row_index integer NOT NULL CHECK (row_index>=0),
 payload jsonb NOT NULL,
 PRIMARY KEY(version_id,row_index)
);
CREATE TABLE import_quality (
 version_id uuid PRIMARY KEY REFERENCES dataset_versions(id),
 upload_id uuid NOT NULL UNIQUE REFERENCES uploads(id),
 payload jsonb NOT NULL
);

CREATE FUNCTION protect_consumed_upload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state = 'consumed' THEN RAISE EXCEPTION 'consumed_upload_immutable'; END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER upload_immutable_after_consumed BEFORE UPDATE OR DELETE ON uploads
FOR EACH ROW EXECUTE FUNCTION protect_consumed_upload();
CREATE TRIGGER import_record_immutable BEFORE UPDATE OR DELETE ON import_records
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER import_quality_immutable BEFORE UPDATE OR DELETE ON import_quality
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
