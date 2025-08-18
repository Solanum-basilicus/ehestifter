import azure.functions as func
import logging
from routes import register_all

app = func.FunctionApp()

@app.route(route="ping", methods=["GET"])
def ping(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("ping processed a request.")
    return func.HttpResponse("pong", status_code=200)

# Register all routes from the routes/ package
register_all(app)
