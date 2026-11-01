ALTER TABLE jobs DROP CONSTRAINT job_input_kind_valid;
ALTER TABLE jobs DROP CONSTRAINT job_input_shape_valid;

ALTER TABLE jobs ADD CONSTRAINT job_input_kind_valid
CHECK (input_kind IN ('revision','upload','program','calculation','program_revision','chat_session'));

ALTER TABLE jobs ADD CONSTRAINT job_input_shape_valid CHECK (
 (input_kind='revision' AND input_revision_id=input_ref_id) OR
 (input_kind IN ('upload','program','calculation','program_revision','chat_session')
  AND input_revision_id IS NULL)
);

CREATE TABLE chat_sessions (
 id uuid PRIMARY KEY,
 city_id uuid NOT NULL REFERENCES cities(id),
 owner_id uuid NOT NULL REFERENCES principals(id),
 zone_id uuid REFERENCES zones(id),
 scenario_revision_id uuid REFERENCES scenario_revisions(id),
 created_at timestamptz NOT NULL
);
CREATE INDEX chat_session_owner ON chat_sessions(owner_id,created_at,id);
CREATE INDEX chat_session_city ON chat_sessions(city_id,id);

CREATE TABLE chat_messages (
 id uuid PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES chat_sessions(id),
 job_id uuid UNIQUE REFERENCES jobs(id),
 role varchar NOT NULL CHECK (role IN ('user','assistant')),
 state varchar NOT NULL CHECK (state IN ('queued','streaming','completed','failed','cancelled')),
 text varchar NOT NULL CHECK (length(text) <= 20000),
 facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='array'),
 proposal_id uuid,
 provider varchar,
 model varchar,
 input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
 output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
 created_at timestamptz NOT NULL
);
CREATE INDEX chat_message_session ON chat_messages(session_id,created_at,id);
