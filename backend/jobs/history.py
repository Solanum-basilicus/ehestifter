# history.py
import json
import base64
from datetime import datetime

class DatetimeEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        return super().default(obj)

def insert_history(cursor, job_id: str, action: str, details_obj, actor_type: str, actor_id):
    payload = {"v": 1, "kind": action, "data": details_obj or {}}
    cursor.execute("""
        INSERT INTO dbo.JobOfferingHistory (JobOfferingId, ActorType, ActorId, Action, Details, Timestamp)
        VALUES (?, ?, ?, ?, ?, SYSDATETIME())
    """, (job_id, actor_type, actor_id, action, json.dumps(payload, cls=DatetimeEncoder)))

def make_history_cursor(ts: datetime, row_id: str) -> str:
    raw = f"{ts.isoformat()}|{row_id}"
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")

def parse_history_cursor(cursor: str):
    raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
    ts_str, rid = raw.split("|", 1)
    return datetime.fromisoformat(ts_str), rid
