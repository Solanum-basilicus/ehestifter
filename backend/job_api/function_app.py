import azure.functions as func
import datetime
import json
import logging
from . import post_job, list_jobs, get_job, update_job, delete_job

app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)

@app.route(route="jobs", methods=["POST"])
async def handle_post_job(req: func.HttpRequest) -> func.HttpResponse:
    return await post_job.post_job(req)

@app.route(route="jobs", methods=["GET"])
async def handle_list_jobs(req: func.HttpRequest) -> func.HttpResponse:
    return await list_jobs.list_jobs(req)

@app.route(route="jobs/{id}", methods=["GET"])
async def handle_get_job(req: func.HttpRequest) -> func.HttpResponse:
    return await get_job.get_job(req)

@app.route(route="jobs/{id}", methods=["PUT"])
async def handle_update_job(req: func.HttpRequest) -> func.HttpResponse:
    return await update_job.update_job(req)

@app.route(route="jobs/{id}", methods=["DELETE"])
async def handle_delete_job(req: func.HttpRequest) -> func.HttpResponse:
    return await delete_job.delete_job(req)

@app.route(route="pharaoh", auth_level=func.AuthLevel.FUNCTION)
def post_job(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request.')

    name = req.params.get('name')
    if not name:
        try:
            req_body = req.get_json()
        except ValueError:
            pass
        else:
            name = req_body.get('name')

    if name:
        return func.HttpResponse(f"Hello, {name}. This HTTP triggered function executed successfully.")
    else:
        return func.HttpResponse(
             "This HTTP triggered function executed successfully. Pass a name in the query string or in the request body for a personalized response.",
             status_code=200
        )
