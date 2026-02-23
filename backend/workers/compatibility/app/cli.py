# app/cli.py
import argparse
import json
from .stats import load_stats

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["stats"])
    args = ap.parse_args()

    if args.cmd == "stats":
        print(json.dumps(load_stats(), indent=2))

if __name__ == "__main__":
    main()