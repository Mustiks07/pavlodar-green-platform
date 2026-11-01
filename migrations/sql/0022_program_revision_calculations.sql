CREATE TABLE program_revision_calculations (
 program_revision_id uuid NOT NULL REFERENCES program_revisions(id),
 calculation_snapshot_id uuid NOT NULL REFERENCES calculation_snapshots(id),
 PRIMARY KEY(program_revision_id,calculation_snapshot_id)
);
CREATE INDEX program_revision_calculation_snapshot_idx
ON program_revision_calculations(calculation_snapshot_id,program_revision_id);

CREATE TRIGGER program_revision_calculation_immutable
BEFORE UPDATE OR DELETE ON program_revision_calculations
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
