from .enrichment_runs_post import register as _reg_runs_post
from .enrichment_latest_get import register as _reg_latest_get
from .enrichment_history_get import register as _reg_history_get
from .enrichment_run_complete_post import register as _reg_complete_post
from .internal_enrichment_run_get import register as _reg_internal_run_get
from .internal_latest_id_get import register as _reg_internal_latest_id_get
from .internal_lease_post import register as _reg_internal_lease_post
from .internal_input_get import register as _reg_internal_input_get
from .enrichment_runs_get import register as _reg_runs_get
from .enrichment_runs_queued_post import register as _reg_run_queue
from .internal_projection_dispatches_get import register as _reg_projection_dispatches_get

def register_all(app):
    _reg_runs_post(app)
    _reg_latest_get(app)
    _reg_history_get(app)
    _reg_complete_post(app)
    _reg_internal_run_get(app)
    _reg_internal_latest_id_get(app)
    _reg_internal_lease_post(app)
    _reg_internal_input_get(app)
    _reg_runs_get(app)
    _reg_run_queue(app)
    _reg_projection_dispatches_get(app)
