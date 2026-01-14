# helpers/blob_storage.py
import os
import json
from typing import Any, Optional

def _get_blob_service_client():
    # Import lazily so function indexing doesn't die if packages are missing
    from azure.identity import DefaultAzureCredential
    from azure.storage.blob import BlobServiceClient

    account_url = os.getenv("AzureWebJobsStorage__blobServiceUri")
    if not account_url:
        raise Exception("Missing AzureWebJobsStorage__blobServiceUri")

    client_id = os.getenv("AzureWebJobsStorage__clientId")
    if client_id:
        os.environ["AZURE_CLIENT_ID"] = client_id

    credential = DefaultAzureCredential()
    return BlobServiceClient(account_url=account_url, credential=credential)

def _get_blob_client(container: str, blob_path: str):
    bsc = _get_blob_service_client()
    return bsc.get_blob_client(container=container, blob=blob_path)

# ... keep the rest of your upload/download helpers, but import
# ContentSettings / ResourceNotFoundError lazily too:

def upload_text(blob_path: str, content: str, *, overwrite: bool = True) -> None:
    from azure.storage.blob import ContentSettings
    container = os.getenv("CV_CONTAINER_NAME", "cv")
    bc = _get_blob_client(container, blob_path)
    bc.upload_blob(
        content.encode("utf-8"),
        overwrite=overwrite,
        content_settings=ContentSettings(content_type="text/plain; charset=utf-8"),
    )

def upload_json(blob_path: str, content: str, *, overwrite: bool = True) -> None:
    from azure.storage.blob import ContentSettings
    container = os.getenv("CV_CONTAINER_NAME", "cvblobs")
    bc = _get_blob_client(container, blob_path)
    bc.upload_blob(
        content.encode("utf-8"),
        overwrite=overwrite,
        content_settings=ContentSettings(content_type="application/json; charset=utf-8"),
    )
