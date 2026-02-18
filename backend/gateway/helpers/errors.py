class CoreHttpError(Exception):
    def __init__(self, status_code: int, body: str | None = None):
        super().__init__(f"Core HTTP {status_code}")
        self.status_code = status_code
        self.body = body
