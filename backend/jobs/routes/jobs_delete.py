import logging
import azure.functions as func
from db import get_connection
from auth import detect_actor
from history import insert_history

def register(app: func.FunctionApp):

    @app.route(route="jobs/{id}", methods=["DELETE"])
    def delete_job(req: func.HttpRequest) -> func.HttpResponse:
        job_id = req.route_params.get("id")
        logging.info(f"DELETE /jobs/{job_id}")
        conn = None
        try:
            conn = get_connection()
            cur = conn.cursor()
            actor_type, actor_id = detect_actor(req)

            cur.execute("UPDATE dbo.JobOfferings SET IsDeleted = 1, UpdatedAt = SYSDATETIME() WHERE Id = ?", job_id)
            if cur.rowcount == 0:
                conn.rollback()
                return func.HttpResponse("No job found or already deleted", status_code=404)
            if cur.rowcount > 1:
                conn.rollback()
                logging.error("DELETE /jobs affected >1 row")
                return func.HttpResponse("Error: multiple jobs affected", status_code=500)

            insert_history(cur, job_id, "job_deleted", {"softDelete": True}, actor_type, actor_id)
            conn.commit()
            return func.HttpResponse("Job marked as deleted", status_code=200)

        except Exception as e:
            logging.exception("DELETE /jobs error")
            try:
                if conn: conn.rollback()
            except Exception:
                pass
            return func.HttpResponse(f"Error: {str(e)}", status_code=500)
