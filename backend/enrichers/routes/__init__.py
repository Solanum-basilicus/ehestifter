from .enrichment_runs_post import register as _reg_runs_post
from .enrichment_latest_get import register as _reg_latest_get
from .enrichment_history_get import register as _reg_history_get
#from .enrichment_run_get import register as _reg_run_get
from .enrichment_run_complete_post import register as _reg_complete_post
#from .outbox_publish_timer import register as _reg_outbox_timer  # timer trigger

def register_all(app):
    _reg_runs_post(app)
    _reg_latest_get(app)
    _reg_history_get(app)
#    _reg_run_get(app)
    _reg_complete_post(app)
#    _reg_outbox_timer(app)
