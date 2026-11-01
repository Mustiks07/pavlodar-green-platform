CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE cities (
	id UUID NOT NULL, 
	payload JSONB NOT NULL, 
	synthetic BOOLEAN NOT NULL, 
	PRIMARY KEY (id)
)

;

CREATE TABLE idempotency (
	scope VARCHAR(64) NOT NULL, 
	request_hash VARCHAR(64) NOT NULL, 
	status INTEGER NOT NULL, 
	response JSONB, 
	headers JSONB NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (scope)
)

;

CREATE TABLE login_states (
	state_hash VARCHAR(64) NOT NULL, 
	browser_hash VARCHAR(64) NOT NULL, 
	nonce VARCHAR NOT NULL, 
	verifier VARCHAR NOT NULL, 
	return_to VARCHAR NOT NULL, 
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (state_hash)
)

;

CREATE TABLE principals (
	id UUID NOT NULL, 
	issuer VARCHAR NOT NULL, 
	subject VARCHAR NOT NULL, 
	display_name VARCHAR NOT NULL, 
	roles JSONB NOT NULL, 
	active BOOLEAN NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (issuer, subject)
)

;

CREATE TABLE audit_events (
	id UUID NOT NULL, 
	actor_id UUID NOT NULL, 
	payload JSONB NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(actor_id) REFERENCES principals (id)
)

;

CREATE TABLE city_grants (
	user_id UUID NOT NULL, 
	city_id UUID NOT NULL, 
	PRIMARY KEY (user_id, city_id), 
	FOREIGN KEY(user_id) REFERENCES principals (id), 
	FOREIGN KEY(city_id) REFERENCES cities (id)
)

;

CREATE TABLE datasets (
	id UUID NOT NULL, 
	city_id UUID NOT NULL, 
	owner_id UUID NOT NULL, 
	access_level VARCHAR NOT NULL, 
	current_version_id UUID, 
	payload JSONB NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(city_id) REFERENCES cities (id), 
	FOREIGN KEY(owner_id) REFERENCES principals (id)
)

;
CREATE INDEX ix_datasets_city_id ON datasets (city_id);

CREATE TABLE web_sessions (
	token_hash VARCHAR(64) NOT NULL, 
	user_id UUID NOT NULL, 
	csrf_token VARCHAR NOT NULL, 
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	encrypted_provider_tokens VARCHAR, 
	PRIMARY KEY (token_hash), 
	FOREIGN KEY(user_id) REFERENCES principals (id)
)

;

CREATE TABLE zones (
	id UUID NOT NULL, 
	city_id UUID NOT NULL, 
	current_version_id UUID NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(city_id) REFERENCES cities (id)
)

;
CREATE INDEX ix_zones_city_id ON zones (city_id);

CREATE TABLE dataset_grants (
	user_id UUID NOT NULL, 
	dataset_id UUID NOT NULL, 
	PRIMARY KEY (user_id, dataset_id), 
	FOREIGN KEY(user_id) REFERENCES principals (id), 
	FOREIGN KEY(dataset_id) REFERENCES datasets (id)
)

;

CREATE TABLE dataset_versions (
	id UUID NOT NULL, 
	dataset_id UUID NOT NULL, 
	status VARCHAR NOT NULL, 
	payload JSONB NOT NULL, 
	synthetic BOOLEAN NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(dataset_id) REFERENCES datasets (id)
)

;
CREATE INDEX ix_dataset_versions_dataset_id ON dataset_versions (dataset_id);

CREATE TABLE scenarios (
	id UUID NOT NULL, 
	city_id UUID NOT NULL, 
	zone_id UUID NOT NULL, 
	owner_id UUID NOT NULL, 
	status VARCHAR NOT NULL, 
	current_revision_id UUID NOT NULL, 
	payload JSONB NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(city_id) REFERENCES cities (id), 
	FOREIGN KEY(zone_id) REFERENCES zones (id), 
	FOREIGN KEY(owner_id) REFERENCES principals (id)
)

;
CREATE INDEX ix_scenarios_zone_id ON scenarios (zone_id);
CREATE INDEX ix_scenarios_city_id ON scenarios (city_id);

CREATE TABLE zone_versions (
	id UUID NOT NULL, 
	zone_id UUID NOT NULL, 
	payload JSONB NOT NULL, 
	synthetic BOOLEAN NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(zone_id) REFERENCES zones (id)
)

;
CREATE INDEX ix_zone_versions_zone_id ON zone_versions (zone_id);

CREATE TABLE scenario_revisions (
	id UUID NOT NULL, 
	scenario_id UUID NOT NULL, 
	zone_version_id UUID NOT NULL, 
	parent_revision_id UUID, 
	payload JSONB NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(scenario_id) REFERENCES scenarios (id), 
	FOREIGN KEY(zone_version_id) REFERENCES zone_versions (id), 
	FOREIGN KEY(parent_revision_id) REFERENCES scenario_revisions (id)
)

;
CREATE INDEX ix_scenario_revisions_scenario_id ON scenario_revisions (scenario_id);

CREATE TABLE jobs (
	id UUID NOT NULL, 
	owner_id UUID NOT NULL, 
	city_id UUID NOT NULL, 
	input_revision_id UUID NOT NULL, 
	state VARCHAR NOT NULL, 
	attempt INTEGER NOT NULL, 
	lease_token VARCHAR, 
	lease_until TIMESTAMP WITH TIME ZONE, 
	payload JSONB NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(owner_id) REFERENCES principals (id), 
	FOREIGN KEY(city_id) REFERENCES cities (id), 
	FOREIGN KEY(input_revision_id) REFERENCES scenario_revisions (id)
)

