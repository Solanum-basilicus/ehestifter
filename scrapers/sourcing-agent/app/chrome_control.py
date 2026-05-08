import json
import time
import urllib.parse
import urllib.request
from pathlib import Path
import itertools
from websocket import create_connection

_cdp_counter = itertools.count(1)


def cdp_evaluate(websocket_url: str, expression: str, timeout_seconds: int = 10):
    ws = create_connection(websocket_url, timeout=timeout_seconds)
    try:
        msg_id = next(_cdp_counter)
        ws.send(json.dumps({
            "id": msg_id,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            },
        }))

        while True:
            raw = ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == msg_id:
                if "exceptionDetails" in msg:
                    raise RuntimeError(msg["exceptionDetails"])
                return msg["result"]["result"].get("value")
    finally:
        ws.close()

def _http_json(url: str, method: str = "GET") -> dict:
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _walk_bookmarks(node: dict):
    if node.get("type") == "url":
        yield node.get("name"), node.get("url")

    for child in node.get("children", []):
        yield from _walk_bookmarks(child)


def find_bookmark_url(bookmark_name: str, profile_root: str = "/chrome-profile") -> str:
    profile = Path(profile_root)

    candidates = [
        profile / "Default" / "Bookmarks",
        profile / "Profile 1" / "Bookmarks",
        profile / "Bookmarks",
    ]

    for path in candidates:
        if not path.exists():
            continue

        data = json.loads(path.read_text(encoding="utf-8"))
        for root in data.get("roots", {}).values():
            for name, url in _walk_bookmarks(root):
                if name == bookmark_name and url:
                    return url

    raise ValueError(f'Bookmark not found: "{bookmark_name}"')


def open_new_tab(url: str, chrome_debug_url: str) -> dict:
    encoded = urllib.parse.quote(url, safe="")
    endpoint = f"{chrome_debug_url.rstrip('/')}/json/new?{encoded}"
    return _http_json(endpoint, method="PUT")


def wait_for_target_loaded(
    target_id: str,
    chrome_debug_url: str,
    timeout_seconds: int = 30,
) -> dict:
    deadline = time.time() + timeout_seconds
    targets_url = f"{chrome_debug_url.rstrip('/')}/json"

    last_target = None

    while time.time() < deadline:
        targets = _http_json(targets_url)
        for target in targets:
            if target.get("id") == target_id:
                last_target = target
                url = target.get("url") or ""
                title = target.get("title") or ""

                if (
                    url
                    and not url.startswith("chrome://")
                    and title
                    and title != "about:blank"
                ):
                    return target

        time.sleep(0.5)

    raise TimeoutError(f"Chrome target did not appear loaded in {timeout_seconds}s: {last_target}")
    