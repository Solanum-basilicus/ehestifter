"""Explain geographic selector coverage for the Web preference editor."""

import json
import logging

import azure.functions as func

from helpers.locations_search_index import load_locations_search_index
from helpers.locations_v2 import SUPPORTED_KINDS


MAX_SELECTORS = 100


def _selectors(values, path):
    if not isinstance(values, list):
        raise ValueError(f"{path} must be an array")
    if len(values) > MAX_SELECTORS:
        raise ValueError(f"{path} must contain at most {MAX_SELECTORS} locations")
    output = []
    seen = set()
    for index, raw in enumerate(values):
        if not isinstance(raw, dict):
            raise ValueError(f"{path}[{index}] must be an object")
        unknown = set(raw) - {"kind", "locationId"}
        if unknown:
            raise ValueError(f"{path}[{index}] contains an unsupported field")
        kind = str(raw.get("kind") or "").strip()
        location_id = str(raw.get("locationId") or "").strip()
        if kind not in SUPPORTED_KINDS or not location_id:
            raise ValueError(f"{path}[{index}] is not a valid location selector")
        key = (kind, location_id)
        if key in seen:
            continue
        seen.add(key)
        output.append(key)
    return output


def register(app: func.FunctionApp):
    @app.route(route="jobs/locations/coverage", methods=["POST"])
    def locations_coverage(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("POST /jobs/locations/coverage")
        try:
            try:
                body = req.get_json()
            except ValueError:
                return func.HttpResponse("Invalid JSON", status_code=400)
            if not isinstance(body, dict):
                return func.HttpResponse("Body must be a JSON object", status_code=400)
            unknown = set(body) - {
                "includeLocations",
                "excludeLocations",
                "allowUnknownLocation",
            }
            if unknown:
                return func.HttpResponse(
                    f"Unsupported field: {sorted(unknown)[0]}", status_code=400
                )
            allow_unknown = body.get("allowUnknownLocation", False)
            if not isinstance(allow_unknown, bool):
                return func.HttpResponse(
                    "allowUnknownLocation must be a boolean", status_code=400
                )

            index = load_locations_search_index()
            try:
                included = _selectors(
                    body.get("includeLocations", []), "includeLocations"
                )
                excluded = _selectors(
                    body.get("excludeLocations", []), "excludeLocations"
                )
                payload = index.coverage_preview(included, excluded, allow_unknown)
            except ValueError as exc:
                return func.HttpResponse(str(exc), status_code=400)

            return func.HttpResponse(
                json.dumps(payload), status_code=200, mimetype="application/json"
            )
        except (FileNotFoundError, ValueError) as exc:
            logging.exception("Locations v2 selector index is unavailable")
            return func.HttpResponse(str(exc), status_code=503)
        except Exception as exc:
            logging.exception("POST /jobs/locations/coverage failed")
            return func.HttpResponse(f"Error: {str(exc)}", status_code=500)