;
CREATE INDEX ix_jobs_city_id ON jobs (city_id);
CREATE INDEX ix_jobs_state ON jobs (state);

CREATE TABLE revision_datasets (
	revision_id UUID NOT NULL, 
	version_id UUID NOT NULL, 
	PRIMARY KEY (revision_id, version_id), 
	FOREIGN KEY(revision_id) REFERENCES scenario_revisions (id), 
	FOREIGN KEY(version_id) REFERENCES dataset_versions (id)
)

;

CREATE TABLE job_events (
	sequence SERIAL NOT NULL, 
	job_id UUID NOT NULL, 
	payload JSONB NOT NULL, 
	PRIMARY KEY (sequence), 
	FOREIGN KEY(job_id) REFERENCES jobs (id)
)

;
CREATE INDEX ix_job_events_job_id ON job_events (job_id);

CREATE TABLE outbox (
	id UUID NOT NULL, 
	job_id UUID NOT NULL, 
	queue VARCHAR NOT NULL, 
	published_at TIMESTAMP WITH TIME ZONE, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (job_id), 
	FOREIGN KEY(job_id) REFERENCES jobs (id)
)

;
ALTER TABLE principals ADD CONSTRAINT roles_valid CHECK (jsonb_typeof(roles) = 'array' AND jsonb_array_length(roles) > 0 AND roles <@ '["viewer","specialist","admin"]'::jsonb);
ALTER TABLE datasets ADD CONSTRAINT dataset_access_valid CHECK (access_level IN ('public','internal','restricted'));
ALTER TABLE dataset_versions ADD CONSTRAINT dataset_status_valid CHECK (status IN ('quarantine','validating','needs_review','published','rejected'));
ALTER TABLE scenarios ADD CONSTRAINT scenario_status_valid CHECK (status IN ('draft','in_review','approved','archived'));
ALTER TABLE jobs ADD CONSTRAINT job_state_valid CHECK (state IN ('queued','running','succeeded','failed','cancel_requested','cancelled'));
ALTER TABLE jobs ADD CONSTRAINT job_attempt_valid CHECK (attempt BETWEEN 0 AND 3);
ALTER TABLE outbox ADD CONSTRAINT queue_valid CHECK (queue IN ('import','analysis','export','physical'));
ALTER TABLE cities ADD COLUMN geometry geometry(Geometry,4326) GENERATED ALWAYS AS (ST_SetSRID(ST_GeomFromGeoJSON(payload->'boundary'),4326)) STORED;
ALTER TABLE cities ADD CONSTRAINT city_geometry_valid CHECK (ST_IsValid(geometry) AND NOT ST_IsEmpty(geometry));
CREATE INDEX city_geometry_gist ON cities USING gist (geometry);
ALTER TABLE zone_versions ADD COLUMN geometry geometry(Geometry,4326) GENERATED ALWAYS AS (ST_SetSRID(ST_GeomFromGeoJSON(payload->'geometry'),4326)) STORED;
ALTER TABLE zone_versions ADD CONSTRAINT zone_geometry_valid CHECK (ST_IsValid(geometry) AND NOT ST_IsEmpty(geometry) AND ST_GeometryType(geometry) IN ('ST_Polygon','ST_MultiPolygon'));
ALTER TABLE zone_versions ADD CONSTRAINT zone_area_consistent CHECK (abs(ST_Area(ST_Transform(geometry,32643)) - (payload->>'area_m2')::numeric) < 0.1);
CREATE INDEX zone_geometry_gist ON zone_versions USING gist (geometry);
ALTER TABLE zones ADD CONSTRAINT zone_city_unique UNIQUE (id,city_id);
ALTER TABLE scenarios ADD CONSTRAINT scenario_zone_city_fk FOREIGN KEY (zone_id,city_id) REFERENCES zones(id,city_id);
ALTER TABLE zone_versions ADD CONSTRAINT zone_version_identity UNIQUE (zone_id,id);
ALTER TABLE zones ADD CONSTRAINT zone_current_fk FOREIGN KEY (id,current_version_id) REFERENCES zone_versions(zone_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE dataset_versions ADD CONSTRAINT dataset_version_identity UNIQUE (dataset_id,id);
ALTER TABLE datasets ADD CONSTRAINT dataset_current_fk FOREIGN KEY (id,current_version_id) REFERENCES dataset_versions(dataset_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE scenario_revisions ADD CONSTRAINT scenario_revision_identity UNIQUE (scenario_id,id);
ALTER TABLE scenarios ADD CONSTRAINT scenario_current_fk FOREIGN KEY (id,current_revision_id) REFERENCES scenario_revisions(scenario_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE scenario_revisions ADD CONSTRAINT same_scenario_parent_fk FOREIGN KEY (scenario_id,parent_revision_id) REFERENCES scenario_revisions(scenario_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION reject_immutable_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable_record'; END; $$;
CREATE TRIGGER zone_version_immutable BEFORE UPDATE OR DELETE ON zone_versions FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER scenario_revision_immutable BEFORE UPDATE OR DELETE ON scenario_revisions FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER job_event_append_only BEFORE UPDATE OR DELETE ON job_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE FUNCTION protect_published_dataset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status = 'published' THEN RAISE EXCEPTION 'published_dataset_immutable'; END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER dataset_version_immutable BEFORE UPDATE OR DELETE ON dataset_versions FOR EACH ROW EXECUTE FUNCTION protect_published_dataset();
