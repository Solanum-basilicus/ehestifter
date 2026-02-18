import azure.functions as func
from helpers.http_json import parse_json, json_response, json_error
from helpers.core_client import get_run, get_latest_id, lease_run, get_input
from helpers.errors import CoreHttpError
from helpers.lease_logic import compute_lease, is_latest

def register(app: func.FunctionApp):
    @app.route(route="work/lease", methods=["POST"])
    def work_lease(req: func.HttpRequest) -> func.HttpResponse:
        ok, body, err = parse_json(req)
        if not ok:
            return err
        if not isinstance(body, dict) or not body.get("runId"):
            return func.HttpResponse("Missing runId", status_code=400)

        run_id = body["runId"]

        try:
            run = get_run(run_id)
        except CoreHttpError as e:
            if e.status_code == 404:
                return func.HttpResponse("Not found", status_code=404)
            return json_error("CORE_ERROR", 502, e.body)

        # latest-run rule
        try:
            latest_id = get_latest_id(run["subjectKey"], run["enricherType"])
        except CoreHttpError as e:
            if e.status_code == 404:
                return json_error("NOT_LATEST", 409)
            return json_error("CORE_ERROR", 502, e.body)

        if not is_latest(run, latest_id):
            return json_error("NOT_LATEST", 409)

        lease_token, lease_until = compute_lease()

        try:
            conflict = lease_run(run_id, lease_token, lease_until)
        except CoreHttpError as e:
            if e.status_code == 404:
                return func.HttpResponse("Not found", status_code=404)
            return json_error("CORE_ERROR", 502, e.body)

        if conflict:
            return json_response({"code": conflict}, status_code=409)

        # Fetch input snapshot
        try:
            snapshot = get_input(run_id)
        except CoreHttpError as e:
            # If snapshot missing, surface as conflict so worker can drop or retry depending on your preference.
            if e.status_code == 409:
                return json_error("SNAPSHOT_MISSING", 409, e.body)
            if e.status_code == 404:
                return json_error("BLOB_NOT_FOUND", 404, e.body)
            return json_error("CORE_ERROR", 502, e.body)

        return json_response(
            {
                "runId": run_id,
                "leaseToken": lease_token,
                "leaseUntil": lease_until,
                "enricherType": run["enricherType"],
                "subjectKey": run["subjectKey"],
                "input": snapshot,
            },
            status_code=200,
        )
