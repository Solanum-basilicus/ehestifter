"""Canonical Locations v2 selector endpoints."""

import json
import logging

import azure.functions as func

from helpers.locations_search_index import load_locations_search_index
from helpers.locations_v2 import SUPPORTED_KINDS


MAX_QUERY_LENGTH = 120
MAX_RESULTS = 20
MAX_LOOKUP_ITEMS = 200


def _selector(value) -> tuple[str, str] | None:
    if not isinstance(value, dict):
        return None
    kind = str(value.get("kind") or "").strip()
    location_id = str(value.get("locationId") or "").strip()
    if kind not in SUPPORTED_KINDS or not location_id or len(location_id) > 64:
        return None
    return kind, location_id


def register(app: func.FunctionApp):
    @app.route(route="jobs/locations/search", methods=["GET"])
    def search_locations(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("GET /jobs/locations/search")
        try:
            query = str(req.params.get("q") or "").strip()
            if len(query) > MAX_QUERY_LENGTH:
                return func.HttpResponse(
                    f"q must contain at most {MAX_QUERY_LENGTH} characters",
                    status_code=400,
                )
            try:
                limit = int(req.params.get("limit", 8))
            except (TypeError, ValueError):
                return func.HttpResponse("limit must be an integer", status_code=400)
            if limit < 1 or limit > MAX_RESULTS:
                return func.HttpResponse(
                    f"limit must be between 1 and {MAX_RESULTS}",
                    status_code=400,
                )

            index = load_locations_search_index()
            payload = {
                "catalogVersion": index.catalog_version,
                "query": query,
                "items": index.search(query, limit=limit),
            }
            return func.HttpResponse(
                json.dumps(payload),
                status_code=200,
                mimetype="application/json",
            )
        except (FileNotFoundError, ValueError) as exc:
            logging.exception("Locations v2 search index is unavailable")
            return func.HttpResponse(str(exc), status_code=503)
        except Exception as exc:
            logging.exception("GET /jobs/locations/search failed")
            return func.HttpResponse(f"Error: {str(exc)}", status_code=500)

    @app.route(route="jobs/locations/lookup", methods=["POST"])
    def lookup_locations(req: func.HttpRequest) -> func.HttpResponse:
        logging.info("POST /jobs/locations/lookup")
        try:
            try:
                body = req.get_json()
            except ValueError:
                return func.HttpResponse("Invalid JSON", status_code=400)
            if not isinstance(body, dict):
                return func.HttpResponse("Body must be a JSON object", status_code=400)
            unknown = set(body) - {"locations"}
            if unknown:
                return func.HttpResponse(
                    f"Unsupported field: {sorted(unknown)[0]}", status_code=400
                )
            values = body.get("locations", [])
            if not isinstance(values, list):
                return func.HttpResponse("locations must be an array", status_code=400)
            if len(values) > MAX_LOOKUP_ITEMS:
                return func.HttpResponse(
                    f"locations must contain at most {MAX_LOOKUP_ITEMS} items",
                    status_code=400,
                )

            selectors = []
            malformed = []
            for raw in values:
                selector = _selector(raw)
                if selector is None:
                    malformed.append(raw)
                else:
                    selectors.append(selector)

            index = load_locations_search_index()
            items, missing = index.lookup(selectors)
            payload = {
                "catalogVersion": index.catalog_version,
                "items": items,
                "missing": [*malformed, *missing],
            }
            return func.HttpResponse(
                json.dumps(payload),
                status_code=200,
                mimetype="application/json",
            )
        except (FileNotFoundError, ValueError) as exc:
            logging.exception("Locations v2 search index is unavailable")
            return func.HttpResponse(str(exc), status_code=503)
        except Exception as exc:
            logging.exception("POST /jobs/locations/lookup failed")
            return func.HttpResponse(f"Error: {str(exc)}", status_code=500)
