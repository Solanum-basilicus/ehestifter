from __future__ import annotations

import logging

from flask import Flask, jsonify

from app.config import AppConfig
from app.routes.diagnostics import bp as diagnostics_bp
from app.routes.events import bp as events_bp


def create_app() -> Flask:
    app = Flask(__name__)

    logging.basicConfig(level=logging.INFO)

    config = AppConfig.from_env()
    config.validate_startup()
    app.config["APP_CONFIG"] = config

    app.register_blueprint(events_bp)
    app.register_blueprint(diagnostics_bp)

    @app.get("/ping")
    def ping():
        return jsonify({"status": "ok", "service": "analytics"})

    @app.post("/analytics/dispatch/run")
    def dispatch_run_not_implemented():
        return jsonify({"error": "not_implemented", "phase": "phase_2"}), 501

    return app
