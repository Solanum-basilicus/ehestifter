import azure.functions as func
import logging
from routes import register_all

# Reduce noise from Azure SDKs
logging.getLogger("azure").setLevel(logging.WARNING)
logging.getLogger("uamqp").setLevel(logging.WARNING)
logging.getLogger("azure.servicebus").setLevel(logging.WARNING)

app = func.FunctionApp()

@app.route(route="ping", methods=["GET"])
def ping(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("gateway ping processed a request.")
    return func.HttpResponse("pong", status_code=200)

register_all(app)
