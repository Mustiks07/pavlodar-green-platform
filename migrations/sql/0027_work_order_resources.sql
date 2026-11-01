ALTER TABLE work_orders ADD COLUMN care_operation_id uuid;
ALTER TABLE work_orders ADD COLUMN resource_period varchar;

UPDATE work_orders
SET care_operation_id = NULLIF(payload->>'care_operation_id','')::uuid,
    resource_period = NULLIF(payload->>'resource_period','')
WHERE payload ? 'care_operation_id' OR payload ? 'resource_period';

CREATE UNIQUE INDEX work_orders_care_operation_unique
ON work_orders(scenario_revision_id,care_operation_id)
WHERE care_operation_id IS NOT NULL;
CREATE INDEX work_orders_resource_period_idx
ON work_orders(scenario_revision_id,resource_period,id)
WHERE resource_period IS NOT NULL;
