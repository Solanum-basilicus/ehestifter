# helpers/blob_storage.py
import os
import json
from typing import Any, Optional, Literal, Dict, Tuple

StorageName = Literal["enrichments", "cv"]

# In-process cache: (account_url, client_id) -> BlobServiceClient
_BSC_CACHE: Dict[Tuple[str, Optional[str]], Any] = {}


def _require_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise Exception(f"Missing environment variable: {name}")
    return v


def _storage_config(storage: StorageName) -> tuple[str, str, Optional[str]]:
    """
    Returns (account_url, container_name, client_id).
    Container name is REQUIRED via env vars (no defaults).
    """
    if storage == "enrichments":
        return (
            _require_env("ENRICHMENTS_STORAGE__blobServiceUri"),
            _require_env("ENRICHMENTS_STORAGE__containerName"),
            os.getenv("ENRICHMENTS_STORAGE__clientId"),
        )

    if storage == "cv":
        return (
            _require_env("CV_STORAGE__blobServiceUri"),
            _require_env("CV_STORAGE__containerName"),
            os.getenv("CV_STORAGE__clientId"),
        )

    raise Exception(f"Unknown storage profile: {storage}")


def _get_blob_service_client(account_url: str, client_id: Optional[str]):
    # Import lazily so function indexing doesn't die if packages are missing
    from azure.storage.blob import BlobServiceClient
    from azure.identity import ManagedIdentityCredential, DefaultAzureCredential

    cache_key = (account_url, client_id)
    cached = _BSC_CACHE.get(cache_key)
    if cached is not None:
        return cached

    credential = (
        ManagedIdentityCredential(client_id=client_id)
        if client_id
        else DefaultAzureCredential(exclude_managed_identity_credential=False)
    )

    bsc = BlobServiceClient(account_url=account_url, credential=credential)
    _BSC_CACHE[cache_key] = bsc
    return bsc


def _get_blob_client(storage: StorageName, blob_path: str):
    account_url, container, client_id = _storage_config(storage)
    bsc = _get_blob_service_client(account_url, client_id)
    return bsc.get_blob_client(container=container, blob=blob_path)


def upload_json(storage: StorageName, blob_path: str, content: Any, *, overwrite: bool = True) -> None:
    from azure.storage.blob import ContentSettings

    bc = _get_blob_client(storage, blob_path)
    data = json.dumps(content, ensure_ascii=False).encode("utf-8")
    bc.upload_blob(
        data,
        overwrite=overwrite,
        content_settings=ContentSettings(content_type="application/json; charset=utf-8"),
    )


def upload_bytes(
    storage: StorageName,
    blob_path: str,
    data: bytes,
    *,
    content_type: str = "application/octet-stream",
    overwrite: bool = True,
) -> None:
    from azure.storage.blob import ContentSettings

    bc = _get_blob_client(storage, blob_path)
    bc.upload_blob(
        data,
        overwrite=overwrite,
        content_settings=ContentSettings(content_type=content_type),
    )


def blob_exists(storage: StorageName, blob_path: str) -> bool:
    from azure.core.exceptions import ResourceNotFoundError

    bc = _get_blob_client(storage, blob_path)
    try:
        bc.get_blob_properties()
        return True
    except ResourceNotFoundError:
        return False


def download_bytes(storage: StorageName, blob_path: str) -> Optional[bytes]:
    from azure.core.exceptions import ResourceNotFoundError

    bc = _get_blob_client(storage, blob_path)
    try:
        return bc.download_blob().readall()
    except ResourceNotFoundError:
        return None


def download_text(storage: StorageName, blob_path: str, *, encoding: str = "utf-8") -> Optional[str]:
    data = download_bytes(storage, blob_path)
    return None if data is None else data.decode(encoding)


def download_json(storage: StorageName, blob_path: str) -> Optional[Any]:
    txt = download_text(storage, blob_path)
    return None if txt is None else json.loads(txt)


# Convenience wrappers

def enrichments_upload_json(blob_path: str, content: Any, *, overwrite: bool = True) -> None:
    upload_json("enrichments", blob_path, content, overwrite=overwrite)


def enrichments_download_json(blob_path: str) -> Optional[Any]:
    return download_json("enrichments", blob_path)


def cv_download_text(blob_path: str, *, encoding: str = "utf-8") -> Optional[str]:
    return download_text("cv", blob_path, encoding=encoding)
