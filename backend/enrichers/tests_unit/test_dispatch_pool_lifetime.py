"""Keep projection SQL leases away from slow Jobs HTTP requests."""

from types import SimpleNamespace

from timers import dispatch_projections as timer


class FakeConnection:
    def __init__(self, name, released):
        self.name = name
        self.released = released
        self.autocommit = False
        self.commits = 0
        self.rollbacks = 0
        self.closes = 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closes += 1
        self.released.append(self.name)


class FakeCursor:
    def __init__(self, connection):
        self.connection = connection

    def execute(self, *_args):
        return self

    def fetchone(self):
        return (0,)


def test_selection_connection_is_closed_before_any_http_call(monkeypatch):
    released = []
    opened = []

    def get_connection():
        conn = FakeConnection(len(opened), released)
        opened.append(conn)
        return conn

    row = SimpleNamespace(DispatchId="dispatch-1", AttemptCount=0)
    monkeypatch.setattr(timer, "get_connection", get_connection)
    monkeypatch.setattr(timer, "_select_due_dispatches", lambda *_args: [row])

    def deliver(_row, _max_attempts):
        assert released == [0], "selection SQL lease must be released first"
        assert len(opened) == 1
        return ("delivered", None)

    monkeypatch.setattr(timer, "_deliver_one", deliver)
    monkeypatch.setattr(timer, "_mark_delivered", lambda *_args: None)
    timer.main(SimpleNamespace(past_due=False))
    assert released == [0, 1]
    assert opened[0].commits == 1
    assert opened[1].commits == 1


def test_dispatch_failure_is_redacted_before_writing_sql(monkeypatch, caplog):
    row = SimpleNamespace(TargetDomain="jobs", ProjectionType="job-list.compatibility-score.v1",
                          AttemptCount=0, PayloadJson="private CV")
    class Response:
        status_code = 503
        text = "private candidate data and credentials"
    monkeypatch.setattr(timer, "_post_jobs_projection", lambda *_args: Response())
    status, reason = timer._deliver_one(row, 3)
    assert (status, reason) == ("retry", "jobs_http_503")
    assert "private" not in caplog.text


def test_failed_sql_selection_releases_connection(monkeypatch):
    opened = []
    conn = FakeConnection(0, [])
    opened.append(conn)
    monkeypatch.setattr(timer, "get_connection", lambda: conn)

    def fail(*_args):
        raise RuntimeError("internal detail")

    monkeypatch.setattr(timer, "_select_due_dispatches", fail)
    import pytest
    with pytest.raises(RuntimeError, match="internal detail"):
        timer._select_locked_batch(timer._utcnow(), 1)
    assert conn.rollbacks == 1
    assert conn.closes == 1
