"""Check Gateway stage collection in the active request context."""

from helpers.timing import begin, end, step


def test_gateway_measures_servicebus_and_clears_context():
    token, measure, started = begin()
    try:
        with step("servicebus_dispatch"):
            with step("servicebus_client"):
                with step("servicebus_send"):
                    pass
        header = measure.header(120)
        assert "app;dur=120.00" in header
        assert "step_servicebus_dispatch;dur=" in header
        assert "step_servicebus_send;dur=" in header
        assert 'process_first;desc="' in header
    finally:
        end(token)


def test_gateway_steps_without_request_are_noop():
    with step("servicebus_sender"):
        pass
