DROP TRIGGER map_layer_immutable ON map_layers;

UPDATE map_layers
SET payload = jsonb_set(payload, '{dataset_id}', to_jsonb(dataset_id::text), true)
WHERE payload->>'dataset_id' IS DISTINCT FROM dataset_id::text;

CREATE TRIGGER map_layer_immutable BEFORE UPDATE OR DELETE ON map_layers
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();

