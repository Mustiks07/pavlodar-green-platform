"""Build one bounded PMTiles v3 archive from a current public map layer."""

import argparse
import json
from pathlib import Path
from uuid import UUID

from services.api.config import settings
from services.api.db import session
from services.worker.pmtiles import build_archive, register_archive


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--layer-id", required=True, type=UUID)
    parser.add_argument("--min-zoom", required=True, type=int)
    parser.add_argument("--max-zoom", required=True, type=int)
    parser.add_argument("--max-candidate-tiles", type=int, default=20_000)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main():
    args = parse_args()
    layer_id = str(args.layer_id)
    registered = args.output is None
    with session() as db, db.begin():
        if registered:
            result = register_archive(
                db,
                layer_id,
                Path(settings().tile_root),
                min_zoom=args.min_zoom,
                max_zoom=args.max_zoom,
                max_candidate_tiles=args.max_candidate_tiles,
            )
        else:
            result = build_archive(
                db,
                layer_id,
                args.output,
                min_zoom=args.min_zoom,
                max_zoom=args.max_zoom,
                max_candidate_tiles=args.max_candidate_tiles,
            )
    print(
        json.dumps(
            {
                "path": str(result.path),
                "sha256": result.sha256,
                "byte_size": result.byte_size,
                "tile_count": result.tile_count,
                "candidate_tile_count": result.candidate_tile_count,
                "min_zoom": result.min_zoom,
                "max_zoom": result.max_zoom,
                "registered": registered,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
