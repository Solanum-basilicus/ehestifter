import os


_LOCAL_SESSION_FILE_DIR = "flask_session"
_AZURE_SESSION_FILE_DIR = "/home/data/ehestifter-core-sessions"


def _get_session_file_dir():
    configured_dir = os.getenv("SESSION_FILE_DIR")
    if configured_dir:
        return configured_dir

    if os.getenv("WEBSITE_SITE_NAME"):
        return _AZURE_SESSION_FILE_DIR

    return _LOCAL_SESSION_FILE_DIR


# Store server-side Flask sessions in files.
SESSION_TYPE = "filesystem"
# Azure App Service persists files under /home. Keep the current local default
# outside App Service, and allow an explicit path override on any host.
SESSION_FILE_DIR = _get_session_file_dir()
