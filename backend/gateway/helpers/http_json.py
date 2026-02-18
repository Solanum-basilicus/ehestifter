import json
from typing import Any, Dict, Tuple
import azure.functions as func

def parse_json(req: func.HttpRequest) -> Tuple[bool, Any, func.HttpResponse | None]:
    try:
        body = req.get_json()
        return True, body, None
    except Exception:
        return False, None, func.HttpResponse("Invalid JSON body", status_code=400)

def json_response(obj: Any, status_code: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(obj), mimetype="application/json", status_code=status_code)

def json_error(code: str, status_code: int, message: str | None = None) -> func.HttpResponse:
    payload: Dict[str, Any] = {"code": code}
    if message:
        payload["message"] = message
    return json_response(payload, status_code=status_code)
