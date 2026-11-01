CREATE TABLE stock_item_versions (
 id uuid PRIMARY KEY,
 plant_id uuid NOT NULL REFERENCES plant_identities(id),
 city_id uuid NOT NULL REFERENCES cities(id),
 dataset_id uuid NOT NULL REFERENCES datasets(id),
 dataset_version_id uuid NOT NULL REFERENCES dataset_versions(id),
 payload jsonb NOT NULL
);
CREATE INDEX stock_item_plant ON stock_item_versions(plant_id,id);
CREATE INDEX stock_item_city ON stock_item_versions(city_id,id);
CREATE INDEX stock_item_dataset ON stock_item_versions(dataset_id,id);
CREATE INDEX stock_item_dataset_version ON stock_item_versions(dataset_version_id,id);

CREATE TRIGGER stock_item_version_immutable BEFORE UPDATE OR DELETE ON stock_item_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
