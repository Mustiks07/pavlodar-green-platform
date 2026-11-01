CREATE TABLE problem_decisions (
 problem_id uuid PRIMARY KEY,
 zone_id uuid NOT NULL REFERENCES zones(id),
 actor_id uuid NOT NULL REFERENCES principals(id),
 status varchar NOT NULL CHECK (status IN ('acknowledged','dismissed')),
 reason varchar NOT NULL CHECK (length(trim(reason)) > 0),
 decided_at timestamptz NOT NULL
);
CREATE INDEX problem_decision_zone ON problem_decisions(zone_id,problem_id);

CREATE TRIGGER problem_decision_immutable BEFORE UPDATE OR DELETE ON problem_decisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
