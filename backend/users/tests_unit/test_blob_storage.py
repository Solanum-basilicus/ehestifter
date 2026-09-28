import sys
import types
from pathlib import Path

USERS_ROOT = Path(__file__).resolve().parents[1]
if str(USERS_ROOT) not in sys.path:
    sys.path.insert(0, str(USERS_ROOT))

from helpers import blob_storage


class ResourceNotFoundError(Exception):
    pass


class FakeDownload:
    def __init__(self, value):
        self.value = value

    def readall(self):
        return self.value


class FakeBlobClient:
    def __init__(self, value):
        self.value = value

    def download_blob(self):
        if isinstance(self.value, Exception):
            raise self.value
        return FakeDownload(self.value)


class FakeContainerClient:
    def __init__(self, values):
        self.values = values
        self.requested = []

    def get_blob_client(self, path):
        self.requested.append(path)
        return FakeBlobClient(self.values[path])


class FakeServiceClient:
    def __init__(self, container):
        self.container = container
        self.container_names = []

    def get_container_client(self, name):
        self.container_names.append(name)
        return self.container


def test_download_texts_reuses_one_service_client_and_deduplicates_paths(monkeypatch):
    exceptions_module = types.ModuleType("azure.core.exceptions")
    exceptions_module.ResourceNotFoundError = ResourceNotFoundError
    core_module = types.ModuleType("azure.core")
    azure_module = types.ModuleType("azure")
    monkeypatch.setitem(sys.modules, "azure", azure_module)
    monkeypatch.setitem(sys.modules, "azure.core", core_module)
    monkeypatch.setitem(sys.modules, "azure.core.exceptions", exceptions_module)

    container = FakeContainerClient({
        "a.txt": b"alpha",
        "b.txt": ResourceNotFoundError(),
    })
    service = FakeServiceClient(container)
    calls = []

    def get_service():
        calls.append(True)
        return service

    monkeypatch.setattr(blob_storage, "_get_blob_service_client", get_service)
    monkeypatch.setattr(blob_storage, "_get_container_name", lambda: "cvblobs")

    result = blob_storage.download_texts(["a.txt", "a.txt", "b.txt"])

    assert result == {"a.txt": "alpha", "b.txt": None}
    assert calls == [True]
    assert service.container_names == ["cvblobs"]
    assert container.requested == ["a.txt", "b.txt"]
