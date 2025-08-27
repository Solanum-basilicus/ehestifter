def get_b2c_headers(req):
    """
    Returns tuple (b2c_object_id, email, username)
    """
    b2c_object_id = req.headers.get("x-user-sub")
    email = req.headers.get("x-user-email", None)
    username = req.headers.get("x-user-name", None)
    return b2c_object_id, email, username