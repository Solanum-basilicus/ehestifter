# ./routes/ui_reports_status.py
from flask import Blueprint, request, Response, jsonify
from datetime import datetime, timedelta, timezone
from io import StringIO
import csv
import requests
from zoneinfo import ZoneInfo  # py3.9+

from helpers.http import jobs_base, jobs_fx_headers
from helpers.users import get_in_app_user_id

ISO_IN = ("%Y-%m-%d", "%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S")

def _parse_iso(s: str):
    if not s: return None
    for fmt in ISO_IN:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    # last try: fromisoformat (may include subseconds)
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


def _range_to_start(range_name: str):
    now = datetime.utcnow()
    if range_name == "day":   return now - timedelta(days=1)
    if range_name == "week":  return now - timedelta(days=7)
    if range_name == "month": return now - timedelta(days=30)
    return None

def _filename(prefix: str, start: datetime, end: datetime|None, ext: str):
    s = start.strftime("%Y%m%dT%H%M")
    e = (end.strftime("%Y%m%dT%H%M") if end else "now")
    return f"{prefix}_{s}_{e}.{ext}"

def _pick_tz(tz_param: str|None):
    # Browser-provided tz (e.g., "Europe/Berlin") preferred
    if tz_param and ZoneInfo:
        try:
            return ZoneInfo(tz_param)
        except Exception:
            pass
    # Fallback to project’s common tz if available
    if ZoneInfo:
        try:
            return ZoneInfo("Europe/Berlin")
        except Exception:
            pass
    return timezone.utc

def _to_local_dt(iso_str: str, tzinfo):
    # Jobs API returns ISO without tz. Treat as UTC if naive.
    try:
        dt = datetime.fromisoformat(iso_str)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        return dt.astimezone(tzinfo)
    except Exception:
        return dt  # best effort

def _fmt_ui_like(dt_local: datetime, now_local: datetime):
    """
    UI-ish formatting:
      <15 min: "just now"
      same day: "HH:MM"
      <7 days: "DD Mon at HH:MM"
      same year: "DD Mon"
      else: "DD Mon YYYY"
    Month is abbreviated per C locale (e.g., 'Sep').
    """
    if not dt_local:
        return ""
    diff = (dt_local - now_local).total_seconds()
    abs_min = abs(diff) / 60.0
    if abs_min < 15:
        return "just now"

    same_day = dt_local.date() == now_local.date()
    if same_day:
        return dt_local.strftime("today at %H:%M")

    abs_days = abs((dt_local - now_local).total_seconds()) / 86400.0
    if abs_days < 7:
        return dt_local.strftime("on %d %b at %H:%M")

    if dt_local.year == now_local.year:
        return dt_local.strftime("on %d %b")

    return dt_local.strftime("on %d %b %Y")

def _merge_company(posting: str, hiring: str):
    posting = (posting or "").strip()
    hiring_raw = (hiring or "").strip()
    hiring_disp = hiring_raw or "Unknown"
    if posting:
        return f"{hiring_disp} (through talent agency {posting})"
    # if hiring empty: show only posting (or Unknown if even posting is empty)
    return posting or hiring_disp

def _to_csv(payload: dict, tzinfo) -> tuple[str, str]:
    """
    Columns (both modes):
      Position name, Company, History, Link to job description
    """
    start = _parse_iso(payload.get("start"))
    end   = _parse_iso(payload.get("end"))
    aggregate = bool(payload.get("aggregate"))
    items = payload.get("items", [])

    now_local = datetime.now(tzinfo)

    buf = StringIO()
    headers = ["Position name", "Company", "History", "Link to job description"]
    writer = csv.DictWriter(buf, fieldnames=headers)
    writer.writeheader()

    if not aggregate:
        for it in items:
            title = it.get("jobTitle","") or ""
            posting = it.get("postingCompanyName","") or ""
            hiring  = it.get("hiringCompanyName","") or ""
            url     = it.get("url","") or ""
            status  = it.get("status","") or ""
            ts_iso  = it.get("timestamp","") or ""
            dt_loc  = _to_local_dt(ts_iso, tzinfo)
            when    = _fmt_ui_like(dt_loc, now_local)
            company = _merge_company(posting, hiring)

            writer.writerow({
                "Position name": title,
                "Company": company,
                "History": f"{status} {when}".strip(),
                "Link to job description": url,
            })
        fname = _filename("status_report", start or now_local, end, "csv")
        return buf.getvalue(), fname

    # aggregated
    for it in items:
        title = it.get("jobTitle","") or ""
        posting = it.get("postingCompanyName","") or ""
        hiring  = it.get("hiringCompanyName","") or ""
        url     = it.get("url","") or ""
        sts     = it.get("statuses") or []
        parts = []
        for s in sts:
            st = s.get("status","") or ""
            ts_iso = s.get("timestamp","") or ""
            dt_loc = _to_local_dt(ts_iso, tzinfo)
            when   = _fmt_ui_like(dt_loc, now_local)
            parts.append(f"{st} {when}".strip())
        history = ", ".join(parts)

        writer.writerow({
            "Position name": title,
            "Company": _merge_company(posting, hiring),
            "History": history,
            "Link to job description": url,
        })

    fname = _filename("status_report_agg", start or now_local, end, "csv")
    return buf.getvalue(), fname

