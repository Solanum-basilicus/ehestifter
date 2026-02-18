from .gateway_dispatch_post import register as _reg_dispatch
from .work_lease_post import register as _reg_lease
from .work_complete_post import register as _reg_complete

def register_all(app):
    _reg_dispatch(app)
    _reg_lease(app)
    _reg_complete(app)
