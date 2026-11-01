ALTER TABLE cohorts ADD COLUMN placement_id uuid;

DO $$
BEGIN
 IF EXISTS (
   SELECT 1
   FROM cohorts c
   JOIN work_orders w ON w.id=c.source_work_order_id
   JOIN scenario_revisions sr ON sr.id=w.scenario_revision_id
   CROSS JOIN LATERAL (
     SELECT count(*) AS matches
     FROM jsonb_array_elements(sr.payload->'placements') placement
     WHERE placement->>'plant_id'=c.plant_id::text
       AND (placement->>'quantity')::numeric=c.initial_quantity
   ) candidate
   WHERE candidate.matches<>1
 ) THEN
   RAISE EXCEPTION 'existing cohort does not resolve to exactly one placement';
 END IF;
END;
$$;

UPDATE cohorts c
SET placement_id = (
 SELECT (placement->>'id')::uuid
 FROM work_orders w
 JOIN scenario_revisions sr ON sr.id=w.scenario_revision_id
 CROSS JOIN jsonb_array_elements(sr.payload->'placements') placement
 WHERE w.id=c.source_work_order_id
   AND placement->>'plant_id'=c.plant_id::text
   AND (placement->>'quantity')::numeric=c.initial_quantity
);

ALTER TABLE cohorts ALTER COLUMN placement_id SET NOT NULL;
CREATE INDEX cohorts_placement_idx ON cohorts(placement_id,id);

CREATE OR REPLACE FUNCTION protect_cohort_identity() RETURNS trigger AS $$
BEGIN
 IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.city_id IS DISTINCT FROM NEW.city_id
    OR OLD.zone_id IS DISTINCT FROM NEW.zone_id
    OR OLD.plant_id IS DISTINCT FROM NEW.plant_id
    OR OLD.placement_id IS DISTINCT FROM NEW.placement_id
    OR OLD.initial_quantity IS DISTINCT FROM NEW.initial_quantity
    OR OLD.planting_date IS DISTINCT FROM NEW.planting_date
    OR OLD.replaces_cohort_id IS DISTINCT FROM NEW.replaces_cohort_id
    OR OLD.source_work_order_id IS DISTINCT FROM NEW.source_work_order_id THEN
   RAISE EXCEPTION 'cohort identity is immutable';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
