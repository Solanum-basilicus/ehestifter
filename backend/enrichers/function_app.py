import azure.functions as func
import logging
from routes import register_all
from timers.cleanup_runs import main as cleanup_runs_main

app = func.FunctionApp()

@app.route(route="ping", methods=["GET"])
def ping(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("enrichers ping")
    return func.HttpResponse("pong", status_code=200)

register_all(app)

@app.function_name(name="cleanup_runs")
@app.schedule(schedule="0 0 18 * * *", arg_name="mytimer", run_on_startup=False, use_monitor=False)
def cleanup_runs(mytimer: func.TimerRequest) -> None:
    cleanup_runs_main(mytimer)
    # it was not tested on creation. If you see a lot of old queued runs in DB - will have to get back to it.

@app.function_name(name="dispatch_projections")
@app.schedule(schedule="0 */2 * * * *", arg_name="mytimer", run_on_startup=False, use_monitor=False)
def dispatch_projections(mytimer: func.TimerRequest) -> None:
    dispatch_projections_main(mytimer)    
    