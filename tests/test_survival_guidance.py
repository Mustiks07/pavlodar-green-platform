from types import SimpleNamespace

from packages.domain.contracts import validate
from services.api.calculations import _survival_guidance
from services.api.models import ImportRecord

VERSION_ID = "11111111-1111-4111-8111-111111111111"


class ScalarRows:
    def __init__(self, rows):
        self.rows = rows

    def all(self):
        return self.rows


class FakeDb:
    def __init__(self, rows):
        self.rows = rows

    def scalars(self, _query):
        return ScalarRows(self.rows)


def test_survival_guidance_comes_from_exact_model_source_record():
    source_ref = {
        "dataset_version_id": VERSION_ID,
        "source_record_id": "survival-profile",
        "label": "SYNTHETIC TEST survival model",
        "uri": None,
    }
    model = SimpleNamespace(
        dataset_version_id=VERSION_ID,
        payload={"source_refs": [source_ref]},
    )
    record = ImportRecord(
        version_id=VERSION_ID,
        row_index=0,
        payload={
            "source_record_id": "survival-profile",
            "properties": {
                "survival_guidance": [
                    {
                        "kind": "risk",
                        "factor": "Дефицит влаги",
                        "score": 0.9,
                        "weight": 0,
                        "explanation": "Требует внимания в первый сезон.",
                    },
                    {
                        "kind": "measure",
                        "factor": "Полив по календарю",
                        "score": 0.8,
                        "weight": 0,
                        "explanation": "Выполнять работы после осмотра.",
                    },
                    {
                        "kind": "risk",
                        "factor": "Некорректная строка",
                        "score": "NaN",
                        "weight": 0,
                        "explanation": "Не должна попасть в результат.",
                    },
                ]
            },
        },
    )

    guidance = _survival_guidance(FakeDb([record]), model)

    assert [item["factor"] for item in guidance] == [
        "risk:Дефицит влаги",
        "measure:Полив по календарю",
    ]
    assert all(item["source_refs"] == [source_ref] for item in guidance)
    for item in guidance:
        validate("Contribution", item)


def test_survival_guidance_does_not_use_unfrozen_records():
    model = SimpleNamespace(dataset_version_id=VERSION_ID, payload={"source_refs": []})
    assert _survival_guidance(FakeDb([]), model) == []
