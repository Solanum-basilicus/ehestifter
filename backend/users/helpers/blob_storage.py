# helpers/blob_storage.py
import os
import json
from typing import Any, Optional

from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContentSettings
from azure.core.exceptions import ResourceNotFoundError


_CV_CONTAINER = os.getenv("CV_CONTAINER_NAME", "cvblobs")


#def _get_blob_service_client() -> BlobServiceClient:
#    account_url = os.getenv("AzureWebJobsStorage__blobServiceUri")
#    if not account_url:
#        raise Exception("Missing AzureWebJobsStorage__blobServiceUri")
#
#    # For user-assigned managed identity: DefaultAzureCredential uses AZURE_CLIENT_ID.
#    client_id = os.getenv("AzureWebJobsStorage__clientId")
#    if client_id:
#        os.environ["AZURE_CLIENT_ID"] = client_id
#
#    credential = DefaultAzureCredential()
#    return BlobServiceClient(account_url=account_url, credential=credential)


def _get_blob_client(blob_path: str):
    bsc = _get_blob_service_client()
    return bsc.get_blob_client(container=_CV_CONTAINER, blob=blob_path)


def blob_exists(blob_path: str) -> bool:
    bc = _get_blob_client(blob_path)
    try:
        bc.get_blob_properties()
        return True
    except ResourceNotFoundError:
        return False


def upload_text(blob_path: str, content: str, *, overwrite: bool = True) -> None:
    bc = _get_blob_client(blob_path)
    bc.upload_blob(
        content.encode("utf-8"),
        overwrite=overwrite,
        content_settings=ContentSettings(content_type="text/plain; charset=utf-8"),
    )


def upload_json(blob_path: str, content: str, *, overwrite: bool = True) -> None:
    bc = _get_blob_client(blob_path)
    bc.upload_blob(
        content.encode("utf-8"),
        overwrite=overwrite,
        content_settings=ContentSettings(content_type="application/json; charset=utf-8"),
    )


def download_bytes(blob_path: str) -> Optional[bytes]:
    """
    Returns bytes if blob exists, else None.
    """
    bc = _get_blob_client(blob_path)
    try:
        stream = bc.download_blob()
        return stream.readall()
    except ResourceNotFoundError:
        return None


def download_text(blob_path: str, *, encoding: str = "utf-8") -> Optional[str]:
    """
    Returns decoded text if blob exists, else None.
    """
    data = download_bytes(blob_path)
    if data is None:
        return None
    return data.decode(encoding)


def download_json(blob_path: str) -> Optional[Any]:
    """
    Returns parsed JSON if blob exists, else None.
    """
    txt = download_text(blob_path)
    if txt is None:
        return None
    return json.loads(txt)
