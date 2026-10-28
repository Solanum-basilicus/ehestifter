import azure.functions as func
from routes import register_all
from helpers.timing import TimedRoutes


app = func.FunctionApp()

# Register all routes from the routes/ package
register_all(TimedRoutes(app))
