CREATE TABLE proposals (
 id uuid PRIMARY KEY,
 scenario_id uuid NOT NULL REFERENCES scenarios(id),
 base_revision_id uuid NOT NULL REFERENCES scenario_revisions(id),
 owner_id uuid NOT NULL REFERENCES principals(id),
 assistant_message_id uuid NOT NULL UNIQUE REFERENCES chat_messages(id),
 status varchar NOT NULL CHECK (status IN ('pending','applied','rejected','expired')),
 summary varchar NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
 proposed_revision jsonb NOT NULL CHECK (jsonb_typeof(proposed_revision)='object'),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL,
 decided_at timestamptz,
 decision_reason varchar CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 2000),
 CHECK ((status='pending' AND decided_at IS NULL AND decision_reason IS NULL)
        OR (status='applied' AND decided_at IS NOT NULL AND decision_reason IS NULL)
        OR (status IN ('rejected','expired') AND decided_at IS NOT NULL))
);
CREATE INDEX proposal_owner ON proposals(owner_id,created_at,id);
CREATE INDEX proposal_scenario ON proposals(scenario_id,status,expires_at,id);

ALTER TABLE chat_messages
ADD CONSTRAINT chat_message_proposal_fk
FOREIGN KEY (proposal_id) REFERENCES proposals(id);
