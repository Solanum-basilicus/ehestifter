def test_99_cleanup_best_effort(sb_helpers):
    drained = sb_helpers["drain_messages"](max_total=50, wait_seconds=10)
    print(f"(CLEANUP drained={drained})", end="")
    assert True
