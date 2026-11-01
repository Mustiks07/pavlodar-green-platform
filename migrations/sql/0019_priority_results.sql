CREATE TABLE priority_results (
 id uuid PRIMARY KEY,
 city_id uuid NOT NULL REFERENCES cities(id),
 actor_id uuid NOT NULL REFERENCES principals(id),
 normalization_version_id uuid NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE INDEX priority_results_city_idx ON priority_results(city_id,created_at DESC,id);
CREATE INDEX priority_results_normalization_idx
ON priority_results(normalization_version_id,created_at DESC,id);

CREATE TRIGGER priority_result_immutable
BEFORE UPDATE OR DELETE ON priority_results
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
