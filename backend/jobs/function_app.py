from time import perf_counter

# Start the timer before imports owned by this application.
_startup_started = perf_counter()

import azure.functions as func
import logging
_startup_azure_done = perf_counter()

from routes import register_all
from helpers.timing import TimedRoutes, configure_startup, timed_handler
_startup_routes_done = perf_counter()

app = func.FunctionApp()

@app.route(route="ping", methods=["GET"])
@timed_handler
def ping(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("ping processed a request.")
    return func.HttpResponse("pong", status_code=200)

# Register all routes from the routes/ package
register_all(TimedRoutes(app))

# Module import and registration end here. The host starts before this timer.
_startup_registered = perf_counter()
configure_startup(
    azure_ms=(_startup_azure_done - _startup_started) * 1000,
    routes_ms=(_startup_routes_done - _startup_azure_done) * 1000,
    register_ms=(_startup_registered - _startup_routes_done) * 1000,
)
