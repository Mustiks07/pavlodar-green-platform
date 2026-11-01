CREATE TABLE spatial_results (
 id uuid PRIMARY KEY,
 scenario_revision_id uuid NOT NULL REFERENCES scenario_revisions(id),
 city_id uuid NOT NULL REFERENCES cities(id),
 job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
 kind varchar NOT NULL CHECK (kind IN ('shadow','invest_air','solweig_tmrt')),
 payload jsonb NOT NULL,
 artifact jsonb,
 created_at timestamptz NOT NULL
);
CREATE INDEX spatial_results_revision_idx
ON spatial_results (scenario_revision_id, created_at DESC);
CREATE INDEX spatial_results_city_idx ON spatial_results (city_id);

CREATE TRIGGER spatial_results_immutable BEFORE UPDATE OR DELETE ON spatial_results
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
