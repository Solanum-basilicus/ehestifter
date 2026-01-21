# helpers/blob_storage.py
import os
import json
from typing import Any, Optional


def _get_blob_service_client(container: str):
    # Import lazily so function indexing doesn't die if packages are missing
    from azure.identity import DefaultAzureCredential
    from azure.storage.blob import BlobServiceClient

    if container is "enrichments":
        account_url = os.getenv("ENRICHMENTS_STORAGE_blobServiceUri")
        if not account_url:
            raise Exception("Missing ENRICHMENTS_STORAGE_blobServiceUri while initiating connection to blob storage")
        # For user-assigned managed identity: DefaultAzureCredential uses AZURE_CLIENT_ID
        client_id = os.getenv("ENRICHMENTS_STORAGE__clientId")
        if client_id:
            os.environ["AZURE_CLIENT_ID"] = client_id
    elif container is "cvblobs":
        account_url = os.getenv("CV_STORAGE__blobServiceUri")
        if not account_url:
            raise Exception("Missing CV_STORAGE__blobServiceUri while initiating connection to blob storage")
        # For user-assigned managed identity: DefaultAzureCredential uses AZURE_CLIENT_ID
        client_id = os.getenv("CV_STORAGE__clientId")
        if client_id:
            os.environ["AZURE_CLIENT_ID"] = client_id
    else:
        raise Exception("Trying to setup connection to unknown or unset blob storage container")

    credential = DefaultAzureCredential()
    return BlobServiceClient(account_url=account_url, credential=credential)


def _get_container_name(container: str) -> str:
    if container is "enrichments":
        return os.getenv("ENRICHMENTS_STORAGE_containerName", "enrichments")
    elif container is "cvblobs":
        return os.getenv("CV_STORAGE_containerName", "cvblobs")
    else:
        return False


def _get_blob_client(blob_path: str):
    bsc = _get_blob_service_client()
    return bsc.get_blob_client(container=_get_container_name(), blob=blob_path)


def upload_json(blob_path: str, content: str, *, overwrite: bool = True) -> None:
    from azure.storage.blob import ContentSettings

    bc = _get_blob_client(blob_path)
    bc.upload_blob(
        content.encode("utf-8"),
        overwrite=overwrite,
        content_settings=ContentSettings(content_type="application/json; charset=utf-8"),
    )


def blob_exists(blob_path: str) -> bool:
    from azure.core.exceptions import ResourceNotFoundError

    bc = _get_blob_client(blob_path)
    try:
        bc.get_blob_properties()
        return True
    except ResourceNotFoundError:
        return False


def download_bytes(blob_path: str) -> Optional[bytes]:
    """
    Returns blob bytes or None if missing.
    """
    from azure.core.exceptions import ResourceNotFoundError

    bc = _get_blob_client(blob_path)
    try:
        return bc.download_blob().readall()
    except ResourceNotFoundError:
        return None


def download_text(blob_path: str, *, encoding: str = "utf-8") -> Optional[str]:
    data = download_bytes(blob_path)
    if data is None:
        return None
    return data.decode(encoding)


def download_json(blob_path: str) -> Optional[Any]:
    txt = download_text(blob_path)
    if txt is None:
        return None
    return json.loads(txt)
