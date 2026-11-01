CREATE TABLE cohorts (
 id uuid PRIMARY KEY,
 city_id uuid NOT NULL REFERENCES cities(id),
 zone_id uuid NOT NULL REFERENCES zones(id),
 plant_id uuid NOT NULL REFERENCES plant_identities(id),
 initial_quantity integer NOT NULL CHECK (initial_quantity > 0),
 planting_date date NOT NULL,
 replaces_cohort_id uuid REFERENCES cohorts(id),
 source_work_order_id uuid NOT NULL UNIQUE REFERENCES work_orders(id),
 latest_inspection_id uuid
);
CREATE INDEX cohorts_city_idx ON cohorts(city_id,id);
CREATE INDEX cohorts_zone_idx ON cohorts(zone_id,id);
CREATE INDEX cohorts_replaces_idx ON cohorts(replaces_cohort_id,id)
WHERE replaces_cohort_id IS NOT NULL;

CREATE TABLE inspections (
 id uuid PRIMARY KEY,
 city_id uuid NOT NULL REFERENCES cities(id),
 zone_id uuid NOT NULL REFERENCES zones(id),
 cohort_id uuid NOT NULL REFERENCES cohorts(id),
 actor_id uuid NOT NULL REFERENCES principals(id),
 observed_at timestamptz NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE INDEX inspections_city_idx ON inspections(city_id,id);
CREATE INDEX inspections_cohort_idx ON inspections(cohort_id,observed_at,id);

ALTER TABLE cohorts ADD CONSTRAINT cohort_latest_inspection_fk
FOREIGN KEY(latest_inspection_id) REFERENCES inspections(id)
DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION protect_cohort_identity() RETURNS trigger AS $$
BEGIN
 IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.city_id IS DISTINCT FROM NEW.city_id
    OR OLD.zone_id IS DISTINCT FROM NEW.zone_id
    OR OLD.plant_id IS DISTINCT FROM NEW.plant_id
    OR OLD.initial_quantity IS DISTINCT FROM NEW.initial_quantity
    OR OLD.planting_date IS DISTINCT FROM NEW.planting_date
    OR OLD.replaces_cohort_id IS DISTINCT FROM NEW.replaces_cohort_id
    OR OLD.source_work_order_id IS DISTINCT FROM NEW.source_work_order_id THEN
   RAISE EXCEPTION 'cohort identity is immutable';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cohort_identity_immutable
BEFORE UPDATE ON cohorts
FOR EACH ROW EXECUTE FUNCTION protect_cohort_identity();
CREATE TRIGGER cohort_delete_forbidden
BEFORE DELETE ON cohorts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER inspection_immutable
BEFORE UPDATE OR DELETE ON inspections
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
