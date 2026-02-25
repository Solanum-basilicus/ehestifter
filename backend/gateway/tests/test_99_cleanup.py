def test_99_cleanup(sb_helpers, shared_state):
    run_ids = shared_state.get("run_ids") or []
    drained = sb_helpers["drain_by_run_ids"](run_ids, wait_seconds=10, max_total=50)
    print(f"(CLEANUP: drained={drained} for run_ids={len(run_ids)})")