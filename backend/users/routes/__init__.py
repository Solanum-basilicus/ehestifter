from .by_telegram import register as _reg_by_telegram
from .filters import register as _reg_filters
from .preferences import register as _reg_preferences
from .telegram_link import register as _reg_telegram_link
from .users_me import register as _reg_users_me


def register_all(app):
    _reg_users_me(app)
    _reg_preferences(app)
    _reg_filters(app)    
    _reg_by_telegram(app)
    _reg_telegram_link(app)