def _to_text(payload: dict, tzinfo) -> tuple[str, str]:
    start = _parse_iso(payload.get("start"))
    end   = _parse_iso(payload.get("end"))
    aggregate = bool(payload.get("aggregate"))
    items = payload.get("items", [])
    now_local = datetime.now(tzinfo)

    lines = []
    if not aggregate:
        for it in items:
            title = it.get("jobTitle","") or ""
            posting = it.get("postingCompanyName","") or ""
            hiring  = it.get("hiringCompanyName","") or ""
            url     = it.get("url","") or ""
            status  = it.get("status","") or ""
            ts_iso  = it.get("timestamp","") or ""
            dt_loc  = _to_local_dt(ts_iso, tzinfo)
            when    = _fmt_ui_like(dt_loc, now_local)
            company = _merge_company(posting, hiring)
            lines.append(f"- {title} | {company} | {status} at {when} | {url}")
        fname = _filename("status_report", start or now_local, end, "txt")
        return "\n".join(lines) + ("\n" if lines else ""), fname

    for it in items:
        title = it.get("jobTitle","") or ""
        posting = it.get("postingCompanyName","") or ""
        hiring  = it.get("hiringCompanyName","") or ""
        url     = it.get("url","") or ""
        company = _merge_company(posting, hiring)
        lines.append(f"* {title} | {company}")
        for s in (it.get("statuses") or []):
            st = s.get("status","") or ""
            ts_iso = s.get("timestamp","") or ""
            dt_loc = _to_local_dt(ts_iso, tzinfo)
            when   = _fmt_ui_like(dt_loc, now_local)
            lines.append(f"  - {st} at {when}")
        lines.append(f"  Link: {url}")
    fname = _filename("status_report_agg", start or now_local, end, "txt")
    return "\n".join(lines) + ("\n" if lines else ""), fname


def create_blueprint(auth):
    bp = Blueprint("ui_reports_status", __name__)

    @bp.route("/ui/reports/status", methods=["GET"])
    @auth.login_required
    def ui_reports_status(*, context):
        # Inputs
        fmt = (request.args.get("format") or "csv").lower()
        aggregate = (request.args.get("aggregate") or "false").lower() in ("1","true","yes","on")
        q_range = (request.args.get("range") or "").lower()

        start_raw = request.args.get("start")
        end_raw   = request.args.get("end")
        tz_param  = request.args.get("tz")

        # Resolve timezone (browser > project fallback > UTC)
        tzinfo = _pick_tz(tz_param)

        # Compute start/end
        if q_range:
            start_dt = _range_to_start(q_range)
            if not start_dt:
                return jsonify({"error":"bad_request","message":"Invalid range"}), 400
            start = start_dt.replace(microsecond=0).isoformat()
            end = None
        else:
            start_dt = _parse_iso(start_raw or "")
            if not start_dt:
                return jsonify({"error":"bad_request","message":"Missing or invalid 'start'"}), 400
            start = start_dt.replace(microsecond=0).isoformat()
            end_dt = _parse_iso(end_raw or "")
            end = end_dt.replace(microsecond=0).isoformat() if end_dt else None

        # Call jobs API
        uid = get_in_app_user_id(context)
        headers = jobs_fx_headers(context={"userId": uid})

        params = {"start": start, "aggregate": "true" if aggregate else "false"}
        if end: params["end"] = end

        r = requests.get(f"{jobs_base()}/jobs/reports/status", headers=headers, params=params, timeout=15)
        if not r.ok:
            return r.text, r.status_code, {"Content-Type": r.headers.get("Content-Type","text/plain")}

        payload = r.json()

        # Transform
        if fmt == "csv":
            text, fname = _to_csv(payload, tzinfo)
            resp = Response(text, mimetype="text/csv; charset=utf-8")
            resp.headers["Content-Disposition"] = f'attachment; filename="{fname}"'
            return resp

        if fmt in ("txt","text"):
            text, fname = _to_text(payload, tzinfo)
            resp = Response(text, mimetype="text/plain; charset=utf-8")
            resp.headers["Content-Disposition"] = f'attachment; filename="{fname}"'
            return resp

        return jsonify({"error":"bad_request","message":"Unsupported format"}), 400

    return bp
