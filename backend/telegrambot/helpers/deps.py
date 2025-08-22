_api = None

def set_api(api):
    global _api
    _api = api

def get_api():
    if _api is None:
        raise RuntimeError("EhestifterApi not initialized")
    return _api
