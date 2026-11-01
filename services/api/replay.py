from packages.domain.errors import DomainError
from services.api.models import Dataset, DatasetVersion, Job, RuleVersionRecord, Upload
from services.api.use_cases import (
    authorized_revision,
    found,
    get_scenario,
    get_zone,
    get_zone_version,
)


def authorize_replay(db, access, operation, response):
    if operation in {"createZone", "updateZone"}:
        get_zone(db, access, response["id"])
    elif operation == "createDataset":
        access.dataset(found(db.get(Dataset, response["id"])))
    elif operation == "createUploadTicket":
        upload = found(db.get(Upload, response["upload_id"]))
        access.dataset(found(db.get(Dataset, upload.dataset_id)))
        if upload.owner_id != access.user.id and access.level < 2:
            raise DomainError(404, "not_found", "Object not found")
    elif operation in {
        "startImport",
        "startCalculation",
        "startShadowRun",
        "startExport",
        "sendChatMessage",
    }:
        job = found(db.get(Job, response["id"]))
        access.city(job.city_id)
        if job.owner_id != access.user.id and access.level < 2:
            raise DomainError(404, "not_found", "Object not found")
        from services.worker.jobs import authorize_job_input

        authorize_job_input(db, access, job)
    elif operation == "createChatSession":
        from services.api.chat import session_access

        session_access(db, access, response["id"])
    elif operation == "applyProposal":
        authorized_revision(db, access, response["id"])
    elif operation == "rejectProposal":
        from services.api.proposals import proposal_access

        proposal_access(db, access, response["id"])
    elif operation in {"publishDatasetVersion", "rejectDatasetVersion"}:
        version = found(db.get(DatasetVersion, response["id"]))
        access.dataset(found(db.get(Dataset, version.dataset_id)))
    elif operation in {"grantDatasetAccess", "revokeDatasetAccess"}:
        dataset = found(db.get(Dataset, response["dataset_id"]))
        access.city(dataset.city_id)
    elif operation in {"createScenario", "transitionScenario"}:
        get_scenario(db, access, response["id"])
    elif operation in {"createProgram", "updateProgramDraft"}:
        from services.api.programs import get_program

        get_program(db, access, response["id"])
    elif operation in {"createPlant", "createPlantVersion"}:
        from services.api.catalog import current_plant

        found(current_plant(db, response["id"]))
    elif operation == "recommendPlants":
        get_zone_version(db, access, response["zone_version_id"])
        rule = found(db.get(RuleVersionRecord, response["rule_version_id"]))
        dataset = found(db.get(Dataset, rule.dataset_id))
        access.dataset(dataset)
    elif operation == "createRateVersion":
        from services.api.calculations import authorize_rate

        authorize_rate(db, access, response["version_id"])
    elif operation == "calculateFast":
        from services.api.calculations import authorized_snapshot

        authorized_snapshot(db, access, response["snapshot"]["id"])
    elif operation == "compareScenarios":
        from services.api.calculations import authorized_snapshot

        for snapshot in response["snapshots"]:
            authorized_snapshot(db, access, snapshot["id"])
    elif operation == "createScenarioRevision":
        authorized_revision(db, access, response["id"])
    elif operation == "cancelJob":
        job = found(db.get(Job, response["id"]))
        access.city(job.city_id)
        if job.owner_id != access.user.id and access.level < 2:
            raise DomainError(404, "not_found", "Object not found")
        from services.worker.jobs import authorize_job_input

        authorize_job_input(db, access, job)
    elif operation != "logout":
        raise DomainError(500, "replay_policy_missing", "Operation replay policy is missing")
