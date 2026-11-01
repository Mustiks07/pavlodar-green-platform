"""Explicit local admin import of the reviewed research delivery."""

import argparse
import json
from pathlib import Path

from services.api.db import session
from services.api.research import import_delivery

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--actor-id", required=True)
    parser.add_argument("--grant-user", action="append", default=[])
    args = parser.parse_args()
    with session() as db, db.begin():
        result = import_delivery(db, Path(__file__).parents[2], args.actor_id, args.grant_user)
    print(json.dumps(result))
