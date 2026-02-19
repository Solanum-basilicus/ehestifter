import azure.functions as func
from helpers.http_json import parse_json, json_response
from helpers.sb_client import send_dispatch_message

def register(app: func.FunctionApp):
    @app.route(route="gateway/dispatch", methods=["POST"])
    def gateway_dispatch(req: func.HttpRequest) -> func.HttpResponse:
        ok, body, err = parse_json(req)
        if not ok:
            return err

        if not isinstance(body, dict) or not body.get("runId"):
            return func.HttpResponse("Missing runId", status_code=400)

        try:
            message_id = send_dispatch_message(body)
        except Exception as e:
            logging.exception("SB dispatch failed")
            return func.HttpResponse(json.dumps({"code":"SB_DISPATCH_FAILED","message":str(e)}),
                                    mimetype="application/json", status_code=502)

        return json_response({"messageId": message_id, "runId": body.get("runId")}, status_code=202)
