CREATE TABLE programs (
 id uuid PRIMARY KEY,
 city_id uuid NOT NULL REFERENCES cities(id),
 owner_id uuid NOT NULL REFERENCES principals(id),
 status varchar NOT NULL CHECK (status IN ('draft','in_review','approved','archived')),
 current_input_version_id uuid NOT NULL,
 current_revision_id uuid,
 payload jsonb NOT NULL,
 updated_at timestamptz NOT NULL
);
CREATE INDEX programs_city_idx ON programs(city_id,id);

CREATE TABLE program_input_versions (
 id uuid PRIMARY KEY,
 program_id uuid NOT NULL REFERENCES programs(id),
 parent_id uuid,
 actor_id uuid NOT NULL REFERENCES principals(id),
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 UNIQUE(program_id,id),
 FOREIGN KEY(program_id,parent_id) REFERENCES program_input_versions(program_id,id)
   DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX program_input_versions_program_idx
ON program_input_versions(program_id,created_at DESC,id);

CREATE TABLE program_input_candidates (
 input_version_id uuid NOT NULL REFERENCES program_input_versions(id),
 scenario_revision_id uuid NOT NULL REFERENCES scenario_revisions(id),
 PRIMARY KEY(input_version_id,scenario_revision_id)
);
CREATE INDEX program_input_candidates_revision_idx
ON program_input_candidates(scenario_revision_id,input_version_id);

CREATE TABLE program_revisions (
 id uuid PRIMARY KEY,
 program_id uuid NOT NULL REFERENCES programs(id),
 job_id uuid UNIQUE REFERENCES jobs(id),
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 UNIQUE(program_id,id)
);
CREATE INDEX program_revisions_program_idx ON program_revisions(program_id,created_at DESC,id);

ALTER TABLE programs ADD CONSTRAINT program_current_input_fk
FOREIGN KEY(id,current_input_version_id) REFERENCES program_input_versions(program_id,id)
DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE programs ADD CONSTRAINT program_current_revision_fk
FOREIGN KEY(id,current_revision_id) REFERENCES program_revisions(program_id,id)
DEFERRABLE INITIALLY DEFERRED;

CREATE TRIGGER program_input_version_immutable
BEFORE UPDATE OR DELETE ON program_input_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER program_input_candidate_immutable
BEFORE UPDATE OR DELETE ON program_input_candidates
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER program_revision_immutable
BEFORE UPDATE OR DELETE ON program_revisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
