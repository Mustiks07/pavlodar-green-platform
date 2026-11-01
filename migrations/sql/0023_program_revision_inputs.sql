ALTER TABLE program_revisions ADD COLUMN input_version_id uuid;

UPDATE program_revisions pr
SET input_version_id = (
 SELECT piv.id
 FROM program_input_versions piv
 WHERE piv.program_id=pr.program_id
   AND piv.payload=pr.payload->'input_snapshot'
 ORDER BY piv.created_at DESC,piv.id
 LIMIT 1
);

ALTER TABLE program_revisions ALTER COLUMN input_version_id SET NOT NULL;
ALTER TABLE program_revisions ADD CONSTRAINT program_revision_input_fk
FOREIGN KEY(program_id,input_version_id) REFERENCES program_input_versions(program_id,id);
CREATE INDEX program_revisions_input_idx ON program_revisions(input_version_id,id);
