import logging
import azure.functions as func
from domain.outbox_publisher import OutboxPublisher

def register(app: func.FunctionApp):
    @app.function_name("PublishEnrichmentOutbox")
    @app.schedule(schedule="0 */1 * * * *", arg_name="timer")  # every minute
    def publish(timer: func.TimerRequest) -> None:
        pub = OutboxPublisher()
        n = pub.publish_batch(max_items=20)
        logging.info("Outbox published: %s", n)
