# routes/__init__.py
from .jobs_create import register as _reg_create
from .jobs_list import register as _reg_list
from .jobs_get import register as _reg_get
from .jobs_update import register as _reg_update
from .jobs_delete import register as _reg_delete
from .job_status_put import register as _reg_status_put
from .job_status_bulk import register as _reg_status_bulk
from .job_history_post import register as _reg_history_post
from .job_history_get import register as _reg_history_get
from .job_list_with_statuses import register as _reg_list_with_statuses
from .apply_by_url import register as _register_apply_by_url

def register_all(app):
    _reg_create(app)
    _reg_list(app)
    _reg_list_with_statuses(app)
    _reg_get(app)
    _reg_update(app)
    _reg_delete(app)
    _reg_status_put(app)
    _reg_status_bulk(app)
    _reg_history_post(app)
    _reg_history_get(app)
    _register_apply_by_url(app)
