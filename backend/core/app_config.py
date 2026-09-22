import os


_LOCAL_SESSION_FILE_DIR = "flask_session_v2"
_AZURE_SESSION_FILE_DIR = "/home/data/ehestifter-core-sessions-v2"


def _get_session_file_dir():
    configured_dir = os.getenv("SESSION_FILE_DIR")
    if configured_dir:
        return configured_dir

    if os.getenv("WEBSITE_SITE_NAME"):
        return _AZURE_SESSION_FILE_DIR

    return _LOCAL_SESSION_FILE_DIR


# Flask-Session uses the CacheLib session interface. app.py supplies the
# encrypted filesystem cache before Microsoft identity initializes sessions.
SESSION_TYPE = "cachelib"
SESSION_FILE_DIR = _get_session_file_dir()
