CREATE TABLE research_receipts (
 id varchar(64) PRIMARY KEY, actor_id uuid NOT NULL REFERENCES principals(id),
 city_id uuid NOT NULL REFERENCES cities(id), created_at timestamptz NOT NULL,
 manifest jsonb NOT NULL
);
CREATE TABLE research_files (
 receipt_id varchar(64) NOT NULL REFERENCES research_receipts(id), path varchar NOT NULL,
 sha256 varchar(64) NOT NULL, content bytea NOT NULL, PRIMARY KEY(receipt_id,path)
);
CREATE TABLE staging_identities (
 id uuid PRIMARY KEY, namespace varchar NOT NULL, external_id varchar NOT NULL,
 UNIQUE(namespace,external_id)
);
CREATE TABLE staging_records (
 id uuid PRIMARY KEY, identity_id uuid NOT NULL REFERENCES staging_identities(id),
 sha256 varchar(64) NOT NULL, raw jsonb NOT NULL, interpretation jsonb NOT NULL,
 UNIQUE(identity_id,sha256),
 CHECK (interpretation->>'canonical_promotion' = 'not_approved')
);
CREATE INDEX staging_record_identity ON staging_records(identity_id);
CREATE TABLE staging_occurrences (
 version_id uuid NOT NULL REFERENCES dataset_versions(id), table_name varchar NOT NULL,
 row_index integer NOT NULL CHECK(row_index>=0), record_id uuid NOT NULL REFERENCES staging_records(id),
 source_record_ids jsonb NOT NULL,
 PRIMARY KEY(version_id,table_name,row_index)
);
CREATE INDEX staging_occurrence_record ON staging_occurrences(record_id);
CREATE TABLE research_quality (
 version_id uuid PRIMARY KEY REFERENCES dataset_versions(id),
 receipt_id varchar(64) NOT NULL REFERENCES research_receipts(id), request_id varchar NOT NULL,
 payload jsonb NOT NULL, CHECK (payload->>'publish_allowed' = 'false')
);
CREATE TRIGGER research_receipt_immutable BEFORE UPDATE OR DELETE ON research_receipts FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER research_file_immutable BEFORE UPDATE OR DELETE ON research_files FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER staging_identity_immutable BEFORE UPDATE OR DELETE ON staging_identities FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER staging_record_immutable BEFORE UPDATE OR DELETE ON staging_records FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER staging_occurrence_immutable BEFORE UPDATE OR DELETE ON staging_occurrences FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER research_quality_immutable BEFORE UPDATE OR DELETE ON research_quality FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
