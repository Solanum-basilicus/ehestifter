import time, random, logging

def retry_until_ready(fn, *, attempts=4, base_delay=0.75):
    last_exc = None
    for i in range(1, attempts + 1):
        try:
            return fn()
        except Exception as e:
            last_exc = e
            sleep_s = base_delay * (2 ** (i - 1)) + random.uniform(0, 0.25)
            logging.warning("upstream attempt %s/%s failed: %s - sleeping %.2fs",
                            i, attempts, e, sleep_s)
            time.sleep(sleep_s)
    raise last_exc
