CREATE TABLE work_orders (
 id uuid PRIMARY KEY,
 city_id uuid NOT NULL REFERENCES cities(id),
 zone_id uuid NOT NULL REFERENCES zones(id),
 scenario_revision_id uuid NOT NULL REFERENCES scenario_revisions(id),
 owner_id uuid NOT NULL REFERENCES principals(id),
 status varchar NOT NULL CHECK (status IN ('planned','assigned','in_progress','completed','cancelled')),
 payload jsonb NOT NULL,
 updated_at timestamptz NOT NULL
);
CREATE INDEX work_orders_city_idx ON work_orders(city_id,id);
CREATE INDEX work_orders_zone_idx ON work_orders(zone_id,id);
CREATE INDEX work_orders_revision_idx ON work_orders(scenario_revision_id,id);

CREATE TABLE work_order_status_events (
 id uuid PRIMARY KEY,
 work_order_id uuid NOT NULL REFERENCES work_orders(id),
 actor_id uuid NOT NULL REFERENCES principals(id),
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE INDEX work_order_status_events_order_idx
ON work_order_status_events(work_order_id,created_at,id);

CREATE TABLE work_completions (
 id uuid PRIMARY KEY,
 work_order_id uuid NOT NULL REFERENCES work_orders(id),
 correction_of_id uuid UNIQUE REFERENCES work_completions(id),
 actor_id uuid NOT NULL REFERENCES principals(id),
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE INDEX work_completions_order_idx ON work_completions(work_order_id,id);

CREATE TRIGGER work_order_status_event_immutable
BEFORE UPDATE OR DELETE ON work_order_status_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER work_completion_immutable
BEFORE UPDATE OR DELETE ON work_completions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
