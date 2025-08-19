# routes/__init__.py
from .ui_jobs_list import create_blueprint as bp_jobs_list
from .ui_jobs_get import create_blueprint as bp_jobs_get
from .ui_jobs_create import create_blueprint as bp_jobs_create
from .ui_job_status_get import create_blueprint as bp_job_status_get
from .ui_job_status_set import create_blueprint as bp_job_status_set
from .ui_job_history_get import create_blueprint as bp_job_history_get
from .ui_jobs_status_bulk import create_blueprint as bp_jobs_status_bulk
from .ui_users_me import create_blueprint as bp_users_me

def register_all(app, auth):
    app.register_blueprint(bp_jobs_list(auth))
    app.register_blueprint(bp_jobs_get(auth))
    app.register_blueprint(bp_jobs_create(auth))
    app.register_blueprint(bp_job_status_get(auth))
    app.register_blueprint(bp_job_status_set(auth))
    app.register_blueprint(bp_job_history_get(auth))
    app.register_blueprint(bp_jobs_status_bulk(auth))
    app.register_blueprint(bp_users_me(auth))